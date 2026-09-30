import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants, renameSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import crypto, { randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalJson } from '@cc-desk/agent-core';
import { NativeRunStore } from '../dist/run-store.js';

const protocol = { id: 'openai-responses', version: 1 };
const sha = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const request = conversationId => ({
  identity: { sessionId: 'session-one', conversationId, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 },
  input: 'Inspect this image', inputDigest: 'host-digest', protocol,
  userItems: [{ role: 'user', content: [{ type: 'input_text', text: 'Inspect this image' }, { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'auto' }] }],
  configuration: { connectionId: 'fixture', model: 'fixture' }, policyRevision: 'policy',
});
async function fixture(t, finished = false) {
  const rootDirectory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'submission-read-')));
  const conversationId = randomUUID(), options = { rootDirectory, conversationId };
  let store = await NativeRunStore.open(options);
  const req = request(conversationId);
  await store.beginRun(req);
  await store.append(req.identity, { type: 'model_response', response: { outputItems: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Image noted' }] }], toolCalls: [], finishReason: 'completed', usage: null } });
  await store.checkpoint(req.identity, store.loadContext());
  if (finished) await store.append(req.identity, { type: 'run_finished', result: { identity: req.identity, status: 'completed', reason: 'complete', modelRequests: 1, toolCalls: 0, usage: null, context: store.loadContext(), committed: true } });
  t.after(async () => { await store.close().catch(() => {}); await fs.rm(rootDirectory, { recursive: true, force: true }); });
  return { options, req, directory: store.directory, journal: path.join(store.directory, 'journal.jsonl'), checkpoint: path.join(store.directory, 'checkpoint.json'),
    get store() { return store; }, async reopen() { await store.close(); store = await NativeRunStore.open(options); },
    read: (runId = req.identity.runId, extra = {}) => NativeRunStore.readSubmission({ ...options, ...extra }, runId) };
}
async function inventory(directory) {
  return Promise.all((await fs.readdir(directory)).sort().map(async name => {
    const file = path.join(directory, name), stat = await fs.lstat(file, { bigint: true });
    return { name, mode: stat.mode, size: stat.size, ino: stat.ino, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, data: stat.isFile() ? await fs.readFile(file, 'utf8') : null };
  }));
}
async function hooked(methods, body) {
  const originals = Object.fromEntries(Object.keys(methods).map(key => [key, fs[key]]));
  try {
    for (const [key, method] of Object.entries(methods)) fs[key] = method(originals[key]);
    syncBuiltinESMExports();
    return await body();
  } finally {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  }
}

test('read-only retrieval leaves active writer, checkpoint temp files and interrupted state untouched', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.directory, `checkpoint-${randomUUID()}.tmp`), 'incomplete checkpoint evidence');
  const before = await inventory(f.directory), replay = f.store.replay(), active = f.store.getRun(f.req.identity.runId);
  const methods = Object.fromEntries(['mkdir', 'chmod', 'unlink', 'rename', 'writeFile', 'appendFile', 'rm'].map(name => [name, () => async () => { throw new Error(`Unexpected write: ${name}`); }]));
  methods.open = original => async (file, flags, ...rest) => {
    assert.equal(flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND), 0);
    const handle = await original(file, flags, ...rest);
    for (const name of ['write', 'writeFile', 'appendFile', 'chmod', 'truncate', 'sync']) handle[name] = async () => { throw new Error(`Unexpected descriptor write: ${name}`); };
    return handle;
  };
  const result = await hooked(methods, () => f.read());
  assert.deepEqual(result, f.req);
  assert.deepEqual(await inventory(f.directory), before);
  assert.deepEqual(f.store.replay(), replay);
  assert.deepEqual(f.store.getRun(f.req.identity.runId), active);
  assert.equal(active.status, 'active');
  assert.equal(f.store.recoveryRequired, false);
  result.userItems[0].content[1].image_url = 'changed only in caller';
  assert.deepEqual(await f.read(), f.req);
  assert.deepEqual(f.store.lookupSubmission(f.req.identity.requestId).request, f.req);
  // A subsequent real write proves the read did not disturb ownership.
  await f.store.append(f.req.identity, { type: 'model_response', response: { outputItems: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Still writable' }] }], toolCalls: [], finishReason: 'completed', usage: null } });
});

test('read-only retrieval survives clean restart and verifies later records before returning an earlier run', async t => {
  const f = await fixture(t, true);
  await f.reopen();
  assert.deepEqual(await f.read(), f.req);
  const second = request(f.options.conversationId);
  await f.store.beginRun(second);
  assert.deepEqual(await f.read(), f.req);
  assert.deepEqual(await f.read(second.identity.runId), second);
  assert.equal(await f.read(randomUUID()), undefined);
  await f.store.close();
  assert.deepEqual(await f.read(second.identity.runId), second);
  const records = (await fs.readFile(f.journal, 'utf8')).trimEnd().split('\n').map(JSON.parse);
  const latest = records.at(-1);
  latest.event = { type: 'unknown_event', secret: 'must-never-appear-in-error' };
  const { hash: _hash, ...body } = latest;
  latest.hash = sha(body);
  await fs.writeFile(f.journal, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  await assert.rejects(f.read(), error => error.code === 'corrupt_store' && !error.message.includes('must-never-appear'));
});

test('missing store, missing conversation and empty existing directory never create files or locks', async t => {
  const rootDirectory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'missing-submission-')));
  t.after(() => fs.rm(rootDirectory, { recursive: true, force: true }));
  const conversationId = randomUUID(), runId = randomUUID();
  assert.equal(await NativeRunStore.readSubmission({ rootDirectory: path.join(rootDirectory, 'absent', 'nested'), conversationId }, runId), undefined);
  assert.deepEqual(await fs.readdir(rootDirectory), []);
  assert.equal(await NativeRunStore.readSubmission({ rootDirectory, conversationId }, runId), undefined);
  assert.deepEqual(await fs.readdir(rootDirectory), []);
  const directory = path.join(rootDirectory, conversationId);
  await fs.mkdir(directory);
  assert.equal(await NativeRunStore.readSubmission({ rootDirectory, conversationId }, runId), undefined);
  assert.deepEqual(await fs.readdir(directory), []);
  await assert.rejects(NativeRunStore.readSubmission({ rootDirectory, conversationId: '../invalid' }, runId), { code: 'invalid_identity' });
  await assert.rejects(NativeRunStore.readSubmission({ rootDirectory, conversationId }, '../invalid'), { code: 'invalid_identity' });
});

