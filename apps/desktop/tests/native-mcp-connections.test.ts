import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { NativeMcpConnectionStore, validateNativeMcpEndpoint, type NativeMcpConnectionStoreOptions } from '../src/main/engines/native/mcp-connections';
import { NativeCredentialStore, type NativeSafeStorage } from '../src/main/engines/native/credentials';
import type { NativeMcpConnectionInput, NativeMcpConnectionView, NativeMcpHttpConnectionInput, NativeMcpStdioConnectionInput } from '../src/shared/native-mcp';

const sentinel = 'MCP-SECRET-SENTINEL-KEEP-IN-MAIN-12345';
const baseline: NativeMcpHttpConnectionInput = { name: '测试 MCP', endpoint: 'https://example.test/mcp/', allowLoopbackHttp: false, enabled: true, auth: { mode: 'none' } };
function fixture(options: NativeMcpConnectionStoreOptions = {}, credentials = new NativeCredentialStore()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-desk-native-mcp-'));
  return { directory, file: path.join(directory, 'native', 'mcp-connections.json'), credentials, store: new NativeMcpConnectionStore(directory, credentials, options), dispose: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
function edit(item: NativeMcpConnectionView): NativeMcpHttpConnectionInput {
  assert.equal(item.transport, 'http');
  if (item.transport !== 'http') throw new Error('Expected HTTP fixture');
  const { credentialConfigured: _configured, ready: _ready, error: _error, ...value } = item;
  return value;
}

function resolveHttp(store: NativeMcpConnectionStore, id: string) {
  const resolved = store.resolve(id);
  if (resolved.transport !== 'http') throw new Error('Expected HTTP fixture');
  return resolved;
}
function resolveStdio(store: NativeMcpConnectionStore, id: string) {
  const resolved = store.resolve(id);
  if (resolved.transport !== 'stdio') throw new Error('Expected stdio fixture');
  return resolved;
}
function editStdio(item: NativeMcpConnectionView): NativeMcpStdioConnectionInput {
  if (item.transport !== 'stdio') throw new Error('Expected stdio fixture');
  const { credentialConfigured: _configured, ready: _ready, error: _error, ...value } = item;
  return value;
}
const stdioBaseline: NativeMcpStdioConnectionInput = {
  transport: 'stdio', name: 'Local MCP', enabled: true, executable: process.execPath,
  argv: ['server.mjs', 'literal argument; $(not-a-shell)'], environment: {}, auth: { mode: 'none' },
};

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
    const created = f.store.upsert(baseline), resolved = resolveHttp(f.store, created.id);
    assert.equal(created.ready, true); assert.equal(created.credentialConfigured, true);
    assert.equal(created.transport, 'http'); assert.equal(created.protocolVersion, '2026-07-28'); assert.equal(resolved.protocolVersion, '2026-07-28');
    assert.equal(resolved.endpoint, baseline.endpoint); assert.equal('bearerToken' in resolved, false);
    assert.ok(Object.isFrozen(resolved));
    f.store.assertCurrent({ id: created.id, revision: created.revision });
    const restarted = new NativeMcpConnectionStore(f.directory, new NativeCredentialStore());
    assert.deepEqual(resolveHttp(restarted, created.id), resolved);
    assert.equal(fs.existsSync(path.join(f.directory, 'native', 'connections.json')), false);
    if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  } finally { f.dispose(); }
});

test('MCP connections: legacy metadata defaults to 2026 without writing or networking during reads', () => {
  const f = fixture({ environment: { MCP_TOKEN: sentinel } });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Connection metadata must never access the network'); };
  try {
    const legacy = { ...baseline, id: 'legacy', revision: 7, auth: { mode: 'env', variable: 'MCP_TOKEN' } };
    const source = JSON.stringify({ schemaVersion: 1, connections: [legacy] });
    fs.mkdirSync(path.dirname(f.file), { recursive: true }); fs.writeFileSync(f.file, source);
    const restarted = new NativeMcpConnectionStore(f.directory, f.credentials, { environment: { MCP_TOKEN: sentinel } });
    const view = restarted.list().connections[0];
    assert.equal(view.transport, 'http'); assert.equal(view.protocolVersion, '2026-07-28'); assert.equal(view.revision, 7); assert.equal(view.ready, true);
    assert.equal(resolveHttp(restarted, view.id).protocolVersion, '2026-07-28');
    assert.equal(resolveHttp(restarted, view.id).bearerToken, sentinel);
    assert.equal(fs.readFileSync(f.file, 'utf8'), source);
    assert.ok(!JSON.stringify(restarted.list()).includes(sentinel));
    const updated = restarted.upsert({ ...edit(view), name: 'Migrated metadata' });
    assert.equal(updated.revision, 8);
    assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).connections[0].protocolVersion, '2026-07-28');
    assert.equal(new NativeMcpConnectionStore(f.directory, f.credentials).list().connections[0].protocolVersion, '2026-07-28');
  } finally { globalThis.fetch = previousFetch; f.dispose(); }
});

