import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ProjectChangeSet, validateChangeSetInput } from '../dist/tools/change-set.js';
import { isNativeChangeSetPreview, isNativeChangeSetResult, nativeChangeSetUtf8Bytes } from '@cc-desk/contracts/native-changes';
const hash = value => createHash('sha256').update(value).digest('hex');
const replace = (file, before, content) => ({ path: file, expectedHash: hash(before), content });
const create = (file, content) => ({ path: file, expectedHash: null, content });
async function fixture(t, contents = { 'a.txt': 'old a\n', 'b.txt': 'old b\n' }, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-change-set-'));
  const write = async (relative, content) => { const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); };
  for (const [file, content] of Object.entries(contents)) await write(file, content);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, write, read: relative => fs.readFile(path.join(root, relative), 'utf8'), engine: new ProjectChangeSet({ projectRoot: root, ...options }) };
}
const defaults = () => ({ signal: new AbortController().signal, assertCurrent: async () => {}, record: async () => {} });
const two = { changes: [replace('a.txt', 'old a\n', 'new a\n'), replace('b.txt', 'old b\n', 'new b\n')] };

test('complete preview binds ordered changes, dirty current bytes and explicit newline differences', async t => {
  const f = await fixture(t, { 'a.txt': 'user dirty\r\nkeep\nno-final', 'unrelated.txt': 'leave me' });
  const input = { changes: [replace('a.txt', 'user dirty\r\nkeep\nno-final', 'user dirty\r\nchanged\nno-final'), create('empty.txt', '')] };
  const prepared = await f.engine.prepare(input);
  assert.equal(isNativeChangeSetPreview(prepared.preview), true); assert.equal(prepared.preview.atomic, false);
  assert.equal(prepared.preview.previewBytes, Buffer.byteLength(JSON.stringify(prepared.preview)));
  assert.match(prepared.preview.files[0].diff, /\[CRLF\]/); assert.match(prepared.preview.files[0].diff, /\[no newline\]/);
  assert.match(prepared.preview.files[0].diff, /-"keep" \[LF\]/); assert.match(prepared.preview.files[0].diff, /\+"changed" \[LF\]/);
  assert.equal(prepared.preview.files[0].lineEndings.before, 'mixed'); assert.equal(prepared.preview.files[0].noFinalNewline.after, true);
  assert.equal(prepared.preview.files[1].kind, 'create'); assert.match(prepared.preview.files[1].diff, /@@ -0,0 \+0,0 @@/);
  assert.equal(await f.read('a.txt'), 'user dirty\r\nkeep\nno-final');
  const reordered = await f.engine.prepare({ changes: [...input.changes].reverse() }); assert.notEqual(reordered.digest, prepared.digest);
  const result = await f.engine.apply(prepared, defaults()); assert.equal(result.status, 'completed'); assert.equal(isNativeChangeSetResult(result), true);
  assert.equal(await f.read('a.txt'), input.changes[0].content); assert.equal(await f.read('empty.txt'), ''); assert.equal(await f.read('unrelated.txt'), 'leave me');
});
test('create, empty replacement and newline-only changes have accurate complete hunks', async t => {
  const f = await fixture(t, { 'a.txt': 'one\r', 'b.txt': 'same\n' });
  const prepared = await f.engine.prepare({ changes: [replace('a.txt', 'one\r', ''), replace('b.txt', 'same\n', 'same\r\n'), create('new.txt', 'new')] });
  assert.match(prepared.preview.files[0].diff, /-"one" \[CR\]/); assert.match(prepared.preview.files[0].diff, /\+0,0/);
  assert.match(prepared.preview.files[1].diff, /-"same" \[LF\]/); assert.match(prepared.preview.files[1].diff, /\+"same" \[CRLF\]/);
  assert.match(prepared.preview.files[2].diff, /\+"new" \[no newline\]/);
});
test('static path validation rejects every unsafe batch before any project reads', async t => {
  const f = await fixture(t, undefined, { protectedPaths: ['guides/coding/SKILL.md'] }); let reads = 0;
  f.engine.files.read = async () => { reads++; throw new Error('Unexpected read'); };
  for (const blocked of ['.env', '.ssh/key', 'deep/AGENTS.md', 'deep/claude.md', 'guides/coding/SKILL.md', '\ud800.txt']) await assert.rejects(f.engine.prepare({ changes: [two.changes[0], create(blocked, 'data')] }));
  assert.equal(reads, 0);
  for (const names of [['a.txt', 'A.txt'], ['é.txt', 'e\u0301.txt'], ['parent', 'parent/child.txt'], ['parent/child.txt', 'parent']]) assert.throws(() => validateChangeSetInput({ changes: names.map(file => create(file, 'new')) }), { code: 'aliased_batch_path' });
});
test('hardlink aliases and symlink parents cannot be approved as independent files', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); await fs.link(path.join(f.root, 'a.txt'), path.join(f.root, 'alias.txt'));
  await assert.rejects(f.engine.prepare({ changes: [two.changes[0], replace('alias.txt', 'old a\n', 'other\n')] }), { code: 'aliased_batch_path' });
  await fs.symlink(f.root, path.join(f.root, 'loop'));
  await assert.rejects(f.engine.prepare({ changes: [create('loop/new.txt', 'new')] }));
});
test('existing-file versions, no-op content and create conflicts are refused before approval', async t => {
  const f = await fixture(t);
  await assert.rejects(f.engine.prepare({ changes: [replace('a.txt', 'stale', 'new')] }), { code: 'version_conflict' });
  await assert.rejects(f.engine.prepare({ changes: [replace('a.txt', 'old a\n', 'old a\n')] }), { code: 'unchanged_file' });
  await assert.rejects(f.engine.prepare({ changes: [create('a.txt', 'new')] }));
  assert.equal(await f.read('a.txt'), 'old a\n');
});
test('file count, content, full-preview and diff-line limits reject rather than truncate', async t => {
  const f = await fixture(t);
  await assert.rejects(f.engine.prepare({ changes: Array.from({ length: 17 }, (_, index) => create(`${index}.txt`, 'x')) }));
  await assert.rejects(f.engine.prepare({ changes: [create('large.txt', 'x'.repeat(256 * 1024 + 1))] }), { code: 'change_set_too_large' });
  await assert.rejects(f.engine.prepare({ changes: [create('preview.txt', 'x'.repeat(128 * 1024))] }), { code: 'change_set_too_large' });
  await assert.rejects(f.engine.prepare({ changes: [create('lines.txt', '\n'.repeat(50001))] }), { code: 'change_set_too_large' });
});
test('protected credentials in old unchanged context or proposed content cannot enter preview', async t => {
  const secret = 'credential-value'; const f = await fixture(t, { 'a.txt': `${secret}\nold\n` }, { forbiddenValues: [secret] });
  await assert.rejects(f.engine.prepare({ changes: [replace('a.txt', `${secret}\nold\n`, 'removed secret\nnew\n')] }), { code: 'secret_rejected' });
  await assert.rejects(f.engine.prepare({ changes: [create('new.txt', secret)] }), { code: 'secret_rejected' });
});
test('mutating public input or preview cannot change the approved effect', async t => {
  const f = await fixture(t); const prepared = await f.engine.prepare(two);
  for (const mutate of [value => { value.input.changes[0].content = 'evil'; }, value => { value.preview.files[0].diff = 'fake'; }, value => { value.digest = 'a'.repeat(64); }]) {
    const changed = structuredClone(prepared); mutate(changed);
    await assert.rejects(f.engine.apply(changed, defaults()), { code: 'changed_change_set' });
  }
  assert.equal(await f.read('a.txt'), 'old a\n');
});
test('all-file preflight prevents first-file writes when a later file has changed', async t => {
  const f = await fixture(t); const prepared = await f.engine.prepare(two); await f.write('b.txt', 'external b\n'); const events = [];
  const result = await f.engine.apply(prepared, { ...defaults(), record: async event => { events.push(event); } });
  assert.equal(result.status, 'not_applied'); assert.deepEqual(events.map(event => event.status), ['not_applied', 'not_applied']);
  assert.equal(await f.read('a.txt'), 'old a\n'); assert.equal(await f.read('b.txt'), 'external b\n');
});
test('each applied receipt is awaited before the next file is touched', async t => {
  const f = await fixture(t); const prepared = await f.engine.prepare(two); const events = [];
  let release; const barrier = new Promise(resolve => { release = resolve; });
  let reached; const recorded = new Promise(resolve => { reached = resolve; });
  const pending = f.engine.apply(prepared, { ...defaults(), record: async event => { events.push(event); if (event.index === 0 && event.status === 'applied') { reached(); await barrier; } } });
  await recorded; assert.equal(await f.read('a.txt'), 'new a\n'); assert.equal(await f.read('b.txt'), 'old b\n'); release();
  const result = await pending; assert.equal(result.status, 'completed');
  assert.deepEqual(events.map(event => `${event.index}:${event.status}`), ['0:prepared', '0:applied', '1:prepared', '1:applied']);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= prepared.resultMaxBytes);
});
test('cancellation after prepared receipt records truthful nonexecution and skips every later file', async t => {
  const f = await fixture(t); const prepared = await f.engine.prepare(two); const controller = new AbortController(), events = [];
  const result = await f.engine.apply(prepared, { ...defaults(), signal: controller.signal, record: async event => { events.push(event); if (event.status === 'prepared') controller.abort(); } });
  assert.equal(result.status, 'not_applied'); assert.deepEqual(events.map(event => event.status), ['prepared', 'not_applied', 'not_applied']);
  assert.equal(await f.read('a.txt'), 'old a\n'); assert.equal(await f.read('b.txt'), 'old b\n');
});
test('cancellation after an applied receipt preserves the first edit and never rolls it back', async t => {
  const f = await fixture(t); const prepared = await f.engine.prepare(two); const controller = new AbortController();
  const result = await f.engine.apply(prepared, { ...defaults(), signal: controller.signal, record: async event => { if (event.index === 0 && event.status === 'applied') controller.abort(); } });
  assert.equal(result.status, 'partial'); assert.deepEqual(result.files.map(file => file.status), ['applied', 'not_applied']);
  assert.equal(await f.read('a.txt'), 'new a\n'); assert.equal(await f.read('b.txt'), 'old b\n');
});
test('file and instruction preconditions are rechecked after durable intent and before publication', async t => {
  const f = await fixture(t); const prepared = await f.engine.prepare(two); let instructionChanged = false;
  const result = await f.engine.apply(prepared, { ...defaults(), assertCurrent: async () => { if (instructionChanged) throw new Error('new rules'); }, record: async event => { if (event.status === 'prepared') instructionChanged = true; } });
  assert.equal(result.status, 'not_applied'); assert.equal(await f.read('a.txt'), 'old a\n');
  const fresh = await f.engine.prepare(two);
  const conflict = await f.engine.apply(fresh, { ...defaults(), record: async event => { if (event.index === 0 && event.status === 'prepared') await f.write('a.txt', 'external a'); } });
  assert.equal(conflict.status, 'not_applied'); assert.equal(await f.read('a.txt'), 'external a');
});
test('a later file conflict preserves both the earlier applied change and the external edit', async t => {
  const f = await fixture(t); const prepared = await f.engine.prepare(two);
  const result = await f.engine.apply(prepared, { ...defaults(), record: async event => { if (event.index === 0 && event.status === 'applied') await f.write('b.txt', 'external b'); } });
  assert.equal(result.status, 'partial'); assert.equal(await f.read('a.txt'), 'new a\n'); assert.equal(await f.read('b.txt'), 'external b');
});
test('failed intent persistence performs no writes and cannot be blindly replayed', async t => {
  const f = await fixture(t); const prepared = await f.engine.prepare(two); let records = 0;
  const options = { ...defaults(), record: async () => { records++; throw new Error('uncertain disk'); } };
  const result = await f.engine.apply(prepared, options); assert.equal(result.status, 'unknown'); assert.equal(result.receiptCommitted, false); assert.equal(records, 1);
  const retry = await f.engine.apply(prepared, defaults()); assert.deepEqual(retry, result); assert.equal(await f.read('a.txt'), 'old a\n');
});
for (const published of [false, true]) test(`error ${published ? 'after' : 'inside'} publish is unknown and blocks all later writes`, async t => {
  const f = await fixture(t); const prepared = await f.engine.prepare(two); const original = f.engine.files.applyPatch.bind(f.engine.files), events = [];
  f.engine.files.applyPatch = async (...args) => { if (published) await original(...args); throw new Error('publication uncertainty'); };
  const result = await f.engine.apply(prepared, { ...defaults(), record: async event => { events.push(event); } });
  assert.equal(result.status, 'unknown'); assert.deepEqual(result.files.map(file => file.status), ['unknown', 'not_applied']);
  assert.deepEqual(events.map(event => event.status), ['prepared', 'unknown', 'not_applied']);
  assert.equal(await f.read('a.txt'), published ? 'new a\n' : 'old a\n'); assert.equal(await f.read('b.txt'), 'old b\n');
  assert.equal(isNativeChangeSetResult(result), true);
});
test('failed applied receipt does not continue or mistake existing new bytes for a replay grant', async t => {
  const f = await fixture(t); const prepared = await f.engine.prepare(two); const events = [];
  const result = await f.engine.apply(prepared, { ...defaults(), record: async event => { events.push(event); if (event.status === 'applied') throw new Error('unknown journal commit'); } });
  assert.equal(result.status, 'unknown'); assert.equal(result.receiptCommitted, false); assert.equal(result.files[0].status, 'unknown');
  assert.deepEqual(events.map(event => event.status), ['prepared', 'applied']); assert.equal(await f.read('a.txt'), 'new a\n'); assert.equal(await f.read('b.txt'), 'old b\n');
  assert.deepEqual(await f.engine.apply(prepared, defaults()), result);
});
test('simultaneous duplicate application shares one execution and immutable outcome', async t => {
  const f = await fixture(t); const prepared = await f.engine.prepare(two); const events = [];
  const options = { ...defaults(), record: async event => { events.push(event); } };
  const [a, b] = await Promise.all([f.engine.apply(prepared, options), f.engine.apply(prepared, options)]);
  assert.deepEqual(a, b); assert.equal(events.length, 4); a.files[0].status = 'unknown'; assert.equal(b.files[0].status, 'applied');
});
test('portable validators reject truncated previews, duplicate file results and inconsistent completion', async t => {
  const f = await fixture(t); const prepared = await f.engine.prepare(two); assert.equal(isNativeChangeSetPreview(prepared.preview), true);
  assert.equal(isNativeChangeSetPreview({ ...prepared.preview, truncated: true }), false);
  assert.equal(isNativeChangeSetPreview({ ...prepared.preview, previewBytes: 1 }), false);
  const result = await f.engine.apply(prepared, defaults()); assert.equal(isNativeChangeSetResult(result), true);
  assert.equal(isNativeChangeSetResult({ ...result, receiptCommitted: false }), false);
  assert.equal(isNativeChangeSetResult({ ...result, files: result.files.map((file, index) => ({ ...file, path: 'a.txt', index })) }), false);
  assert.equal(nativeChangeSetUtf8Bytes('😀界'), Buffer.byteLength('😀界')); assert.equal(nativeChangeSetUtf8Bytes('\ud800'), Infinity);
});

