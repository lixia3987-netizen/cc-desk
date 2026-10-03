import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeModelImporter, parseClaudeModelConfig } from '../src/main/claude-model-import';
import { ConnectionStore, type NativeConnectionStoreOptions } from '../src/main/engines/native/connections';
import { StateStore } from '../src/main/store';
import { registerClaudeModelImportHandlers } from '../src/main/ipc/claude-model-import-handlers';
import type { ClaudeModelImportOptions } from '../src/main/claude-model-import';
import type { ClaudeModelImportPreview } from '../src/shared/claude-model-import';

const secret = 'sk-FICTIONAL-import-secret-never-display-123456789';
const otherSecret = 'sk-FICTIONAL-other-unused-secret-987654321';
const model = 'claude-sonnet-fictional-model';
const source = { model, env: { ANTHROPIC_API_KEY: secret, ANTHROPIC_BASE_URL: 'https://example.test/anthropic' } };
const sourcePath = path.join(os.tmpdir(), 'fictional-claude-settings.json');
function noSecrets(value: unknown): void { for (const key of [secret, otherSecret]) assert.ok(!JSON.stringify(value).includes(key)); }
function fixture(options: ClaudeModelImportOptions = {}, connectionsOptions: NativeConnectionStoreOptions = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-desk-claude-import-'));
  const configDirectory = path.join(directory, 'claude');
  fs.mkdirSync(configDirectory);
  const file = path.join(configDirectory, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(source));
  const state = new StateStore(directory), connections = new ConnectionStore(directory, connectionsOptions);
  const importer = new ClaudeModelImporter(connections, { environment: { CLAUDE_CONFIG_DIR: configDirectory }, ...options });
  return { directory, file, state, connections, importer, dispose: () => { importer.dispose(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('Claude import parser resolves mapped aliases, deduplicates models and obeys model precedence', () => {
  const parsed = parseClaudeModelConfig({ model: 'opus', env: {
    ANTHROPIC_MODEL: 'sonnet', ANTHROPIC_DEFAULT_MODEL: 'fallback-model',
    ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-concrete',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-concrete', ANTHROPIC_SMALL_FAST_MODEL: 'haiku-concrete',
    ANTHROPIC_API_KEY: otherSecret, ANTHROPIC_AUTH_TOKEN: secret,
  } }, sourcePath);
  assert.equal(parsed.preview.model, model);
  assert.equal(parsed.preview.modelSource, 'env.ANTHROPIC_MODEL');
  assert.equal(parsed.preview.baseURL, 'https://api.anthropic.com');
  assert.equal(parsed.preview.models.length, 4);
  assert.deepEqual(parsed.preview.models.find(item => item.model === model)?.sources, ['env.ANTHROPIC_MODEL', 'env.ANTHROPIC_DEFAULT_SONNET_MODEL']);
  assert.deepEqual(parsed.preview.models.find(item => item.model === 'haiku-concrete')?.sources, ['env.ANTHROPIC_DEFAULT_HAIKU_MODEL', 'env.ANTHROPIC_SMALL_FAST_MODEL']);
  assert.ok(parsed.preview.models.every(item => item.nativeImportable));
  assert.equal(parsed.secret, secret);
  assert.equal(parsed.authHeader, 'authorization');
  assert.deepEqual(parsed.preview.credential, { configured: true, source: 'ANTHROPIC_AUTH_TOKEN' });
  noSecrets(parsed.preview);
  assert.equal(parseClaudeModelConfig({ model, env: { ANTHROPIC_DEFAULT_MODEL: 'fallback' } }, sourcePath).preview.model, model);
  assert.equal(parseClaudeModelConfig({ env: { ANTHROPIC_DEFAULT_MODEL: 'fallback' } }, sourcePath).preview.model, 'fallback');
});

test('Claude import parser only reads own known fields and never executes key helpers or exposes arbitrary source fields', () => {
  const malicious = JSON.parse('{"model":"' + model + '","env":{"ANTHROPIC_API_KEY":"' + secret + '","__proto__":{"ANTHROPIC_AUTH_TOKEN":"evil"},"OTHER_KEY":"' + otherSecret + '"},"__proto__":{"polluted":true},"apiKeyHelper":"run-command-with-' + secret + '","hooks":{"arbitrary":"' + secret + '"}}');
  const parsed = parseClaudeModelConfig(malicious, sourcePath);
  assert.equal(parsed.secret, secret);
  assert.equal(parsed.authHeader, 'x-api-key');
  assert.ok(parsed.preview.warnings.some(item => item.includes('未执行')));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  noSecrets(parsed.preview);
  assert.equal(Object.hasOwn(parsed.preview, 'apiKeyHelper'), false);
});

test('Claude import maps fable only when concrete mapping exists and retains custom model candidates', () => {
  const mapped = parseClaudeModelConfig({ model: 'sonnet', env: {
    ANTHROPIC_MODEL: 'fable', ANTHROPIC_DEFAULT_FABLE_MODEL: 'fable-concrete-model', ANTHROPIC_CUSTOM_MODEL_OPTION: 'gateway-custom-model',
  } }, sourcePath).preview;
  assert.equal(mapped.model, 'fable-concrete-model');
  assert.equal(mapped.modelSource, 'env.ANTHROPIC_MODEL');
  assert.deepEqual(mapped.models.find(item => item.model === 'fable-concrete-model'), {
    model: 'fable-concrete-model', sources: ['env.ANTHROPIC_MODEL', 'env.ANTHROPIC_DEFAULT_FABLE_MODEL'], nativeImportable: true,
  });
  assert.deepEqual(mapped.models.find(item => item.model === 'gateway-custom-model'), {
    model: 'gateway-custom-model', sources: ['env.ANTHROPIC_CUSTOM_MODEL_OPTION'], nativeImportable: true,
  });
  const unmapped = parseClaudeModelConfig({ model: 'fable', env: { ANTHROPIC_CUSTOM_MODEL_OPTION: 'gateway-custom-model' } }, sourcePath).preview;
  assert.equal(unmapped.model, 'fable');
  assert.equal(unmapped.models.find(item => item.model === 'fable')?.nativeImportable, false);
  assert.ok(unmapped.warnings.some(warning => warning.includes('模型别名')));
  assert.equal(parseClaudeModelConfig({ env: { ANTHROPIC_CUSTOM_MODEL_OPTION: 'gateway-custom-model' } }, sourcePath).preview.model, 'gateway-custom-model');
});

test('Claude import parser redacts credential-bearing model/path fields and rejects credential-bearing URLs with fixed messages', () => {
  const parsed = parseClaudeModelConfig({ model: secret, env: { ANTHROPIC_API_KEY: secret, ANTHROPIC_AUTH_TOKEN: otherSecret,
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'model-' + otherSecret } }, path.join(os.tmpdir(), secret + '.json'));
  assert.deepEqual(parsed.preview.models, []);
  assert.equal(parsed.preview.model, undefined);
  assert.match(parsed.preview.sourcePath, /已隐藏/);
  noSecrets(parsed.preview);
  for (const baseURL of ['https://example.test/' + secret, 'https://' + secret + '@example.test', 'https://example.test?key=' + otherSecret, 'https://example.test#secret', 'file:///somewhere', 'http://example.test', 'http://localhost.evil.test:9876']) {
    assert.throws(() => parseClaudeModelConfig({ ...source, env: { ...source.env, ANTHROPIC_AUTH_TOKEN: otherSecret, ANTHROPIC_BASE_URL: baseURL } }, sourcePath), error => error instanceof Error && !error.message.includes(secret) && !error.message.includes(otherSecret));
  }
});

test('Claude import parser validates known field types and lengths without returning attacker values', () => {
  for (const invalid of [null, [], { env: [] }, { model: 123 }, { model: 'line\nbreak' }, { model: 'invalid model' }, { model: 'a'.repeat(201) }, { env: { ANTHROPIC_API_KEY: { secret } } }, { env: { ANTHROPIC_AUTH_TOKEN: secret + '\n' } }]) {
    assert.throws(() => parseClaudeModelConfig(invalid, sourcePath), error => error instanceof Error && !error.message.includes(secret));
  }
  const noCredential = parseClaudeModelConfig({ model: 'sonnet' }, sourcePath);
  assert.equal(noCredential.preview.credential.configured, false);
  assert.equal(noCredential.preview.models[0].nativeImportable, false);
  assert.match(noCredential.preview.warnings.join(' '), /登录状态/);
});

test('Claude import default/file previews read bounded JSON without changing configuration or workspace', async () => {
  let chosen = 0;
  const f = fixture({ chooseFile: async () => { chosen++; return f.file; } });
  try {
    const before = fs.readFileSync(f.file, 'utf8');
    const preview = await f.importer.preview({ source: 'default' });
    assert.equal(preview?.sourcePath, f.file);
    assert.match(preview!.token, /^[a-f0-9-]{36}$/);
    assert.equal(preview?.model, model);
    assert.equal(chosen, 0);
    noSecrets(preview);
    assert.equal((await f.importer.preview({ source: 'file' }))?.model, model);
    assert.equal(chosen, 1);
    assert.equal(f.connections.list().connections.length, 0);
    assert.equal(f.state.state.settings.engineDefaults.claude, undefined);
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  } finally { f.dispose(); }
});

test('Claude import missing/unreadable/oversized/invalid JSON use fixed errors and cancelled picker has no effect', async () => {
  const f = fixture({ chooseFile: async () => null });
  try {
    assert.equal(await f.importer.preview({ source: 'file' }), null);
    for (const value of ['{broken-with-' + secret, ' '.repeat(1024 * 1024 + 1)]) {
      fs.writeFileSync(f.file, value);
      await assert.rejects(f.importer.preview({ source: 'default' }), error => error instanceof Error && !error.message.includes(secret));
    }
    fs.unlinkSync(f.file);
    await assert.rejects(f.importer.preview({ source: 'default' }), /无法读取/);
    assert.equal(f.connections.list().connections.length, 0);
  } finally { f.dispose(); }
});

test('Claude import uses default home directory and accepts UTF-8 BOM', async () => {
  const f = fixture();
  const importer = new ClaudeModelImporter(f.connections, { environment: {}, homeDirectory: f.directory });
  try {
    fs.mkdirSync(path.join(f.directory, '.claude'));
    fs.writeFileSync(path.join(f.directory, '.claude', 'settings.json'), '\uFEFF' + JSON.stringify({ model }));
    assert.equal((await importer.preview({ source: 'default' }))?.model, model);
  } finally { importer.dispose(); f.dispose(); }
});

test('Claude Native import atomically creates a new Anthropic connection with a main-only memory key and single-use token', async () => {
  const f = fixture();
  try {
    const previous = f.connections.upsert({ name: 'Existing', protocol: 'responses', baseURL: 'https://example.test/v1', model: 'existing', allowLoopbackHttp: false, enabled: true, auth: { mode: 'memory' } });
    const preview = (await f.importer.preview({ source: 'default' }))!;
    const result = f.importer.import({ token: preview.token });
    assert.equal(result.connection?.protocol, 'anthropic');
    assert.equal(result.connection?.authHeader, 'x-api-key');
    assert.equal(result.connection?.revision, 1);
    assert.equal(result.connection?.ready, true);
    assert.equal(f.connections.resolve(result.connection!.id).apiKey, secret);
    assert.deepEqual(f.connections.list().connections.find(item => item.id === previous.id), previous);
    noSecrets(result); noSecrets(f.connections.list());
    assert.ok(!fs.readFileSync(path.join(f.directory, 'native', 'connections.json'), 'utf8').includes(secret));
    assert.equal(fs.readFileSync(f.file, 'utf8'), JSON.stringify(source));
    assert.throws(() => f.importer.import({ token: preview.token }), /过期或已使用/);
    assert.equal(f.connections.list().connections.length, 2);
  } finally { f.dispose(); }
});

test('Claude Native import selects Bearer authentication for AUTH_TOKEN and supports missing credentials without reading OAuth', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.file, JSON.stringify({ model, env: { ANTHROPIC_AUTH_TOKEN: secret } }));
    let preview = (await f.importer.preview({ source: 'default' }))!;
    const tokenConnection = f.importer.import({ token: preview.token }).connection!;
    assert.equal(tokenConnection.authHeader, 'authorization');
    fs.writeFileSync(f.file, JSON.stringify({ model }));
    fs.writeFileSync(path.join(f.directory, '.claude.json'), JSON.stringify({ oauthAccount: { accessToken: otherSecret } }));
    preview = (await f.importer.preview({ source: 'default' }))!;
    const result = f.importer.import({ token: preview.token });
    assert.equal(result.connection?.ready, false);
    assert.equal(result.connection?.credentialConfigured, false);
    assert.match(result.notice!, /不会被读取/);
    noSecrets(result);
  } finally { f.dispose(); }
});

test('Native model import preserves the complete workspace including Claude defaults, permissions and terminal paths', async () => {
  const f = fixture();
  try {
    f.state.change(draft => {
      draft.settings.claudePath = 'existing-cli'; draft.settings.shellPath = 'existing-shell';
      draft.settings.engineDefaults.claude = { schemaVersion: 1, options: { model: 'before', effort: 'high', permissionMode: 'plan' } };
      draft.settings.engineDefaults.other = { schemaVersion: 1, options: { model: 'other' } };
    });
    const before = structuredClone(f.state.state);
    const beforeDisk = fs.readFileSync(f.state.file, 'utf8');
    const preview = (await f.importer.preview({ source: 'default' }))!;
    const result = f.importer.import({ token: preview.token });
    assert.equal(result.model, model);
    assert.equal(result.connection.protocol, 'anthropic');
    assert.deepEqual(f.state.state, before);
    assert.equal(fs.readFileSync(f.state.file, 'utf8'), beforeDisk);
    assert.equal(f.connections.list().connections.length, 1);
    noSecrets(f.state.state);
    assert.ok(!fs.readFileSync(f.state.file, 'utf8').includes(secret));
  } finally { f.dispose(); }
});

test('failed Native imports and legacy Claude-target IPC requests leave workspace settings and source files unchanged', async () => {
  const f = fixture(), handlers = new Map<string, (input: unknown) => unknown>();
  try {
    f.state.change(draft => {
      draft.settings.claudePath = 'existing-claude-cli'; draft.settings.shellPath = 'existing-terminal';
      draft.settings.engineDefaults.claude = { schemaVersion: 1, options: { model: 'existing-claude-model', effort: 'high', permissionMode: 'plan' } };
      draft.settings.engineDefaults.native = { schemaVersion: 1, options: { connectionId: 'existing-native-connection', model: 'existing-native-model' } };
    });
    const beforeState = structuredClone(f.state.state), beforeDisk = fs.readFileSync(f.state.file, 'utf8'), beforeSource = fs.readFileSync(f.file, 'utf8');
    const unchanged = () => {
      assert.deepEqual(f.state.state, beforeState);
      assert.equal(fs.readFileSync(f.state.file, 'utf8'), beforeDisk);
      assert.equal(fs.readFileSync(f.file, 'utf8'), beforeSource);
    };
    registerClaudeModelImportHandlers((name, schema, action) => handlers.set(name, input => action(schema.parse(input))), f.importer);
    let preview = (await f.importer.preview({ source: 'default' }))!;
    assert.throws(() => handlers.get('claude:model-import')!({ token: preview.token, mode: 'claude' }), /请求格式无效/);
    assert.throws(() => handlers.get('claude:model-import')!({ token: preview.token, mode: 'native' }), /请求格式无效/);
    assert.equal(f.connections.list().connections.length, 0); unchanged();
    assert.throws(() => f.importer.import({ token: preview.token, model: 'unlisted-model' }), /有效的模型/);
    assert.equal(f.connections.list().connections.length, 0); unchanged();
    preview = (await f.importer.preview({ source: 'default' }))!;
    assert.throws(() => f.importer.import({ token: preview.token, credentialMode: 'encrypted' }), /安全存储/);
    assert.equal(f.connections.list().connections.length, 0); unchanged();
    preview = (await f.importer.preview({ source: 'default' }))!;
    const result = handlers.get('claude:model-import')!({ token: preview.token });
    noSecrets(result); assert.equal(f.connections.list().connections.length, 1); unchanged();
  } finally { f.dispose(); }
});

test('Claude import tokens expire, cap retained previews, and permit only models from that preview', async () => {
  let now = Date.now();
  const f = fixture({ now: () => now });
  try {
    const expired = (await f.importer.preview({ source: 'default' }))!;
    now += 5 * 60 * 1000;
    assert.throws(() => f.importer.import({ token: expired.token }), /过期/);
    const previews: ClaudeModelImportPreview[] = [];
    for (let index = 0; index < 11; index++) previews.push((await f.importer.preview({ source: 'default' }))!);
    assert.throws(() => f.importer.import({ token: previews[0].token }), /过期/);
    assert.throws(() => f.importer.import({ token: previews[10].token, model: secret }), error => error instanceof Error && !error.message.includes(secret));
    assert.throws(() => f.importer.import({ token: previews[10].token }), /已使用/);
    assert.equal(f.connections.list().connections.length, 0);
  } finally { f.dispose(); }
});

test('Claude imports fail atomically for unmapped aliases and unavailable encryption', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.file, JSON.stringify({ model: 'sonnet', env: { ANTHROPIC_API_KEY: secret } }));
    let preview = (await f.importer.preview({ source: 'default' }))!;
    assert.throws(() => f.importer.import({ token: preview.token }), /别名/);
    assert.equal(f.connections.list().connections.length, 0);
    fs.writeFileSync(f.file, JSON.stringify(source));
    const before = structuredClone(f.state.state);
    preview = (await f.importer.preview({ source: 'default' }))!;
    assert.throws(() => f.importer.import({ token: preview.token, credentialMode: 'encrypted' }), /安全存储/);
    assert.deepEqual(f.state.state, before);
    assert.equal(f.connections.list().connections.length, 0);
    assert.equal(fs.existsSync(path.join(f.directory, 'native', 'connections.json')), false);
    assert.throws(() => f.importer.import({ token: preview.token }), /已使用/);
  } finally { f.dispose(); }
});