test('MCP connections: explicit protocol choices persist, require current revisions and remain locked throughout a run', () => {
  let active = false;
  const f = fixture({ isConnectionActive: () => active });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Changing a protocol must never access the network'); };
  try {
    const created = f.store.upsert({ ...baseline, protocolVersion: '2025-11-25' });
    assert.equal(created.protocolVersion, '2025-11-25'); assert.equal(created.ready, true);
    const snapshot = resolveHttp(f.store, created.id);
    assert.equal(snapshot.protocolVersion, '2025-11-25');
    assert.equal(new NativeMcpConnectionStore(f.directory, f.credentials).resolve(created.id).protocolVersion, '2025-11-25');
    const before = fs.readFileSync(f.file, 'utf8');
    active = true;
    assert.throws(() => f.store.upsert({ ...edit(created), protocolVersion: '2026-07-28' }), /运行/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
    assert.equal(resolveHttp(f.store, created.id).protocolVersion, '2025-11-25');
    active = false;
    const changed = f.store.upsert({ ...edit(created), protocolVersion: '2026-07-28' });
    assert.equal(changed.revision, created.revision + 1);
    assert.equal(resolveHttp(f.store, created.id).protocolVersion, '2026-07-28');
    assert.equal(snapshot.protocolVersion, '2025-11-25');
    assert.throws(() => f.store.upsert({ ...edit(created), protocolVersion: '2025-11-25' }), /已更新/);
    assert.throws(() => f.store.assertCurrent({ id: created.id, revision: created.revision }), /已更新/);
    assert.equal(new NativeMcpConnectionStore(f.directory, f.credentials).resolve(created.id).protocolVersion, '2026-07-28');
  } finally { globalThis.fetch = previousFetch; f.dispose(); }
});

test('MCP connections: unsupported protocol metadata is rejected without changing the stored selection', () => {
  const f = fixture();
  try {
    const created = f.store.upsert({ ...baseline, protocolVersion: '2025-11-25' }), before = fs.readFileSync(f.file, 'utf8');
    for (const protocolVersion of ['2024-11-05', '2025-03-26', 'future', null, 2025]) {
      assert.throws(() => f.store.upsert({ ...edit(created), protocolVersion } as NativeMcpConnectionInput), /配置无效/);
      assert.equal(fs.readFileSync(f.file, 'utf8'), before);
      assert.equal(resolveHttp(f.store, created.id).protocolVersion, '2025-11-25');
    }
    const unsupported = JSON.stringify({ schemaVersion: 1, connections: [{ ...edit(created), protocolVersion: 'future' }] });
    fs.writeFileSync(f.file, unsupported);
    const restarted = new NativeMcpConnectionStore(f.directory, f.credentials);
    assert.match(restarted.list().error!, /版本不受支持/);
    assert.throws(() => resolveHttp(restarted, created.id), /版本不受支持/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), unsupported);
  } finally { f.dispose(); }
});

