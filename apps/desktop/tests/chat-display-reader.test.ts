import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChatDisplayReader, displayPage, readDisplayPage, writeDisplaySidecar } from '../src/main/chat-display-reader';
import type { ChatMessage } from '../src/shared/chat';

const message = (index: number, text = `message ${index}`): ChatMessage => ({ id: `message-${index}`, turnId: 'run', role: 'user', text, createdAt: '', submissionId: `request-${index}` });
const record = (value: ChatMessage, conversationId?: string) => JSON.stringify({ type: 'message', message: value, ...(conversationId ? { conversationId } : {}) }) + '\n';
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-display-'));
  return { directory, file: path.join(directory, 'session.jsonl'), reader: new ChatDisplayReader(directory), dispose: () => fs.rm(directory, { recursive: true, force: true }) };
}

test('cold first display reads at most 4 MiB and returns an exact bounded tail without a writer or full journal replay', async () => {
  const f = await fixture();
  try {
    const prefix = JSON.stringify({ type: 'old-record', ignored: 'x'.repeat(6 * 1024 * 1024) }) + '\n';
    await fs.writeFile(f.file, prefix + Array.from({ length: 80 }, (_, index) => record(message(index))).join(''));
    await fs.writeFile(path.join(f.directory, '.writer-lock'), 'owned by execution');
    const first = await f.reader.page('session');
    assert.deepEqual(first.messages.map(item => item.id), Array.from({ length: 50 }, (_, index) => `message-${index + 30}`));
    assert.equal(first.before, 'message-30'); assert.equal(first.after, null);
    assert.equal(f.reader.statistics.journalBytesRead, 4 * 1024 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(first)) < 256 * 1024);
    assert.equal(await fs.readFile(path.join(f.directory, '.writer-lock'), 'utf8'), 'owned by execution');
    assert.deepEqual((await fs.readdir(f.directory)).sort(), ['.writer-lock', 'session.jsonl']);
    const second = await f.reader.page('session');
    assert.deepEqual(second, first); second.messages[0].text = 'caller mutation';
    assert.notEqual((await f.reader.page('session')).messages[0].text, 'caller mutation');
    assert.equal(f.reader.statistics.tailReads, 1); assert.equal(f.reader.statistics.cacheHits, 2);
    const older = await f.reader.page('session', { before: first.before! });
    assert.equal(older.messages.at(-1)?.id, 'message-29', 'explicit older pages remain reachable');
  } finally { await f.dispose(); }
});

test('the byte budget preserves a contiguous latest segment and exact identities for repeated text', () => {
  const messages = Array.from({ length: 50 }, (_, index) => message(index, '界'.repeat(20000)));
  const page = displayPage(messages);
  const first = Number(page.messages[0].id.slice('message-'.length));
  assert.deepEqual(page.messages.map(item => item.id), messages.slice(first).map(item => item.id));
  assert.equal(page.messages.at(-1)?.id, 'message-49');
  assert.ok(page.messages.length < 50); assert.ok(Buffer.byteLength(JSON.stringify(page)) < 256 * 1024);
  assert.equal(page.before, page.messages[0].id);
  assert.ok(page.messages.every(item => item.truncated));
});

test('tail replay reconciles updates and deltas while preserving different IDs and incomplete trailing bytes', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(f.file, record(message(1, '相同')) + record(message(2, '相同')) + record({ ...message(1), text: '更新' })
      + JSON.stringify({ type: 'text_delta', id: 'message-1', text: '追加🙂' }) + '\n{"type":');
    const page = await f.reader.page('session');
    assert.deepEqual(page.messages.map(item => [item.id, item.text]), [['message-1', '更新追加🙂'], ['message-2', '相同']]);
    assert.equal(page.incomplete, true);
    await fs.writeFile(f.file, record(message(3, '完整🙂')));
    assert.deepEqual((await f.reader.page('session')).messages.map(item => item.id), ['message-3']);
    assert.equal((await f.reader.page('session')).incomplete, false);
  } finally { await f.dispose(); }
});

test('source changes, replacement and conversation changes invalidate cached and persisted display pages', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(f.file, record(message(1), 'conversation-a'));
    const source = { conversationId: 'conversation-a', requireConversationMatch: true };
    const original = await f.reader.page('session', {}, source);
    await writeDisplaySidecar(f.directory, 'session', source.conversationId, original);
    const cold = new ChatDisplayReader(f.directory);
    assert.deepEqual(await cold.page('session', {}, source), original);
    assert.equal(cold.statistics.journalBytesRead, 0); assert.equal(cold.statistics.sidecarHits, 1);
    const mismatch = await cold.page('session', {}, { conversationId: 'conversation-b', requireConversationMatch: true });
    assert.deepEqual(mismatch.messages, []); assert.equal(mismatch.incomplete, true);
    await fs.appendFile(f.file, record(message(2), 'conversation-a'));
    assert.deepEqual((await cold.page('session', {}, source)).messages.map(item => item.id), ['message-1', 'message-2']);
    const stat = await fs.stat(f.file);
    const replacement = f.file + '.replacement';
    await fs.writeFile(replacement, record(message(4), 'conversation-a') + record(message(5), 'conversation-a'));
    await fs.utimes(replacement, stat.atime, stat.mtime); await fs.rename(replacement, f.file);
    assert.deepEqual((await cold.page('session', {}, source)).messages.map(item => item.id), ['message-4', 'message-5']);
    assert.deepEqual((await cold.page('session', { before: 'message-4' }, { conversationId: 'conversation-b', requireConversationMatch: true })).messages, [], 'old-page access also observes the source guard');
  } finally { await f.dispose(); }
});

test('Native legacy logs wait for authoritative source binding while generic legacy snapshots remain readable', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(f.file, record(message(1)));
    const strict = await f.reader.page('session', {}, { conversationId: 'current', requireConversationMatch: true });
    assert.deepEqual(strict.messages, []); assert.equal(strict.incomplete, true);
    await fs.rm(f.file);
    await fs.writeFile(path.join(f.directory, 'session.json'), JSON.stringify({ sessionId: 'session', messages: [message(2)], taskState: 'completed', pending: [] }));
    assert.deepEqual((await readDisplayPage(f.directory, 'session')).messages.map(item => item.id), ['message-2']);
    assert.deepEqual((await f.reader.page('session', {}, { conversationId: 'current', requireConversationMatch: true })).messages, [], 'unbound old snapshot is never attributed to a new Native context');
  } finally { await f.dispose(); }
});

test('invalid identifiers and symbolic display sources are rejected without creating files', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.reader.page('../session'), /无效会话/);
    if (process.platform !== 'win32') {
      await fs.writeFile(path.join(f.directory, 'target'), record(message(1)));
      await fs.symlink('target', f.file);
      await assert.rejects(f.reader.page('session'), /普通文件/);
    }
  } finally { await f.dispose(); }
});