for (const [name, mutation] of [
  ['truncated journal', async f => fs.writeFile(f.journal, (await fs.readFile(f.journal)).subarray(0, -1))],
  ['bad journal hash', async f => fs.writeFile(f.journal, (await fs.readFile(f.journal, 'utf8')).replace('Inspect this image', 'Altered this image'))],
  ['invalid UTF-8', async f => fs.writeFile(f.journal, Buffer.from([255, 10]))],
  ['missing journal with checkpoint', async f => fs.unlink(f.journal)],
  ['checkpoint hash mismatch', async f => fs.writeFile(f.checkpoint, (await fs.readFile(f.checkpoint, 'utf8')).replace('Inspect this image', 'Altered this image'))],
  ['checkpoint state mismatch with a valid checksum', async f => {
    const checkpoint = JSON.parse(await fs.readFile(f.checkpoint, 'utf8'));
    checkpoint.context.items[0].content[0].text = 'Other valid context';
    const { hash: _hash, ...body } = checkpoint;
    checkpoint.hash = sha(body);
    await fs.writeFile(f.checkpoint, JSON.stringify(checkpoint));
  }],
]) test(`read-only retrieval rejects ${name} without repair`, async t => {
  const f = await fixture(t, true);
  await f.store.close();
  await mutation(f);
  const before = await inventory(f.directory);
  await assert.rejects(f.read(), { code: 'corrupt_store' });
  assert.deepEqual(await inventory(f.directory), before);
});

test('read-only limits are enforced before allocating or replaying unbounded persisted data', async t => {
  const f = await fixture(t);
  await assert.rejects(f.read(undefined, { limits: { maxJournalBytes: 1, maxRecordBytes: 1 } }), { code: 'limit_exceeded' });
  await assert.rejects(f.read(undefined, { limits: { maxCheckpointBytes: 1 } }), { code: 'limit_exceeded' });
  await assert.rejects(f.read(undefined, { limits: { maxRecords: 1 } }), { code: 'limit_exceeded' });
  await assert.rejects(f.read(undefined, { limits: { maxRecordBytes: 1 } }), { code: 'limit_exceeded' });
});