test('MCP connections: memory tokens remain main-only and use a separate key namespace', () => {
  const f = fixture();
  try {
    const created = f.store.upsert({ ...baseline, auth: { mode: 'memory' } });
    f.credentials.set(created.id, 'MODEL-CREDENTIAL-WITH-SAME-ID');
    assert.equal(f.store.list().connections[0].ready, false);
    const saved = f.store.setCredential({ id: created.id, revision: created.revision, mode: 'memory', secret: sentinel });
    const snapshot = resolveHttp(f.store, saved.id);
    assert.equal(snapshot.bearerToken, sentinel);
    const changed = f.store.upsert({ ...edit(saved), name: 'Changed MCP', endpoint: 'https://other.test/mcp', protocolVersion: '2025-11-25' });
    assert.equal(changed.revision, 3); assert.equal(changed.ready, true);
    assert.equal(resolveHttp(f.store, saved.id).protocolVersion, '2025-11-25');
    assert.equal(resolveHttp(f.store, saved.id).bearerToken, sentinel);
    assert.equal(snapshot.endpoint, baseline.endpoint); assert.equal(snapshot.revision, 2);
    assert.equal(f.credentials.get(created.id), 'MODEL-CREDENTIAL-WITH-SAME-ID');
    for (const value of [saved, changed, f.store.list()]) assert.ok(!JSON.stringify(value).includes(sentinel));
    const disk = fs.readFileSync(f.file, 'utf8');
    assert.ok(!disk.includes(sentinel)); assert.ok(!disk.includes('ciphertext'));
    assert.equal(new NativeMcpConnectionStore(f.directory, new NativeCredentialStore()).list().connections[0].ready, false);
    const noAuth = f.store.upsert({ ...edit(changed), auth: { mode: 'none' } });
    assert.equal(f.credentials.get(`native-mcp:${saved.id}`), undefined);
    assert.equal(f.credentials.get(saved.id), 'MODEL-CREDENTIAL-WITH-SAME-ID');
    assert.equal(resolveHttp(f.store, noAuth.id).bearerToken, undefined);
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
    assert.equal(good.ready, true); assert.equal(resolveHttp(f.store, good.id).bearerToken, sentinel);
    assert.equal(missing.ready, false); assert.equal(invalid.ready, false);
    assert.throws(() => resolveHttp(f.store, invalid.id), error => error instanceof Error && !error.message.includes(sentinel));
    assert.ok(!JSON.stringify(f.store.list()).includes(sentinel));
    assert.ok(!fs.readFileSync(f.file, 'utf8').includes(sentinel));
    assert.ok(fs.readFileSync(f.file, 'utf8').includes('MCP_TEST_TOKEN'));
    environment.MCP_TEST_TOKEN = 'replacement';
    assert.equal(resolveHttp(f.store, good.id).bearerToken, 'replacement');
  } finally { f.dispose(); }
});