test('Claude import requires explicit loopback HTTP permission and rejects remote HTTP', async () => {
  const f = fixture();
  try {
    for (const baseURL of ['http://localhost:9876', 'http://127.0.0.1:9876', 'http://[::1]:9876']) {
      fs.writeFileSync(f.file, JSON.stringify({ model, env: { ANTHROPIC_BASE_URL: baseURL, ANTHROPIC_API_KEY: secret } }));
      let preview = (await f.importer.preview({ source: 'default' }))!;
      assert.equal(preview.requiresLoopbackHttp, true);
      const before = f.connections.list().connections.length;
      assert.throws(() => f.importer.import({ token: preview.token }), /明确勾选/);
      assert.equal(f.connections.list().connections.length, before);
      preview = (await f.importer.preview({ source: 'default' }))!;
      const result = f.importer.import({ token: preview.token, allowLoopbackHttp: true });
      assert.equal(result.connection?.baseURL, baseURL);
      assert.equal(result.connection?.allowLoopbackHttp, true);
      assert.equal(result.connection?.ready, true);
    }
    fs.writeFileSync(f.file, JSON.stringify({ model, env: { ANTHROPIC_BASE_URL: 'http://remote.example.test' } }));
    await assert.rejects(f.importer.preview({ source: 'default' }), /地址无效/);
  } finally { f.dispose(); }
});