for (const mode of ['symbolic', 'hard']) test(`read-only retrieval rejects ${mode} linked journal files`, async t => {
  const f = await fixture(t, true);
  await f.store.close();
  const original = path.join(f.options.rootDirectory, 'original-journal');
  await fs.rename(f.journal, original);
  if (mode === 'hard') await fs.link(original, f.journal);
  else {
    try { await fs.symlink(original, f.journal); }
    catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('Windows requires symlink privileges'); return; } throw error; }
  }
  await assert.rejects(f.read(), { code: 'unsafe_path' });
});

test('read-only retrieval rejects symlinked ancestors, including ancestors above configured root', async t => {
  const f = await fixture(t, true);
  const alias = path.join(f.options.rootDirectory, 'alias');
  try { await fs.symlink(f.options.rootDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('Windows requires symlink privileges'); return; } throw error; }
  await assert.rejects(NativeRunStore.readSubmission({ rootDirectory: alias, conversationId: f.options.conversationId }, f.req.identity.runId), { code: 'unsafe_path' });
  const nested = path.join(f.options.rootDirectory, 'nested');
  await fs.mkdir(nested);
  await assert.rejects(NativeRunStore.readSubmission({ rootDirectory: path.join(alias, 'nested'), conversationId: randomUUID() }, f.req.identity.runId), { code: 'unsafe_path' });
});

for (const mutation of ['append', 'truncate', 'same-size rewrite', 'file replacement', 'parent replacement']) test(`read-only retrieval rejects concurrent ${mutation} without trusting a mixed snapshot`, async t => {
  const f = await fixture(t, true);
  await f.store.close();
  const original = await fs.readFile(f.journal);
  let mutated = false;
  const replaceParent = async () => {
    await fs.rename(f.directory, f.directory + '-old');
    await fs.mkdir(f.directory);
    await fs.writeFile(f.journal, original);
    await fs.copyFile(path.join(f.directory + '-old', 'checkpoint.json'), f.checkpoint);
  };
  await hooked({ open: open => async (file, ...args) => {
    // Windows forbids renaming a directory with open child handles. Replace it
    // after path metadata was captured, but before opening the first child.
    if (mutation === 'parent replacement' && process.platform === 'win32' && !mutated) {
      mutated = true;
      await replaceParent();
    }
    const handle = await open(file, ...args);
    if (file === f.journal) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        if (!mutated) {
          mutated = true;
          if (mutation === 'append') await fs.appendFile(f.journal, 'extra-byte');
          if (mutation === 'truncate') await fs.truncate(f.journal, original.length - 1);
          if (mutation === 'same-size rewrite') {
            await fs.writeFile(f.journal, original);
            const future = new Date(Date.now() + 60_000);
            await fs.utimes(f.journal, future, future);
          }
          if (mutation === 'file replacement') { await fs.rename(f.journal, f.journal + '.old'); await fs.writeFile(f.journal, original); }
          if (mutation === 'parent replacement') await replaceParent();
        }
        return result;
      };
    }
    return handle;
  } }, () => assert.rejects(f.read(), { code: 'snapshot_changed' }));
  assert.equal(mutated, true);
});

test('unrelated sibling creation during descriptor reads does not invalidate a stable conversation', async t => {
  const f = await fixture(t, true);
  let created = false;
  await hooked({ open: open => async (file, ...args) => {
    const handle = await open(file, ...args);
    if (file === f.journal) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        if (!created) { created = true; await fs.mkdir(path.join(f.options.rootDirectory, 'other-conversation')); }
        return result;
      };
    }
    return handle;
  } }, async () => assert.deepEqual(await f.read(), f.req));
  assert.equal(created, true);
});


test('writer startup binds journal identity before replay and rejects replacement during pure validation', async t => {
  const f = await fixture(t, true);
  await f.store.close();
  const journal = await fs.readFile(f.journal);
  const originalHash = crypto.createHash;
  let replaced = false, writer;
  try {
    crypto.createHash = (...args) => {
      if (!replaced) {
        replaced = true;
        renameSync(f.journal, f.journal + '.old');
        writeFileSync(f.journal, journal);
      }
      return originalHash(...args);
    };
    syncBuiltinESMExports();
    writer = await NativeRunStore.open(f.options);
  } finally {
    crypto.createHash = originalHash;
    syncBuiltinESMExports();
  }
  try {
    assert.equal(replaced, true);
    await assert.rejects(writer.beginRun(request(f.options.conversationId)), { code: 'writer_lost' });
    assert.deepEqual(await fs.readFile(f.journal), journal);
  } finally { await writer?.close(); }
});
