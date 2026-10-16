import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClaudeRuntime } from '@cc-desk/engine-claude';
import { findClaudeTranscript, historyCacheStats } from '@cc-desk/engine-claude/history';
import { readTranscriptPreview, transcriptPreviewStats } from '@cc-desk/engine-claude/chat-import';
import { TranscriptHydrator } from '../dist/transcript-hydrator.js';

const emptyPage = () => ({ messages: [], before: null, after: null, incomplete: false });
const record = (sessionId, cwd, uuid, text = uuid) => JSON.stringify({ type: 'user', sessionId, cwd, uuid, timestamp: '2026-10-16T00:00:00Z', message: { content: text } }) + '\n';

function runtimeFixture(readDisplay) {
  const id = randomUUID();
  const session = { id, kind: 'agent', execution: { providerId: 'claude', mode: 'structured', conversationId: randomUUID(), imported: true }, cwd: process.cwd(), started: true };
  let historicalReads = 0, writes = 0;
  const forbidden = () => { historicalReads++; throw new Error('display must not load the execution projection'); };
  const runtime = new ClaudeRuntime({
    sessions: { get: key => key === id ? session : undefined, update() { writes++; } },
    conversations: () => ({ history: { get: forbidden, getMessage: forbidden, upsertMessage: forbidden, append: forbidden, changed: forbidden, flush: forbidden, delete: forbidden, exportPath: forbidden }, archive: { ...(readDisplay ? { readDisplay } : {}), page: forbidden, search: forbidden, forget() {} } }),
    subtasks: () => ({ begin() {}, observe() {}, end() {} }),
    launch: { environment: forbidden, invocation: forbidden }, maxSessions: () => 1,
    signalProcessGroup: async () => {}, onState() {}, onConversation() {}, onAcceptedPrompt() {},
  });
  runtime.hydrate = async () => { throw new Error('display must not wait for transcript hydration'); };
  return { runtime, id, session, counts: () => ({ historicalReads, writes }) };
}

test('display delegates only to the read-only host port and preserves paging options', async () => {
  const page = { ...emptyPage(), messages: [{ id: 'saved', turnId: '', role: 'user', text: 'saved local text', createdAt: '' }] };
  const calls = []; const f = runtimeFixture(async (...args) => { calls.push(args); return page; });
  const options = { before: 'saved-anchor' };
  assert.equal(await f.runtime.readDisplay(f.id, options), page);
  assert.deepEqual(calls, [[f.id, options]]);
  assert.deepEqual(f.counts(), { historicalReads: 0, writes: 0 });
  f.session.execution.providerId = 'other';
  await assert.rejects(f.runtime.readDisplay(f.id), /只支持.*Claude/);
  assert.equal(calls.length, 1);
});

test('an older host without a display port reports unavailable history without replaying it', async () => {
  const f = runtimeFixture();
  assert.deepEqual(await f.runtime.readDisplay(f.id), { ...emptyPage(), incomplete: true });
  assert.deepEqual(f.counts(), { historicalReads: 0, writes: 0 });
});

async function sourceFixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-display-loading-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = directory;
  const cwd = path.join(directory, 'project'); await fs.mkdir(cwd);
  try { await run({ directory, cwd }); }
  finally { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; await fs.rm(directory, { recursive: true, force: true }); }
}