test('Claude imports sanitize encryption exceptions and do not overwrite existing connections', async () => {
  const f = fixture({}, { platform: 'win32', safeStorage: {
    isEncryptionAvailable: () => true, encryptString: () => { throw new Error(secret); }, decryptString: () => { throw new Error(otherSecret); },
  } });
  try {
    f.connections.upsert({ name: 'Existing', protocol: 'responses', baseURL: 'https://example.test', model, allowLoopbackHttp: false, enabled: true, auth: { mode: 'memory' } });
    const file = path.join(f.directory, 'native', 'connections.json'), before = fs.readFileSync(file, 'utf8');
    const preview = (await f.importer.preview({ source: 'default' }))!;
    assert.throws(() => f.importer.import({ token: preview.token, credentialMode: 'encrypted' }), error => error instanceof Error && !error.message.includes(secret));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(f.connections.list().connections.length, 1);
  } finally { f.dispose(); }
});

test('Claude import encrypted credential is committed once, persists across restart, and never crosses IPC', async () => {
  const safeStorage = {
    isEncryptionAvailable: () => true,
    // A deterministic fake OS vault keeps the fixture secret out of its serialized representation.
    encryptString: (value: string) => Buffer.from(Buffer.from(value, 'utf8').map(byte => byte ^ 0x5a)),
    decryptString: (value: Buffer) => Buffer.from(Buffer.from(value).map(byte => byte ^ 0x5a)).toString('utf8'),
  };
  const f = fixture({}, { platform: 'win32', safeStorage });
  try {
    const preview = (await f.importer.preview({ source: 'default' }))!;
    const result = f.importer.import({ token: preview.token, credentialMode: 'encrypted' });
    assert.equal(result.connection?.revision, 1);
    assert.equal(result.connection?.auth.mode, 'encrypted');
    assert.equal(result.connection?.ready, true);
    const restarted = new ConnectionStore(f.directory, { platform: 'win32', safeStorage });
    assert.equal(restarted.resolve(result.connection!.id).apiKey, secret);
    const persisted = fs.readFileSync(path.join(f.directory, 'native', 'connections.json'), 'utf8');
    assert.ok(persisted.includes('ciphertext')); assert.ok(!persisted.includes(secret));
    noSecrets(preview); noSecrets(result); noSecrets(restarted.list());
  } finally { f.dispose(); }
});

