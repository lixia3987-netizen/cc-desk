import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SkillSnapshotStore } from '../dist/skill-snapshots.js';
import { contentHash, ProjectFiles } from '../dist/tools/project-files.js';

const makeLoaded = (content = 'Legacy guide.\r\nKeep exact text.', extra = {}) => {
  const standard = content.startsWith('---\n') || content.startsWith('\ufeff---\r\n');
  const body = standard ? content.slice(content.indexOf('---', content.indexOf('\n') + 1) + (content.includes('\r\n') ? 5 : 4)) : content;
  return { version: { skillId: 'skill:test-a', sourceRevision: 1, sourceFingerprint: 'a'.repeat(64), fullFileHash: contentHash(content), bodyHash: contentHash(body),
    bytes: Buffer.byteLength(content), format: standard ? 'standard' : 'legacy', ...extra }, content, body };
};
async function fixture(t) {
  // Canonicalize OS-provided temporary aliases before creating a private no-link store.
  const temporary = await fs.realpath(os.tmpdir());
  const parent = await fs.mkdtemp(path.join(temporary, 'native-skill-snapshots-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const directory = path.join(parent, 'private', 'snapshots');
  return { parent, directory, store: options => new SkillSnapshotStore({ directory, ...options }) };
}
const objects = async directory => (await fs.readdir(directory)).filter(name => /^[a-f0-9]{64}\.skill$/.test(name));

test('construction neither creates nor scans directories; first operation creates only private storage', async t => {
  const { directory, store } = await fixture(t);
  const snapshots = store();
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  const loaded = makeLoaded();
  assert.deepEqual(await snapshots.put(loaded), loaded.version);
  assert.deepEqual(await snapshots.read(loaded.version), loaded);
  if (process.platform !== 'win32') assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.deepEqual(await objects(directory), [`${loaded.version.fullFileHash}.skill`]);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(directory, `${loaded.version.fullFileHash}.skill`))).mode & 0o777, 0o600);
});