test('MCP connections: OS-protected tokens survive restart without returning ciphertext or plaintext', () => {
  const safeStorage = storage(), f = fixture({}, new NativeCredentialStore(safeStorage, 'linux'));
  try {
    const created = f.store.upsert(baseline);
    const saved = f.store.setCredential({ id: created.id, revision: created.revision, mode: 'encrypted', secret: sentinel });
    const restarted = new NativeMcpConnectionStore(f.directory, new NativeCredentialStore(safeStorage, 'linux'));
    assert.equal(resolveHttp(restarted, saved.id).bearerToken, sentinel);
    const view = JSON.stringify(restarted.list()), disk = fs.readFileSync(f.file, 'utf8');
    assert.ok(!view.includes(sentinel)); assert.ok(!view.includes('ciphertext'));
    assert.ok(!disk.includes(sentinel)); assert.ok(disk.includes('ciphertext'));
    const changed = restarted.upsert({ ...edit(saved), name: 'New name', protocolVersion: '2025-11-25' });
    assert.equal(resolveHttp(restarted, changed.id).bearerToken, sentinel);
    const changedRestart = new NativeMcpConnectionStore(f.directory, new NativeCredentialStore(safeStorage, 'linux'));
    assert.equal(resolveHttp(changedRestart, saved.id).bearerToken, sentinel);
    assert.equal(resolveHttp(changedRestart, saved.id).protocolVersion, '2025-11-25');
    assert.ok(!JSON.stringify(changedRestart.list()).includes(sentinel));
    const locked = new NativeMcpConnectionStore(f.directory, new NativeCredentialStore({ ...safeStorage, getSelectedStorageBackend: () => 'basic_text' }, 'linux'));
    assert.equal(locked.list().connections[0].ready, false);
    assert.throws(() => resolveHttp(locked, saved.id), /保护/);
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
    assert.throws(() => resolveHttp(f.store, disabled.id), /禁用/);
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
      assert.throws(() => resolveHttp(store, 'one'), /损坏/);
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
    assert.equal(resolveHttp(f.store, saved.id).bearerToken, sentinel);
    assert.equal(resolveHttp(f.store, saved.id).revision, saved.revision);
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

test('MCP stdio connections: metadata persists literal launch fields while resolved environment stays main-only', () => {
  const environment = { HOST_TOKEN: sentinel, EMPTY_VALUE: '' }, f = fixture({ environment });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Stdio configuration must never access the network'); };
  try {
    const created = f.store.upsert({ ...stdioBaseline, environment: { API_TOKEN: 'HOST_TOKEN', EMPTY: 'EMPTY_VALUE' } });
    assert.equal(created.transport, 'stdio'); assert.equal(created.protocolVersion, '2025-11-25');
    assert.equal(created.ready, true); assert.equal(created.credentialConfigured, true);
    const resolved = resolveStdio(f.store, created.id);
    assert.equal(resolved.executable, process.execPath); assert.deepEqual(resolved.argv, stdioBaseline.argv);
    assert.deepEqual(resolved.environment, { API_TOKEN: sentinel, EMPTY: '' });
    assert.deepEqual(resolved.environmentSources, { API_TOKEN: 'HOST_TOKEN', EMPTY: 'EMPTY_VALUE' });
    assert.ok(Object.isFrozen(resolved)); assert.ok(Object.isFrozen(resolved.argv));
    assert.ok(Object.isFrozen(resolved.environment)); assert.ok(Object.isFrozen(resolved.environmentSources));
    for (const value of [created, f.store.list(), JSON.parse(fs.readFileSync(f.file, 'utf8'))]) assert.ok(!JSON.stringify(value).includes(sentinel));
    const source = fs.readFileSync(f.file, 'utf8');
    const restarted = new NativeMcpConnectionStore(f.directory, new NativeCredentialStore(), { environment });
    assert.deepEqual(resolveStdio(restarted, created.id), resolved);
    assert.equal(fs.readFileSync(f.file, 'utf8'), source);
    environment.HOST_TOKEN = 'rotated';
    assert.equal(resolveStdio(f.store, created.id).environment.API_TOKEN, 'rotated');
    assert.equal(resolved.environment.API_TOKEN, sentinel);
    const publicCopy = editStdio(created);
    publicCopy.argv.push('changed'); publicCopy.environment.API_TOKEN = 'CHANGED';
    assert.deepEqual(resolveStdio(f.store, created.id).argv, stdioBaseline.argv);
    assert.equal(resolveStdio(f.store, created.id).environmentSources.API_TOKEN, 'HOST_TOKEN');
  } finally { globalThis.fetch = previousFetch; f.dispose(); }
});

test('MCP stdio connections: readiness is read-only configuration inspection, never executable launch or discovery', () => {
  const f = fixture();
  try {
    const missingExecutable = path.join(f.directory, 'never-launch-this', 'server');
    const created = f.store.upsert({ ...stdioBaseline, executable: missingExecutable });
    assert.equal(created.ready, true);
    assert.equal(fs.existsSync(missingExecutable), false);
    const before = fs.readFileSync(f.file, 'utf8');
    assert.equal(resolveStdio(f.store, created.id).executable, missingExecutable);
    assert.equal(f.store.list().connections[0].ready, true);
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
    const disabled = f.store.upsert({ ...editStdio(created), enabled: false });
    assert.equal(disabled.ready, false); assert.throws(() => f.store.resolve(created.id), /禁用/);
  } finally { f.dispose(); }
});

test('MCP stdio connections: reject shell launch wrappers, relative paths, malformed arguments and incompatible metadata', () => {
  const f = fixture();
  try {
    const invalid: unknown[] = [
      { executable: 'node' }, { executable: './node' }, { executable: process.execPath + '\0' },
      { executable: path.join(f.directory, 'server.CMD') }, { executable: path.join(f.directory, 'server.bat') },
      { argv: 'server.mjs' }, { argv: ['bad\0argument'] }, { argv: Array(129).fill('a') }, { argv: ['a'.repeat(32 * 1024 + 1)] },
      { protocolVersion: '2026-07-28' }, { auth: { mode: 'memory' } }, { auth: { mode: 'env', variable: 'TOKEN' } },
      { endpoint: 'https://example.test/mcp' }, { cwd: f.directory }, { bearerToken: sentinel }, { env: { TOKEN: sentinel } },
    ];
    for (const value of invalid) assert.throws(() => f.store.upsert({ ...stdioBaseline, ...value as object } as NativeMcpConnectionInput), /配置无效/);
    assert.equal(f.store.list().connections.length, 0); assert.equal(fs.existsSync(f.file), false);
    assert.equal(f.store.upsert({ ...stdioBaseline, argv: ['中'.repeat((32 * 1024 - 4) / 3 | 0)] }).ready, true);
  } finally { f.dispose(); }
});

test('MCP stdio connections: reject injection targets, duplicate targets, oversized mappings and plaintext environment values', () => {
  const f = fixture();
  try {
    for (const key of ['NODE_OPTIONS', 'node_options', 'NODE_V8_COVERAGE', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'RUBYOPT', 'PERL5OPT', 'ELECTRON_RUN_AS_NODE', 'BASH_ENV', 'ENV', 'PATH', 'Path', 'HOME', 'SYSTEMROOT', 'JAVA_TOOL_OPTIONS', 'NPM_CONFIG_PREFIX', '__proto__']) {
      const environment = Object.fromEntries([[key, 'HOST_TOKEN']]);
      assert.throws(() => f.store.upsert({ ...stdioBaseline, environment }), /配置无效/, key);
    }
    for (const environment of [
      { TOKEN: sentinel + '!plaintext' }, { TOKEN: '' }, { TOKEN: 'BAD-NAME' }, { 'BAD-NAME': 'TOKEN' },
      { TOKEN: 'SOURCE', token: 'OTHER_SOURCE' }, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`TOKEN_${i}`, `SOURCE_${i}`])),
    ]) assert.throws(() => f.store.upsert({ ...stdioBaseline, environment }), /配置无效/);
    assert.equal(f.store.list().connections.length, 0); assert.equal(fs.existsSync(f.file), false);
  } finally { f.dispose(); }
});