test('concurrent preparations serialize reads and never exceed the prepared-set capacity', async t => {
  const f = await fixture(t), read = f.engine.files.read.bind(f.engine.files);
  let active = 0, peak = 0;
  f.engine.files.read = async (...args) => { active++; peak = Math.max(peak, active); try { return await read(...args); } finally { active--; } };
  const results = await Promise.allSettled(Array.from({ length: 40 }, () => f.engine.prepare({ changes: [two.changes[0]] })));
  assert.equal(peak, 1); assert.equal(results.filter(result => result.status === 'fulfilled').length, 32);
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(rejected.length, 8); assert.ok(rejected.every(result => result.reason.code === 'change_set_capacity'));
});
test('failed preparation releases the queue and queued cancellation performs no reads', async t => {
  const f = await fixture(t), controller = new AbortController();
  const failed = f.engine.prepare({ changes: [replace('a.txt', 'stale', 'new')] });
  const cancelled = f.engine.prepare(two, controller.signal); controller.abort();
  const valid = f.engine.prepare(two);
  await assert.rejects(failed, { code: 'version_conflict' }); await assert.rejects(cancelled);
  assert.equal((await valid).preview.files.length, 2);
});
test('ownership changed during post-intent file validation prevents entering publication', async t => {
  const f = await fixture(t), prepared = await f.engine.prepare(two), validate = f.engine.validateFile.bind(f.engine);
  let intent = false, owned = true, entered = false; const events = [];
  f.engine.validateFile = async (...args) => { await validate(...args); if (intent) owned = false; };
  f.engine.files.applyPatch = async () => { entered = true; throw new Error('must not publish'); };
  const result = await f.engine.apply(prepared, { ...defaults(),
    assertCurrent: async () => { if (!owned) throw new Error('ownership changed'); },
    record: async event => { events.push(event); if (event.status === 'prepared') intent = true; },
  });
  assert.equal(entered, false); assert.equal(result.status, 'not_applied');
  assert.deepEqual(events.map(event => event.status), ['prepared', 'not_applied', 'not_applied']);
  assert.equal(await f.read('a.txt'), 'old a\n'); assert.equal(await f.read('b.txt'), 'old b\n');
});