test('Claude import disk failure leaves the old connection file and in-memory connections unchanged', async () => {
  const f = fixture();
  try {
    f.connections.upsert({ name: 'Existing', protocol: 'responses', baseURL: 'https://example.test', model, allowLoopbackHttp: false, enabled: true, auth: { mode: 'memory' } });
    const file = path.join(f.directory, 'native', 'connections.json'), beforeFile = fs.readFileSync(file, 'utf8');
    const beforeConnections = f.connections.list();
    const preview = (await f.importer.preview({ source: 'default' }))!;
    const rename = fs.renameSync;
    try {
      fs.renameSync = () => { throw new Error(secret); };
      assert.throws(() => f.importer.import({ token: preview.token }), error => error instanceof Error && !error.message.includes(secret));
    } finally { fs.renameSync = rename; }
    assert.deepEqual(f.connections.list(), beforeConnections);
    assert.equal(fs.readFileSync(file, 'utf8'), beforeFile);
    assert.equal(fs.readdirSync(path.dirname(file)).some(entry => entry.endsWith('.tmp')), false);
  } finally { f.dispose(); }
});

test('Claude import IPC strictly accepts source/token metadata and never accepts renderer paths or secrets', async () => {
  const f = fixture(), handlers = new Map<string, (input: unknown) => unknown>();
  try {
    registerClaudeModelImportHandlers((name, schema, action) => handlers.set(name, input => action(schema.parse(input))), f.importer);
    for (const input of [{ source: 'default', path: secret }, { source: 'file', [secret]: otherSecret }, { source: 'other' }]) {
      assert.throws(() => handlers.get('claude:model-import-preview')!(input), error => error instanceof Error && !error.message.includes(secret));
    }
    const preview = await handlers.get('claude:model-import-preview')!({ source: 'default' }) as ClaudeModelImportPreview;
    noSecrets(preview);
    assert.throws(() => handlers.get('claude:model-import')!({ token: preview.token, secret }), error => error instanceof Error && !error.message.includes(secret));
    const result = handlers.get('claude:model-import')!({ token: preview.token });
    noSecrets(result);
    assert.deepEqual([...handlers.keys()].sort(), ['claude:model-import', 'claude:model-import-preview']);
  } finally { f.dispose(); }
});