test('cold direct lookup avoids directory scans and full metadata parsing; unchanged hydration reads no transcript bytes', async () => {
  await sourceFixture(async ({ directory, cwd }) => {
    const id = randomUUID(); const folder = path.join(directory, 'projects', path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
    await fs.mkdir(folder, { recursive: true }); const file = path.join(folder, id + '.jsonl');
    await fs.writeFile(file, Array.from({ length: 180 }, (_, i) => record(id, cwd, 'message-' + i, String(i) + ':' + 'x'.repeat(32 * 1024))).join(''));
    assert.ok((await fs.stat(file)).size > 5 * 1024 * 1024);
    const session = { id: 'local', cwd, started: true, execution: { conversationId: id, imported: true } };
    const snapshot = { sessionId: 'local', taskState: 'idle', messages: [], pending: [] };
    let flushes = 0;
    const hydrator = new TranscriptHydrator({ get: () => session }, { get: () => snapshot, flush() { flushes++; } }, () => false, { message: (_id, message) => snapshot.messages.push(message), system() {} });
    const coldMetadata = historyCacheStats(), coldPreview = transcriptPreviewStats();
    await hydrator.hydrate('local');
    const loaded = historyCacheStats(), preview = transcriptPreviewStats();
    assert.equal(loaded.directoryScans - coldMetadata.directoryScans, 0);
    assert.equal(loaded.parsedFiles - coldMetadata.parsedFiles, 0, 'source discovery must not index the full transcript for title metadata');
    assert.equal(loaded.sourceMetadataFiles - coldMetadata.sourceMetadataFiles, 1);
    assert.equal(preview.reads - coldPreview.reads, 1);
    assert.equal(preview.bytesRead - coldPreview.bytesRead, 2 * 1024 * 1024);
    assert.equal(snapshot.messages.at(-1)?.sourceId, 'message-179');
    assert.equal(snapshot.sourceIncomplete, true);
    const count = snapshot.messages.length;
    await hydrator.hydrate('local');
    assert.deepEqual(transcriptPreviewStats(), preview, 'unchanged source must not be read or parsed again');
    assert.equal(historyCacheStats().sourceMetadataFiles, loaded.sourceMetadataFiles);
    assert.equal(historyCacheStats().directoryScans, loaded.directoryScans);
    assert.equal(snapshot.messages.length, count); assert.equal(flushes, 1);
    await fs.appendFile(file, record(id, cwd, 'message-180', 'new external suffix'));
    await hydrator.hydrate('local');
    assert.equal(snapshot.messages.at(-1)?.text, 'new external suffix');
    assert.equal(snapshot.messages.filter(message => message.sourceId === 'message-179').length, 1);
    assert.equal(historyCacheStats().directoryScans, loaded.directoryScans, 'a changed known path is revalidated without scanning other projects');
  });
});

test('legacy source folders are scanned once and source replacement must revalidate project and conversation', async () => {
  await sourceFixture(async ({ directory, cwd }) => {
    const id = randomUUID(); const folder = path.join(directory, 'projects', 'older-cli-layout');
    await fs.mkdir(folder, { recursive: true }); const file = path.join(folder, id + '.jsonl');
    await fs.writeFile(file, record(id, cwd, 'first'));
    const before = historyCacheStats();
    assert.equal(await findClaudeTranscript(cwd, id), file);
    const cold = historyCacheStats(); assert.equal(cold.directoryScans - before.directoryScans, 1);
    assert.equal(await findClaudeTranscript(cwd, id), file);
    assert.equal(historyCacheStats().directoryScans, cold.directoryScans);
    assert.equal(historyCacheStats().sourceMetadataFiles, cold.sourceMetadataFiles);
    const replacement = path.join(folder, 'replacement');
    await fs.writeFile(replacement, record(randomUUID(), cwd, 'wrong-conversation'));
    await fs.rename(replacement, file);
    assert.equal(await findClaudeTranscript(cwd, id), undefined);
    await fs.writeFile(file, record(id, path.join(directory, 'other-project'), 'wrong-cwd'));
    assert.equal(await findClaudeTranscript(cwd, id), undefined);
  });
});

test('fork imports accept only the explicitly retained parent and current source identities', async () => {
  await sourceFixture(async ({ directory, cwd }) => {
    const parent = randomUUID(), current = randomUUID(), stranger = randomUUID();
    const folder = path.join(directory, 'projects', 'forks'); await fs.mkdir(folder, { recursive: true });
    const file = path.join(folder, current + '.jsonl');
    await fs.writeFile(file, record(parent, cwd, 'inherited') + record(current, cwd, 'current'));
    assert.equal(await findClaudeTranscript(cwd, current), undefined);
    assert.equal(await findClaudeTranscript(cwd, current, [parent]), file);
    assert.equal(await findClaudeTranscript(cwd, current), undefined, 'a cached fork lookup cannot widen a later caller\'s allowed identities');
    assert.deepEqual((await readTranscriptPreview(file, [current, parent])).messages.map(message => message.sourceId), ['inherited', 'current']);
    await fs.appendFile(file, record(stranger, cwd, 'unrelated-private-text'));
    await assert.rejects(readTranscriptPreview(file, [current, parent]), /来源身份不匹配/);
    const snapshot = { sessionId: 'local', taskState: 'idle', messages: [], pending: [] };
    const hydrator = new TranscriptHydrator({ get: () => ({ cwd, started: true, execution: { conversationId: current, forkFrom: parent } }) }, { get: () => snapshot, flush() {} }, () => false, { message: (_id, message) => snapshot.messages.push(message), system() {} });
    await assert.rejects(hydrator.hydrate('local'), /来源身份不匹配/);
    assert.deepEqual(snapshot.messages, [], 'foreign suffix cannot partially contaminate the local projection');
  });
});

test('replacement after source validation cannot change project ownership before the first hydration stat', async t => {
  await sourceFixture(async ({ directory, cwd }) => {
    const id = randomUUID(), folder = path.join(directory, 'projects', 'source-race'); await fs.mkdir(folder, { recursive: true });
    const file = path.join(folder, id + '.jsonl'); await fs.writeFile(file, record(id, cwd, 'correct-source'));
    const snapshot = { sessionId: 'local', taskState: 'idle', messages: [], pending: [] };
    const session = { cwd, started: true, execution: { conversationId: id } };
    const hydrator = new TranscriptHydrator({ get: () => session }, { get: () => snapshot, flush() {} }, () => false, { message: (_id, message) => snapshot.messages.push(message), system() {} });
    const stat = fs.stat.bind(fs); let replaced = false;
    const intercepted = t.mock.method(fs, 'stat', async (target, ...args) => {
      if (target === file && !replaced) {
        replaced = true; const replacement = path.join(folder, 'replacement');
        await fs.writeFile(replacement, record(id, path.join(directory, 'other-project'), 'same-id-wrong-project'));
        await fs.rename(replacement, file);
      }
      return stat(target, ...args);
    });
    try { await hydrator.hydrate('local'); }
    finally { intercepted.mock.restore(); }
    assert.equal(replaced, true);
    assert.deepEqual(snapshot.messages, [], 'metadata validation must bind the exact version read by hydration');
    await hydrator.hydrate('local');
    assert.deepEqual(snapshot.messages, [], 'a later lookup also rejects the replacement project');
  });
});

for (const mutation of ['append', 'replace']) test(`a transcript ${mutation} during preview cannot partially merge and is retried as a new version`, async t => {
  await sourceFixture(async ({ directory, cwd }) => {
    const id = randomUUID(), folder = path.join(directory, 'projects', 'preview-race'); await fs.mkdir(folder, { recursive: true });
    const file = path.join(folder, id + '.jsonl'); await fs.writeFile(file, record(id, cwd, 'original', 'old source text'));
    const snapshot = { sessionId: 'local', taskState: 'idle', messages: [], pending: [] };
    const hydrator = new TranscriptHydrator({ get: () => ({ cwd, started: true, execution: { conversationId: id } }) }, { get: () => snapshot, flush() {} }, () => false, { message: (_id, message) => snapshot.messages.push(message), system() {} });
    const open = fs.open.bind(fs); let mutated = false;
    const intercepted = t.mock.method(fs, 'open', async (target, ...args) => {
      const handle = await open(target, ...args);
      if (target === file) {
        const read = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
          const result = await read(...readArgs);
          if (!mutated) {
            mutated = true;
            if (mutation === 'append') await fs.appendFile(file, record(id, cwd, 'suffix', 'complete new suffix'));
            else { const replacement = path.join(folder, 'replacement'); await fs.writeFile(replacement, record(id, cwd, 'replacement', 'replacement source text')); await fs.rename(replacement, file); }
          }
          return result;
        };
      }
      return handle;
    });
    try { await hydrator.hydrate('local'); }
    finally { intercepted.mock.restore(); }
    assert.equal(mutated, true); assert.deepEqual(snapshot.messages, [], 'an unstable preview must not produce partial local effects');
    await hydrator.hydrate('local');
    assert.deepEqual(snapshot.messages.map(message => message.text), mutation === 'append' ? ['old source text', 'complete new suffix'] : ['replacement source text']);
  });
});
