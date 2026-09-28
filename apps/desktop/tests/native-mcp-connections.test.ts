import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { NativeMcpConnectionStore, validateNativeMcpEndpoint, type NativeMcpConnectionStoreOptions } from '../src/main/engines/native/mcp-connections';
import { NativeCredentialStore, type NativeSafeStorage } from '../src/main/engines/native/credentials';
import type { NativeMcpConnectionInput, NativeMcpConnectionView } from '../src/shared/native-mcp';

const sentinel = 'MCP-SECRET-SENTINEL-KEEP-IN-MAIN-12345';
const baseline: NativeMcpConnectionInput = { name: '测试 MCP', endpoint: 'https://example.test/mcp/', allowLoopbackHttp: false, enabled: true, auth: { mode: 'none' } };
function fixture(options: NativeMcpConnectionStoreOptions = {}, credentials = new NativeCredentialStore()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-desk-native-mcp-'));
  return { directory, file: path.join(directory, 'native', 'mcp-connections.json'), credentials, store: new NativeMcpConnectionStore(directory, credentials, options), dispose: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
function edit(item: NativeMcpConnectionView): NativeMcpConnectionInput {
  const { credentialConfigured: _configured, ready: _ready, error: _error, ...value } = item;
  return value;
}
function storage(): NativeSafeStorage {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: value => {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString: value => {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

test('MCP connections: explicit no-auth works without credentials and preserves the complete endpoint', () => {
  const f = fixture();
  try {
    const created = f.store.upsert(baseline), resolved = f.store.resolve(created.id);
    assert.equal(created.ready, true); assert.equal(created.credentialConfigured, true);
    assert.equal(resolved.endpoint, baseline.endpoint); assert.equal('bearerToken' in resolved, false);
    assert.ok(Object.isFrozen(resolved));
    f.store.assertCurrent({ id: created.id, revision: created.revision });
    const restarted = new NativeMcpConnectionStore(f.directory, new NativeCredentialStore());
    assert.deepEqual(restarted.resolve(created.id), resolved);
    assert.equal(fs.existsSync(path.join(f.directory, 'native', 'connections.json')), false);
    if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  } finally { f.dispose(); }
});

test('MCP connections: memory tokens remain main-only and use a separate key namespace', () => {
  const f = fixture();
  try {
    const created = f.store.upsert({ ...baseline, auth: { mode: 'memory' } });
    f.credentials.set(created.id, 'MODEL-CREDENTIAL-WITH-SAME-ID');
    assert.equal(f.store.list().connections[0].ready, false);
    const saved = f.store.setCredential({ id: created.id, revision: created.revision, mode: 'memory', secret: sentinel });
    const snapshot = f.store.resolve(saved.id);
    assert.equal(snapshot.bearerToken, sentinel);
    const changed = f.store.upsert({ ...edit(saved), name: 'Changed MCP', endpoint: 'https://other.test/mcp' });
    assert.equal(changed.revision, 3); assert.equal(changed.ready, true);
    assert.equal(snapshot.endpoint, baseline.endpoint); assert.equal(snapshot.revision, 2);
    assert.equal(f.credentials.get(created.id), 'MODEL-CREDENTIAL-WITH-SAME-ID');
    for (const value of [saved, changed, f.store.list()]) assert.ok(!JSON.stringify(value).includes(sentinel));
    const disk = fs.readFileSync(f.file, 'utf8');
    assert.ok(!disk.includes(sentinel)); assert.ok(!disk.includes('ciphertext'));
    assert.equal(new NativeMcpConnectionStore(f.directory, new NativeCredentialStore()).list().connections[0].ready, false);
    const noAuth = f.store.upsert({ ...edit(changed), auth: { mode: 'none' } });
    assert.equal(f.credentials.get(`native-mcp:${saved.id}`), undefined);
    assert.equal(f.credentials.get(saved.id), 'MODEL-CREDENTIAL-WITH-SAME-ID');
    assert.equal(f.store.resolve(noAuth.id).bearerToken, undefined);
    const emptyAgain = f.store.upsert({ ...edit(noAuth), auth: { mode: 'memory' } });
    assert.equal(emptyAgain.ready, false);
  } finally { f.dispose(); }
});

test('MCP connections: environment authentication resolves in main and malformed or missing values fail closed', () => {
  const environment = { MCP_TEST_TOKEN: sentinel, MCP_INVALID: sentinel + '\n' }, f = fixture({ environment });
  try {
    const good = f.store.upsert({ ...baseline, auth: { mode: 'env', variable: 'MCP_TEST_TOKEN' } });
    const missing = f.store.upsert({ ...baseline, auth: { mode: 'env', variable: 'MCP_MISSING' } });
    const invalid = f.store.upsert({ ...baseline, auth: { mode: 'env', variable: 'MCP_INVALID' } });
    assert.equal(good.ready, true); assert.equal(f.store.resolve(good.id).bearerToken, sentinel);
    assert.equal(missing.ready, false); assert.equal(invalid.ready, false);
    assert.throws(() => f.store.resolve(invalid.id), error => error instanceof Error && !error.message.includes(sentinel));
    assert.ok(!JSON.stringify(f.store.list()).includes(sentinel));
    assert.ok(!fs.readFileSync(f.file, 'utf8').includes(sentinel));
    assert.ok(fs.readFileSync(f.file, 'utf8').includes('MCP_TEST_TOKEN'));
    environment.MCP_TEST_TOKEN = 'replacement';
    assert.equal(f.store.resolve(good.id).bearerToken, 'replacement');
  } finally { f.dispose(); }
});

test('MCP connections: OS-protected tokens survive restart without returning ciphertext or plaintext', () => {
  const safeStorage = storage(), f = fixture({}, new NativeCredentialStore(safeStorage, 'linux'));
  try {
    const created = f.store.upsert(baseline);
    const saved = f.store.setCredential({ id: created.id, revision: created.revision, mode: 'encrypted', secret: sentinel });
    const restarted = new NativeMcpConnectionStore(f.directory, new NativeCredentialStore(safeStorage, 'linux'));
    assert.equal(restarted.resolve(saved.id).bearerToken, sentinel);
    const view = JSON.stringify(restarted.list()), disk = fs.readFileSync(f.file, 'utf8');
    assert.ok(!view.includes(sentinel)); assert.ok(!view.includes('ciphertext'));
    assert.ok(!disk.includes(sentinel)); assert.ok(disk.includes('ciphertext'));
    const changed = restarted.upsert({ ...edit(saved), name: 'New name' });
    assert.equal(restarted.resolve(changed.id).bearerToken, sentinel);
    const locked = new NativeMcpConnectionStore(f.directory, new NativeCredentialStore({ ...safeStorage, getSelectedStorageBackend: () => 'basic_text' }, 'linux'));
    assert.equal(locked.list().connections[0].ready, false);
    assert.throws(() => locked.resolve(saved.id), /保护/);
  } finally { f.dispose(); }
});

test('MCP connections: unsupported or throwing OS storage cannot leak tokens or partially change metadata', () => {
  const safeStorage = storage();
  for (const unavailable of [undefined, { ...safeStorage, getSelectedStorageBackend: () => 'unknown' }, { ...safeStorage, encryptString: () => { throw new Error(sentinel); } }]) {
    const f = fixture({}, new NativeCredentialStore(unavailable, 'linux'));
    try {
      const created = f.store.upsert(baseline), before = fs.readFileSync(f.file, 'utf8');
      assert.throws(() => f.store.setCredential({ id: created.id, revision: created.revision, mode: 'encrypted', secret: sentinel }), error => error instanceof Error && !error.message.includes(sentinel));
      assert.equal(fs.readFileSync(f.file, 'utf8'), before);
      assert.equal(f.store.list().connections[0].revision, created.revision);
    } finally { f.dispose(); }
  }
  const f = fixture({}, new NativeCredentialStore(safeStorage, 'linux'));
  try {
    const created = f.store.upsert(baseline);
    f.store.setCredential({ id: created.id, revision: created.revision, mode: 'encrypted', secret: sentinel });
    const broken = new NativeMcpConnectionStore(f.directory, new NativeCredentialStore({ ...safeStorage, decryptString: () => { throw new Error(sentinel); } }, 'linux'));
    assert.equal(broken.list().connections[0].ready, false);
    assert.ok(!JSON.stringify(broken.list()).includes(sentinel));
  } finally { f.dispose(); }
});

test('MCP connections: active runs, stale snapshots and referenced deletion are guarded', () => {
  let active = false, referenced = true;
  const f = fixture({ isConnectionActive: () => active, isConnectionReferenced: () => referenced });
  try {
    const created = f.store.upsert(baseline), before = fs.readFileSync(f.file, 'utf8');
    active = true;
    assert.throws(() => f.store.upsert({ ...edit(created), enabled: false }), /运行/);
    assert.throws(() => f.store.setCredential({ id: created.id, revision: created.revision, mode: 'memory', secret: sentinel }), /运行/);
    assert.throws(() => f.store.remove({ id: created.id, revision: created.revision }), /运行/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
    assert.doesNotThrow(() => f.store.assertCurrent({ id: created.id, revision: created.revision }));
    active = false;
    assert.throws(() => f.store.remove({ id: created.id, revision: created.revision }), /已有会话/);
    const disabled = f.store.upsert({ ...edit(created), enabled: false });
    assert.equal(disabled.ready, false);
    assert.throws(() => f.store.resolve(disabled.id), /禁用/);
    assert.throws(() => f.store.assertCurrent({ id: created.id, revision: created.revision }), /已更新/);
    assert.throws(() => f.store.upsert(edit(created)), /已更新/);
    assert.throws(() => f.store.setCredential({ id: created.id, revision: created.revision, mode: 'memory', secret: sentinel }), /已更新/);
    assert.throws(() => f.store.remove({ id: created.id, revision: created.revision }), /已更新/);
    referenced = false;
    f.store.remove({ id: disabled.id, revision: disabled.revision });
    assert.equal(f.store.list().connections.length, 0);
  } finally { f.dispose(); }
});

test('MCP connections: unsafe endpoints and implicit HTTP are rejected without reflecting credentials', () => {
  for (const endpoint of ['https://user:password@example.test/mcp', 'https://@example.test', 'https://example.test/mcp?token=' + sentinel, 'https://example.test/mcp?', 'https://example.test/mcp#', 'https://example.test/mcp#' + sentinel, 'file:///tmp/mcp', 'http://example.test/mcp', 'https://example.test\\@attacker.test', 'http://localhost.evil.test/mcp', 'http://0.0.0.0/mcp', 'http://[::]/mcp']) {
    assert.throws(() => validateNativeMcpEndpoint(endpoint, true), error => error instanceof Error && !error.message.includes(sentinel));
  }
  for (const endpoint of ['http://localhost:9123/mcp/', 'http://127.0.0.1:9123/mcp', 'http://[::1]:9123/mcp']) {
    assert.throws(() => validateNativeMcpEndpoint(endpoint, false));
    assert.equal(validateNativeMcpEndpoint(endpoint, true), endpoint);
  }
  assert.equal(validateNativeMcpEndpoint('https://example.test/mcp/', false), 'https://example.test/mcp/');
});

test('MCP connections: corrupt, future, duplicate, credential-bearing and oversized files remain untouched', () => {
  const entry = { ...baseline, id: 'one', revision: 1 };
  const cases: unknown[] = ['{broken', { schemaVersion: 2, connections: [] }, { schemaVersion: 1, connections: [{ ...entry, bearerToken: sentinel }] }, { schemaVersion: 1, connections: [entry, entry] }, { schemaVersion: 1, connections: [{ ...entry, ciphertext: Buffer.from(sentinel).toString('base64') }] }, { schemaVersion: 1, connections: [{ ...entry, endpoint: 'https://example.test?secret=' + sentinel }] }, ' '.repeat(1024 * 1024 + 1)];
  for (const value of cases) {
    const f = fixture();
    try {
      fs.mkdirSync(path.dirname(f.file), { recursive: true });
      const source = typeof value === 'string' ? value : JSON.stringify(value);
      fs.writeFileSync(f.file, source);
      const store = new NativeMcpConnectionStore(f.directory, new NativeCredentialStore());
      assert.equal(store.list().connections.length, 0); assert.match(store.list().error!, /损坏/);
      assert.ok(!JSON.stringify(store.list()).includes(sentinel));
      assert.throws(() => store.upsert(baseline), /损坏/);
      assert.throws(() => store.resolve('one'), /损坏/);
      assert.throws(() => store.assertCurrent({ id: 'one', revision: 1 }), /损坏/);
      assert.equal(fs.readFileSync(f.file, 'utf8'), source);
    } finally { f.dispose(); }
  }
});

test('MCP connections: failed atomic replacement leaves metadata and memory credential unchanged', () => {
  const f = fixture();
  try {
    const created = f.store.upsert(baseline);
    const saved = f.store.setCredential({ id: created.id, revision: created.revision, mode: 'memory', secret: sentinel });
    const before = fs.readFileSync(f.file, 'utf8');
    fs.renameSync(f.file, f.file + '.backup');
    fs.mkdirSync(f.file);
    assert.throws(() => f.store.setCredential({ id: saved.id, revision: saved.revision, mode: 'memory', secret: 'replacement' }), /保存失败/);
    assert.equal(f.store.resolve(saved.id).bearerToken, sentinel);
    assert.equal(f.store.resolve(saved.id).revision, saved.revision);
    assert.equal(fs.readFileSync(f.file + '.backup', 'utf8'), before);
    assert.deepEqual(fs.readdirSync(path.dirname(f.file)).sort(), ['mcp-connections.json', 'mcp-connections.json.backup']);
    fs.rmdirSync(f.file);
    fs.renameSync(f.file + '.backup', f.file);
  } finally { f.dispose(); }
});

test('MCP connections: invalid inputs and exhausted revisions do not produce unreadable persisted state', () => {
  const f = fixture();
  try {
    for (const input of [{ ...baseline, id: 'one' }, { ...baseline, revision: 1 }, { ...baseline, bearerToken: sentinel }, { ...baseline, auth: { mode: 'env', variable: 'BAD-TOKEN' } }]) {
      assert.throws(() => f.store.upsert(input as NativeMcpConnectionInput), error => error instanceof Error && !error.message.includes(sentinel));
    }
    const entry = { ...baseline, id: 'one', revision: Number.MAX_SAFE_INTEGER };
    fs.mkdirSync(path.dirname(f.file), { recursive: true });
    const source = JSON.stringify({ schemaVersion: 1, connections: [entry] });
    fs.writeFileSync(f.file, source);
    const store = new NativeMcpConnectionStore(f.directory, new NativeCredentialStore());
    assert.throws(() => store.upsert(entry), /上限/);
    assert.throws(() => store.setCredential({ id: 'one', revision: entry.revision, mode: 'memory', secret: sentinel }), /上限/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), source);
  } finally { f.dispose(); }
});