test('MCP stdio connections: missing and invalid environment values fail closed without reflecting or persisting secrets', () => {
  const f = fixture({ environment: { TOO_BIG: sentinel + 'x'.repeat(8192), NUL: sentinel + '\0', SOURCE: 'y'.repeat(8192) } });
  try {
    for (const environment of [{ TOKEN: 'MISSING' }, { TOKEN: 'TOO_BIG' }, { TOKEN: 'NUL' }, { A: 'SOURCE', B: 'SOURCE', C: 'SOURCE', D: 'SOURCE' }] as Record<string, string>[]) {
      const created = f.store.upsert({ ...stdioBaseline, environment });
      assert.equal(created.ready, false);
      assert.throws(() => f.store.resolve(created.id), error => error instanceof Error && !error.message.includes(sentinel));
    }
    assert.ok(!JSON.stringify(f.store.list()).includes(sentinel)); assert.ok(!fs.readFileSync(f.file, 'utf8').includes(sentinel));
  } finally { f.dispose(); }
});

test('MCP stdio connections: transport changes obey revision/active locks and remove obsolete HTTP credentials', () => {
  let active = false;
  const f = fixture({ isConnectionActive: () => active });
  try {
    const initial = f.store.upsert(baseline);
    const authenticated = f.store.setCredential({ id: initial.id, revision: initial.revision, mode: 'memory', secret: sentinel });
    const transition = { ...stdioBaseline, id: initial.id, revision: authenticated.revision };
    active = true;
    assert.throws(() => f.store.upsert(transition), /运行/);
    assert.equal(resolveHttp(f.store, initial.id).bearerToken, sentinel);
    active = false;
    const changed = f.store.upsert(transition), before = fs.readFileSync(f.file, 'utf8');
    assert.equal(changed.revision, authenticated.revision + 1); assert.equal(changed.transport, 'stdio');
    assert.equal(f.credentials.get(`native-mcp:${initial.id}`), undefined);
    assert.throws(() => f.store.setCredential({ id: changed.id, revision: changed.revision, mode: 'memory', secret: sentinel }), /stdio/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
    assert.throws(() => f.store.upsert(transition), /已更新/);
    active = true;
    assert.throws(() => f.store.upsert({ ...editStdio(changed), argv: ['other.mjs'] }), /运行/);
    assert.throws(() => f.store.remove({ id: changed.id, revision: changed.revision }), /运行/);
    active = false;
    const httpAgain = f.store.upsert({ ...baseline, id: changed.id, revision: changed.revision, auth: { mode: 'memory' } });
    assert.equal(httpAgain.transport, 'http'); assert.equal(httpAgain.ready, false);
  } finally { f.dispose(); }
});

test('MCP stdio connections: incompatible persisted transport records stay untouched and fail closed', () => {
  for (const patch of [
    { transport: 'future' }, { protocolVersion: '2026-07-28' }, { executable: 'node' },
    { ciphertext: Buffer.from(sentinel).toString('base64') }, { environment: { NODE_OPTIONS: 'SOURCE' } },
    { environment: { TOKEN: sentinel + '!plaintext' } }, { argv: ['bad\0argument'] }, { cwd: '/tmp' },
  ]) {
    const f = fixture();
    try {
      const source = JSON.stringify({ schemaVersion: 1, connections: [{ ...stdioBaseline, id: 'one', revision: 1, ...patch }] });
      fs.mkdirSync(path.dirname(f.file), { recursive: true }); fs.writeFileSync(f.file, source);
      const restarted = new NativeMcpConnectionStore(f.directory, new NativeCredentialStore());
      assert.match(restarted.list().error!, /损坏/); assert.equal(restarted.list().connections.length, 0);
      assert.ok(!JSON.stringify(restarted.list()).includes(sentinel)); assert.equal(fs.readFileSync(f.file, 'utf8'), source);
      assert.throws(() => restarted.upsert(stdioBaseline), /损坏/);
    } finally { f.dispose(); }
  }
});