test('ownership lost while temporary content is written prevents publication and conservatively reports unknown', async t => {
  const f = await fixture(t), prepared = await f.engine.prepare(two), events = []; let observedTemporary = false;
  const result = await f.engine.apply(prepared, { ...defaults(),
    assertCurrent: async () => {
      if ((await fs.readdir(f.root)).some(name => name.startsWith('.native-patch-'))) {
        observedTemporary = true; throw new Error('ownership changed during temporary write');
      }
    }, record: async event => { events.push(event); },
  });
  assert.equal(observedTemporary, true); assert.equal(result.status, 'unknown');
  assert.deepEqual(events.map(event => event.status), ['prepared', 'unknown', 'not_applied']);
  assert.equal(await f.read('a.txt'), 'old a\n'); assert.equal(await f.read('b.txt'), 'old b\n');
  assert.equal((await fs.readdir(f.root)).some(name => name.startsWith('.native-patch-')), false);
});
test('external edits during the prepublication callback are preserved by the final file-version check', async t => {
  const f = await fixture(t), prepared = await f.engine.prepare(two); let changed = false;
  const result = await f.engine.apply(prepared, { ...defaults(), assertCurrent: async () => {
    if (!changed && (await fs.readdir(f.root)).some(name => name.startsWith('.native-patch-'))) {
      changed = true; await f.write('a.txt', 'external during guard');
    }
  } });
  assert.equal(changed, true); assert.equal(result.status, 'unknown');
  assert.equal(await f.read('a.txt'), 'external during guard'); assert.equal(await f.read('b.txt'), 'old b\n');
});
