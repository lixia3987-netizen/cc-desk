import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ConnectionStore, validateNativeBaseURL, type NativeConnectionStoreOptions } from '../src/main/engines/native/connections';
import type { NativeSafeStorage } from '../src/main/engines/native/credentials';
import { registerNativeHandlers } from '../src/main/ipc/native-handlers';
import type { NativeConnectionInput, NativeConnectionView } from '../src/shared/native-connections';

const sentinel = 'sk-native-SENTINEL-that-must-never-leak-123456789';
const baseline: NativeConnectionInput = { name: '本机连接', protocol: 'responses', baseURL: 'https://example.test/v1', model: 'test-model', allowLoopbackHttp: false, enabled: true, auth: { mode: 'memory' } };
function fixture(options: NativeConnectionStoreOptions = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-desk-native-connections-'));
  return { directory, file: path.join(directory, 'native', 'connections.json'), store: new ConnectionStore(directory, options), dispose: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
function edit(item: NativeConnectionView): NativeConnectionInput {
  const { credentialConfigured: _configured, ready: _ready, error: _error, ...value } = item;
  return value;
}
function storage(backend = 'gnome_libsecret', available = true): NativeSafeStorage {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
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

test('native connections: memory secret is main-only, immutable per run, and absent after restart', () => {
  const f = fixture();
  try {
    const created = f.store.upsert(baseline);
    assert.equal(created.ready, false);
    const saved = f.store.setCredential({ id: created.id, revision: created.revision, mode: 'memory', secret: sentinel });
    const resolved = f.store.resolve(saved.id, 'override-model');
    assert.equal(resolved.apiKey, sentinel);
    assert.equal(resolved.model, 'override-model');
    assert.equal(resolved.redirect, 'error');
    assert.ok(Object.isFrozen(resolved));
    assert.equal(resolved.revision, 2);
    const changed = f.store.upsert({ ...edit(saved), model: 'next-model' });
    assert.equal(changed.revision, 3);
    assert.equal(resolved.model, 'override-model');
    for (const value of [saved, f.store.list(), f.store.readiness(saved.id)]) assert.ok(!JSON.stringify(value).includes(sentinel));
    const disk = fs.readFileSync(f.file, 'utf8');
    assert.ok(!disk.includes(sentinel));
    assert.ok(!disk.includes('ciphertext'));
    assert.equal(new ConnectionStore(f.directory).readiness(saved.id).ready, false);
    if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  } finally { f.dispose(); }
});

test('native connections: env values are resolved in main only and one missing key does not disable another connection', () => {
  const f = fixture({ environment: { NATIVE_TEST_KEY: sentinel } });
  try {
    const good = f.store.upsert({ ...baseline, auth: { mode: 'env', variable: 'NATIVE_TEST_KEY' } });
    const missing = f.store.upsert({ ...baseline, auth: { mode: 'env', variable: 'MISSING_TEST_KEY' } });
    assert.equal(f.store.resolve(good.id).apiKey, sentinel);
    assert.equal(f.store.readiness(good.id).ready, true);
    assert.equal(f.store.readiness(missing.id).ready, false);
    assert.ok(!JSON.stringify(f.store.list()).includes(sentinel));
    assert.ok(!fs.readFileSync(f.file, 'utf8').includes(sentinel));
    assert.match(fs.readFileSync(f.file, 'utf8'), /NATIVE_TEST_KEY/);
  } finally { f.dispose(); }
});

test('native connections: verified OS storage survives restart without returning ciphertext or plaintext', () => {
  const safeStorage = storage(), f = fixture({ safeStorage, platform: 'linux' });
  try {
    const created = f.store.upsert(baseline);
    const saved = f.store.setCredential({ id: created.id, revision: created.revision, mode: 'encrypted', secret: sentinel });
    const restarted = new ConnectionStore(f.directory, { safeStorage, platform: 'linux' });
    assert.equal(restarted.resolve(saved.id).apiKey, sentinel);
    const view = JSON.stringify(restarted.list()), disk = fs.readFileSync(f.file, 'utf8');
    assert.ok(!view.includes(sentinel)); assert.ok(!view.includes('ciphertext'));
    assert.ok(!disk.includes(sentinel)); assert.ok(disk.includes('ciphertext'));
    assert.equal(restarted.list().storage.persistentAvailable, true);
    const unprotected = new ConnectionStore(f.directory, { safeStorage: { ...safeStorage, getSelectedStorageBackend: () => 'basic_text' }, platform: 'linux' });
    assert.equal(unprotected.readiness(saved.id).ready, false);
    assert.throws(() => unprotected.resolve(saved.id), /保护/);
  } finally { f.dispose(); }
});

test('native connections: unknown/basic_text/unavailable OS storage rejects persistent secrets without writing', () => {
  for (const safeStorage of [undefined, storage('basic_text'), storage('unknown'), storage('future-backend'), storage('gnome_libsecret', false), { ...storage(), getSelectedStorageBackend: undefined }]) {
    const f = fixture({ safeStorage, platform: 'linux' });
    try {
      const connection = f.store.upsert(baseline), before = fs.readFileSync(f.file, 'utf8');
      assert.equal(f.store.list().storage.persistentAvailable, false);
      assert.throws(() => f.store.setCredential({ id: connection.id, revision: connection.revision, mode: 'encrypted', secret: sentinel }));
      assert.equal(fs.readFileSync(f.file, 'utf8'), before);
      assert.equal(f.store.list().connections[0].revision, connection.revision);
      assert.equal(f.store.setCredential({ id: connection.id, revision: connection.revision, mode: 'memory', secret: sentinel }).ready, true);
    } finally { f.dispose(); }
  }
});

test('native connections: OS exceptions cannot reflect secret material to IPC or readiness', () => {
  const safeStorage = storage(), f = fixture({ safeStorage: { ...safeStorage, encryptString: () => { throw new Error(sentinel); } }, platform: 'linux' });
  try {
    const created = f.store.upsert(baseline);
    assert.throws(() => f.store.setCredential({ id: created.id, revision: created.revision, mode: 'encrypted', secret: sentinel }), error => error instanceof Error && !error.message.includes(sentinel));
    const writer = new ConnectionStore(f.directory, { safeStorage, platform: 'linux' });
    writer.setCredential({ id: created.id, revision: created.revision, mode: 'encrypted', secret: sentinel });
    const broken = new ConnectionStore(f.directory, { safeStorage: { ...safeStorage, decryptString: () => { throw new Error(sentinel); } }, platform: 'linux' });
    assert.equal(broken.readiness(created.id).ready, false);
    assert.ok(!JSON.stringify(broken.list()).includes(sentinel));
  } finally { f.dispose(); }
});

test('native connections: active mutation, stale revisions, and deletion of referenced connections are blocked', () => {
  let active = false, referenced = true;
  const f = fixture({ isConnectionActive: () => active, isConnectionReferenced: () => referenced });
  try {
    const created = f.store.upsert(baseline), before = fs.readFileSync(f.file, 'utf8');
    active = true;
    assert.throws(() => f.store.upsert({ ...edit(created), name: 'changed' }), /运行/);
    assert.throws(() => f.store.setCredential({ id: created.id, revision: created.revision, mode: 'memory', secret: sentinel }), /运行/);
    assert.throws(() => f.store.remove({ id: created.id, revision: created.revision }), /运行/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
    active = false;
    assert.throws(() => f.store.remove({ id: created.id, revision: created.revision }), /已有会话/);
    const disabled = f.store.upsert({ ...edit(created), enabled: false });
    assert.equal(disabled.ready, false);
    assert.throws(() => f.store.upsert(edit(created)), /已更新/);
    assert.throws(() => f.store.remove({ id: created.id, revision: created.revision }), /已更新/);
    referenced = false;
    f.store.remove({ id: disabled.id, revision: disabled.revision });
    assert.equal(f.store.list().connections.length, 0);
  } finally { f.dispose(); }
});

test('native connections: corrupt, future, duplicate and credential-bearing config files fail closed and stay intact', () => {
  const cases: unknown[] = ['{broken', { schemaVersion: 2, connections: [] }, { schemaVersion: 1, connections: [{ ...baseline, id: 'one', revision: 1, apiKey: sentinel }] }, { schemaVersion: 1, connections: [1, 2].map(() => ({ ...baseline, id: 'same', revision: 1 })) }];
  for (const bad of cases) {
    const f = fixture();
    try {
      fs.mkdirSync(path.dirname(f.file), { recursive: true });
      const source = typeof bad === 'string' ? bad : JSON.stringify(bad);
      fs.writeFileSync(f.file, source);
      const store = new ConnectionStore(f.directory);
      assert.equal(store.list().connections.length, 0);
      assert.match(store.list().error!, /损坏/);
      assert.ok(!JSON.stringify(store.list()).includes(sentinel));
      assert.throws(() => store.upsert(baseline), /损坏/);
      assert.throws(() => store.resolve('one'), /损坏/);
      assert.equal(fs.readFileSync(f.file, 'utf8'), source);
    } finally { f.dispose(); }
  }
});

test('native connections: credentials and remote HTTP are rejected, local HTTP is explicit, redirects are disallowed', () => {
  for (const url of ['https://user:password@example.test/v1', 'https://user@example.test', 'https://@example.test', 'https://example.test?api_key=' + sentinel, 'https://example.test#token', 'file:///tmp/test', 'http://example.test', 'https://example.test\\@attacker.test', 'http://localhost.evil.test']) {
    assert.throws(() => validateNativeBaseURL(url, true), error => error instanceof Error && !error.message.includes(sentinel));
  }
  for (const url of ['http://localhost:9999/v1', 'http://127.0.0.1:9999/v1', 'http://[::1]:9999/v1']) {
    assert.throws(() => validateNativeBaseURL(url, false));
    assert.equal(validateNativeBaseURL(url, true), url);
  }
});

test('native connections IPC: separate write-only mutation has no credential read route and errors do not echo input', () => {
  const f = fixture(), handlers = new Map<string, (input?: unknown) => unknown>();
  try {
    registerNativeHandlers((name, schema, action) => { handlers.set(name, input => action(schema.parse(input))); }, f.store);
    const created = handlers.get('native:connections-upsert')!(baseline) as NativeConnectionView;
    const result = handlers.get('native:connections-credential')!({ id: created.id, revision: created.revision, mode: 'memory', secret: sentinel });
    assert.ok(!JSON.stringify(result).includes(sentinel));
    assert.ok(!JSON.stringify(handlers.get('native:connections-list')!()).includes(sentinel));
    assert.deepEqual([...handlers.keys()].sort(), ['native:connections-credential', 'native:connections-list', 'native:connections-readiness', 'native:connections-remove', 'native:connections-upsert']);
    for (const malformed of [{ [sentinel]: 'extra' }, { id: created.id, revision: 2, mode: 'memory', secret: sentinel + '\n' }]) {
      assert.throws(() => handlers.get('native:connections-credential')!(malformed), error => error instanceof Error && !error.message.includes(sentinel));
    }
  } finally { f.dispose(); }
});