test('raw full-file deduplication preserves caller-specific source and skill identities across restarts', async t => {
  const { directory, store } = await fixture(t);
  const first = makeLoaded();
  const second = makeLoaded(first.content, { skillId: 'skill:other', sourceRevision: 4, sourceFingerprint: 'b'.repeat(64) });
  const snapshots = store();
  await snapshots.put(first);
  await snapshots.put(second);
  assert.equal((await objects(directory)).length, 1);
  assert.deepEqual(await snapshots.read(second.version), second);
  assert.deepEqual(await store().read(first.version), first);
  const before = await fs.stat(path.join(directory, `${first.version.fullFileHash}.skill`), { bigint: true });
  await snapshots.put(first);
  const after = await fs.stat(path.join(directory, `${first.version.fullFileHash}.skill`), { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs, before.mtimeNs);
});

test('standard BOM and CRLF documents retain full-file and exact body hashes', async t => {
  const { store } = await fixture(t);
  const loaded = makeLoaded('\ufeff---\r\nname: review\r\ndescription: Review this project.\r\n---\r\n中文正文。\r\n');
  await store().put(loaded);
  assert.equal(loaded.body, '中文正文。\r\n');
  assert.deepEqual(await store().read(loaded.version), loaded);
});

test('inconsistent bytes, complete hashes, body hashes, formats, text and limits are rejected before writing', async t => {
  const { directory, store } = await fixture(t);
  const loaded = makeLoaded();
  const cases = [
    { ...loaded, version: { ...loaded.version, bytes: loaded.version.bytes + 1 } },
    { ...loaded, version: { ...loaded.version, fullFileHash: '0'.repeat(64) } },
    { ...loaded, version: { ...loaded.version, bodyHash: '0'.repeat(64) } },
    { ...loaded, version: { ...loaded.version, format: 'standard' } },
    { ...loaded, body: 'Partial body.' },
    makeLoaded('x'.repeat(32769)), makeLoaded('binary\0content'), makeLoaded('\ud800'),
    { ...loaded, version: { ...loaded.version, skillId: '../escape' , fullFileHash: '../escape' } },
  ];
  for (const value of cases) await assert.rejects(store().put(value), /snapshot|version|byte limit|format|body/i);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('read returns only an exact complete version and refuses altered version metadata', async t => {
  const { store } = await fixture(t);
  const loaded = makeLoaded();
  const snapshots = store();
  await snapshots.put(loaded);
  for (const patch of [{ bytes: loaded.version.bytes - 1 }, { bodyHash: '0'.repeat(64) }, { format: 'standard' }, { fullFileHash: '0'.repeat(64) }]) {
    await assert.rejects(snapshots.read({ ...loaded.version, ...patch }), error => /snapshot|version|format/i.test(error.message));
  }
});

test('unknown content under an existing hash is never overwritten or accepted', async t => {
  const { directory, store } = await fixture(t);
  const loaded = makeLoaded();
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, `${loaded.version.fullFileHash}.skill`);
  await fs.writeFile(target, 'UNKNOWN sentinel.');
  const snapshots = store();
  await assert.rejects(snapshots.put(loaded), /does not match/);
  await assert.rejects(snapshots.read(loaded.version), /does not match/);
  assert.equal(await fs.readFile(target, 'utf8'), 'UNKNOWN sentinel.');
  assert.deepEqual(await fs.readdir(directory), [`${loaded.version.fullFileHash}.skill`]);
});

test('quota is based on persisted objects after restart, deduplication costs no additional bytes and no referenced object is collected', async t => {
  const { directory, store } = await fixture(t);
  const first = makeLoaded('First retained object.');
  const second = makeLoaded('Second retained object.');
  await store().put(first);
  const snapshots = store({ maxStorageBytes: first.version.bytes });
  assert.deepEqual(await snapshots.put(first), first.version);
  await assert.rejects(snapshots.put(second), /quota is full/);
  assert.deepEqual(await objects(directory), [`${first.version.fullFileHash}.skill`]);
  assert.deepEqual(await snapshots.read(first.version), first);
  assert.deepEqual(await store({ maxStorageBytes: 0 }).read(first.version), first);
});

test('multiple instances serialize quota checks and concurrent same-content publications deduplicate', async t => {
  const { directory, store } = await fixture(t);
  const first = makeLoaded('A'.repeat(20));
  const second = makeLoaded('B'.repeat(20));
  const results = await Promise.allSettled([store({ maxStorageBytes: 20 }).put(first), store({ maxStorageBytes: 20 }).put(second)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await objects(directory)).length, 1);
  await fs.rm(directory, { recursive: true });
  await Promise.all(Array.from({ length: 6 }, () => store({ maxStorageBytes: 20 }).put(first)));
  assert.deepEqual(await objects(directory), [`${first.version.fullFileHash}.skill`]);
});

test('a mutated caller object cannot change a version already waiting for publication', async t => {
  const { store } = await fixture(t);
  const loaded = makeLoaded();
  const original = structuredClone(loaded);
  const operation = store().put(loaded);
  loaded.content = 'Later mutated content.';
  loaded.body = 'Later mutated content.';
  loaded.version.fullFileHash = contentHash(loaded.content);
  assert.deepEqual(await operation, original.version);
  assert.deepEqual(await store().read(original.version), original);
});

test('a pre-cancelled write does not initialize storage and cancellation after temp sync does not publish a success', async t => {
  const { directory, store } = await fixture(t);
  const loaded = makeLoaded();
  await assert.rejects(store().put(loaded, AbortSignal.abort(new Error('Cancelled before snapshot.'))), /Cancelled/);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  const original = fs.open;
  const controller = new AbortController();
  fs.open = async (...args) => {
    const handle = await original(...args);
    if (String(args[0]).includes('.native-skill-snapshot-')) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { await sync(); controller.abort(new Error('Cancelled during snapshot.')); };
    }
    return handle;
  };
  t.after(() => { fs.open = original; });
  await assert.rejects(store().put(loaded, controller.signal), /Cancelled during/);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('write and publication failures leave no confirmed object and redact host paths', async t => {
  const { directory, store } = await fixture(t);
  const loaded = makeLoaded();
  const original = fs.open;
  fs.open = async (...args) => {
    const handle = await original(...args);
    if (String(args[0]).includes('.native-skill-snapshot-')) handle.writeFile = async () => { throw Object.assign(new Error(`Injected EIO: ${directory}`), { code: 'EIO' }); };
    return handle;
  };
  t.after(() => { fs.open = original; });
  await assert.rejects(store().put(loaded), error => !error.message.includes(directory));
  assert.deepEqual(await fs.readdir(directory), []);
  fs.open = original;
  const originalLink = fs.link;
  fs.link = async () => { throw Object.assign(new Error(`Injected link failure: ${directory}`), { code: 'EPERM' }); };
  t.after(() => { fs.link = originalLink; });
  await assert.rejects(store().put(loaded), error => !error.message.includes(directory));
  assert.deepEqual(await fs.readdir(directory), []);
});

test('objects that race publication are validated rather than overwritten', async t => {
  const { directory, store } = await fixture(t);
  const loaded = makeLoaded();
  const original = fs.link;
  fs.link = async (source, target) => {
    await fs.writeFile(target, 'UNKNOWN racing object.');
    return original(source, target);
  };
  t.after(() => { fs.link = original; });
  await assert.rejects(store().put(loaded), /does not match/);
  assert.equal(await fs.readFile(path.join(directory, `${loaded.version.fullFileHash}.skill`), 'utf8'), 'UNKNOWN racing object.');
  assert.equal((await fs.readdir(directory)).some(name => name.endsWith('.tmp')), false);
});

test('cancellation after atomic publication leaves an unconfirmed reusable object rather than a false success', async t => {
  const { directory, store } = await fixture(t);
  const loaded = makeLoaded();
  const original = fs.link;
  const controller = new AbortController();
  fs.link = async (...args) => { const result = await original(...args); controller.abort(new Error('Cancelled after publication.')); return result; };
  t.after(() => { fs.link = original; });
  await assert.rejects(store().put(loaded, controller.signal), /Cancelled after/);
  assert.equal((await objects(directory)).length, 1);
  assert.equal((await fs.readdir(directory)).some(name => name.endsWith('.tmp')), false);
  fs.link = original;
  assert.deepEqual(await store().put(loaded), loaded.version);
  assert.deepEqual(await store().read(loaded.version), loaded);
});

test('later file corruption is rejected by both reads and deduplicated puts', async t => {
  const { directory, store } = await fixture(t);
  const loaded = makeLoaded();
  const snapshots = store();
  await snapshots.put(loaded);
  await fs.writeFile(path.join(directory, `${loaded.version.fullFileHash}.skill`), 'Corrupted object.');
  await assert.rejects(snapshots.read(loaded.version), /does not match/);
  await assert.rejects(snapshots.put(loaded), /does not match/);
});

for (const scope of ['root', 'parent']) test(`storage refuses ${scope} directory links`, async t => {
  const { parent, directory, store } = await fixture(t);
  const outside = path.join(parent, 'outside');
  await fs.mkdir(outside);
  const link = scope === 'root' ? directory : path.dirname(directory);
  await fs.mkdir(path.dirname(link), { recursive: true });
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store().put(makeLoaded()), /links|ordinary/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('replacing a bound parent directory is rejected without reading the replacement object', async t => {
  const { directory, store } = await fixture(t);
  const loaded = makeLoaded();
  const snapshots = store();
  await snapshots.put(loaded);
  await fs.rename(path.dirname(directory), `${path.dirname(directory)}-old`);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${loaded.version.fullFileHash}.skill`), loaded.content);
  await assert.rejects(snapshots.read(loaded.version), /changed/);
  await assert.rejects(snapshots.put(loaded), /changed/);
});

test('a parent replacement during a full read cannot return success', async t => {
  const { directory, store } = await fixture(t);
  const loaded = makeLoaded();
  const snapshots = store();
  await snapshots.put(loaded);
  const original = ProjectFiles.prototype.read;
  ProjectFiles.prototype.read = async function (...args) {
    const result = await original.apply(this, args);
    await fs.rename(path.dirname(directory), `${path.dirname(directory)}-old`);
    await fs.mkdir(directory, { recursive: true });
    return result;
  };
  t.after(() => { ProjectFiles.prototype.read = original; });
  await assert.rejects(snapshots.read(loaded.version), /changed/);
});

test('a parent replacement at publication never confirms a snapshot in the replacement directory', async t => {
  const { directory, store } = await fixture(t);
  const loaded = makeLoaded();
  const original = fs.link;
  let replaced = false;
  fs.link = async (...args) => {
    if (!replaced) {
      replaced = true;
      await fs.rename(path.dirname(directory), `${path.dirname(directory)}-old`);
      await fs.mkdir(directory, { recursive: true });
    }
    return original(...args);
  };
  t.after(() => { fs.link = original; });
  await assert.rejects(store().put(loaded), /changed|missing|storage/);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('managed object symbolic links cannot be read or accepted as deduplicated snapshots', { skip: process.platform === 'win32' }, async t => {
  const { parent, directory, store } = await fixture(t);
  const loaded = makeLoaded();
  const outside = path.join(parent, 'outside');
  await fs.writeFile(outside, loaded.content);
  await fs.mkdir(directory, { recursive: true });
  await fs.symlink(outside, path.join(directory, `${loaded.version.fullFileHash}.skill`));
  await assert.rejects(store().read(loaded.version), /ordinary|links/);
  await assert.rejects(store().put(loaded), /ordinary|links/);
  assert.equal(await fs.readFile(outside, 'utf8'), loaded.content);
});

test('inventory has an 8192-entry bound, does not recurse and preserves unknown files', async t => {
  const { directory, store } = await fixture(t);
  await fs.mkdir(directory, { recursive: true });
  const names = Array.from({ length: 8193 }, (_, i) => `${String(i).padStart(64, '0')}.skill`);
  for (let offset = 0; offset < names.length; offset += 64) await Promise.all(names.slice(offset, offset + 64).map(name => fs.writeFile(path.join(directory, name), '')));
  await assert.rejects(store().put(makeLoaded()), /8192/);
  assert.equal((await fs.readdir(directory)).length, 8193);
});

test('managed hash objects must be ordinary bounded files; unrelated entries are neither followed nor deleted', async t => {
  const { directory, store } = await fixture(t);
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(path.join(directory, 'unknown-directory'));
  await fs.writeFile(path.join(directory, 'keep-unknown.txt'), 'Unknown content.');
  const loaded = makeLoaded();
  await store().put(loaded);
  assert.equal(await fs.readFile(path.join(directory, 'keep-unknown.txt'), 'utf8'), 'Unknown content.');
  const bad = path.join(directory, `${'0'.repeat(64)}.skill`);
  await fs.mkdir(bad);
  await assert.rejects(store().read(loaded.version), /ordinary|storage/);
});
