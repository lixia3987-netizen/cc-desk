import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { RunIdentity } from '@cc-desk/agent-core';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeMcpConnectionStore } from '../src/main/engines/native/mcp-connections';
import { NativeCredentialStore, type NativeSafeStorage } from '../src/main/engines/native/credentials';
import { nativeAgentReceiptDirectory } from '../src/main/engines/native/agent-projection';
import { NativeAgentResultReadError, readNativeAgentResult } from '../src/main/engines/native/agent-results';
import type { NativeDelegationReceipt } from '../src/main/engines/native/agent-delegation';
import type { NativeConnectionInput } from '../src/shared/native-connections';
import type { NativeMcpConnectionInput } from '../src/shared/native-mcp';

const model: NativeConnectionInput = { name: 'credential protection fixture', protocol: 'responses', baseURL: 'https://fixture.invalid/v1', model: 'fixture-model',
  enabled: false, allowLoopbackHttp: false, auth: { mode: 'memory' } };
const mcp: NativeMcpConnectionInput = { name: 'credential protection fixture', transport: 'http', endpoint: 'https://fixture.invalid/mcp',
  enabled: false, allowLoopbackHttp: false, protocolVersion: '2026-07-28', auth: { mode: 'memory' } };
const newIdentity = (): RunIdentity => ({ sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 });
const secret = () => `fixture-private-${randomUUID()}`;
function temporary(t: { after(fn: () => void): void }): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-agent-result-credentials-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory;
}
function storage(): NativeSafeStorage {
  const key = randomBytes(32);
  return { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
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
function privateValues(values: readonly string[], expected: readonly string[]): void {
  for (const value of expected) assert.ok(values.includes(value), 'An existing credential was omitted from protection');
  assert.equal(values.length, new Set(expected).size);
  assert.equal(Object.isFrozen(values), true);
}
function publicValues(value: unknown, secrets: readonly string[]): void {
  const encoded = JSON.stringify(value);
  assert.ok(secrets.every(secret => !encoded.includes(secret)), 'Public metadata must not contain credential plaintext');
  assert.ok(!encoded.includes('ciphertext'), 'Public metadata must not contain encrypted blobs');
}

test('disabled model memory, encrypted and environment credentials remain protected without becoming ready', t => {
  const directory = temporary(t), safeStorage = storage(), secrets = [secret(), secret(), secret()];
  const environment = { MODEL_SECRET: secrets[2], DUPLICATE_SECRET: secrets[0] };
  const store = new ConnectionStore(directory, { safeStorage, platform: 'linux', environment });
  const memory = store.upsert(model), encrypted = store.upsert({ ...model, auth: { mode: 'encrypted' } });
  store.setCredential({ id: memory.id, revision: memory.revision, mode: 'memory', secret: secrets[0] });
  store.setCredential({ id: encrypted.id, revision: encrypted.revision, mode: 'encrypted', secret: secrets[1] });
  const env = store.upsert({ ...model, auth: { mode: 'env', variable: 'MODEL_SECRET' } });
  store.upsert({ ...model, auth: { mode: 'env', variable: 'DUPLICATE_SECRET' } });
  store.upsert({ ...model, auth: { mode: 'env', variable: 'MISSING_SECRET' } });
  const before = fs.readFileSync(path.join(directory, 'native', 'connections.json'));
  privateValues(store.protectedValues(), secrets);
  for (const id of [memory.id, encrypted.id, env.id]) assert.throws(() => store.resolve(id), /禁用/);
  publicValues(store.list(), secrets); assert.equal(store.list().connections.every(connection => !connection.ready), true);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'native', 'connections.json')), before);
  const snapshot = store.protectedValues(), rotated = secret(); environment.MODEL_SECRET = rotated;
  assert.ok(snapshot.includes(secrets[2])); assert.ok(!snapshot.includes(rotated));
  privateValues(store.protectedValues(), [secrets[0], secrets[1], rotated]);
});

test('diagnostic-locked models protect every credential mode and invalid-but-present environment values', t => {
  const directory = temporary(t), safeStorage = storage(), secrets = [secret(), secret(), secret(), `invalid credential ${secret()}`]; let testing = false;
  const store = new ConnectionStore(directory, { safeStorage, platform: 'linux', environment: { MODEL_SECRET: secrets[2], INVALID_SECRET: secrets[3] }, isConnectionTesting: () => testing });
  for (const [mode, value] of [['memory', secrets[0]], ['encrypted', secrets[1]]] as const) {
    const created = store.upsert({ ...model, enabled: true, auth: { mode } });
    store.setCredential({ id: created.id, revision: created.revision, mode, secret: value });
  }
  store.upsert({ ...model, enabled: true, auth: { mode: 'env', variable: 'MODEL_SECRET' } });
  store.upsert({ ...model, enabled: true, auth: { mode: 'env', variable: 'INVALID_SECRET' } });
  testing = true;
  for (const item of store.list().connections) { assert.equal(item.ready, false); assert.throws(() => store.resolve(item.id), /正在读取模型或测试/); }
  privateValues(store.protectedValues(), secrets); publicValues(store.list(), secrets);
});

test('disabled HTTP MCP credentials survive activity gates for all authentication modes', t => {
  const directory = temporary(t), safeStorage = storage(), secrets = [secret(), secret(), secret()]; let active = false;
  const credentials = new NativeCredentialStore(safeStorage, 'linux');
  const store = new NativeMcpConnectionStore(directory, credentials, { environment: { MCP_SECRET: secrets[2] }, isConnectionActive: () => active });
  for (const [mode, value] of [['memory', secrets[0]], ['encrypted', secrets[1]]] as const) {
    const created = store.upsert({ ...mcp, auth: { mode } }); store.setCredential({ id: created.id, revision: created.revision, mode, secret: value });
  }
  store.upsert({ ...mcp, auth: { mode: 'env', variable: 'MCP_SECRET' } });
  store.upsert({ ...mcp, auth: { mode: 'env', variable: 'MISSING_SECRET' } });
  store.upsert({ ...mcp, auth: { mode: 'none' } });
  active = true;
  privateValues(store.protectedValues(), secrets); publicValues(store.list(), secrets);
  for (const item of store.list().connections) { assert.equal(item.ready, false); assert.throws(() => store.resolve(item.id), /禁用/); }
});

test('disabled stdio MCP protects each existing mapped value despite missing and invalid peers', t => {
  const directory = temporary(t), secrets = [secret(), `${secret()}\0invalid-for-launch`];
  const environment = { PRESENT_SECRET: secrets[0], INVALID_SECRET: secrets[1], EMPTY_VALUE: '' };
  const store = new NativeMcpConnectionStore(directory, new NativeCredentialStore(), { environment });
  const created = store.upsert({ name: 'stdio fixture', transport: 'stdio', enabled: false, protocolVersion: '2025-11-25', executable: process.execPath,
    argv: ['never-launch-fixture.mjs'], auth: { mode: 'none' }, environment: {
      FIRST_SECRET: 'PRESENT_SECRET', MISSING_SECRET: 'NOT_CONFIGURED', SECOND_SECRET: 'INVALID_SECRET', EMPTY: 'EMPTY_VALUE', DUPLICATE_SECRET: 'PRESENT_SECRET',
    } });
  assert.throws(() => store.resolve(created.id), /禁用/);
  privateValues(store.protectedValues(), secrets); publicValues(store.list(), secrets);
  // Enabling still cannot resolve this incomplete mapping, yet must protect the
  // known values independently of transport launch validation.
  const { credentialConfigured: _configured, ready: _ready, error: _error, ...metadata } = created;
  store.upsert({ ...metadata, enabled: true });
  assert.throws(() => store.resolve(created.id), /映射的环境变量/);
  privateValues(store.protectedValues(), secrets); publicValues(store.list(), secrets);
});

test('unavailable encrypted credentials do not discard other model and MCP values', t => {
  const directory = temporary(t), safeStorage = storage(), blocked = secret(), good = secret(), fromEnv = secret();
  const models = new ConnectionStore(directory, { safeStorage, platform: 'linux' });
  const mcpStore = new NativeMcpConnectionStore(directory, new NativeCredentialStore(safeStorage, 'linux'));
  for (const value of [blocked, good]) {
    const created = models.upsert({ ...model, auth: { mode: 'encrypted' } });
    models.setCredential({ id: created.id, revision: created.revision, mode: 'encrypted', secret: value });
    const mcpCreated = mcpStore.upsert({ ...mcp, auth: { mode: 'encrypted' } });
    mcpStore.setCredential({ id: mcpCreated.id, revision: mcpCreated.revision, mode: 'encrypted', secret: value });
  }
  models.upsert({ ...model, auth: { mode: 'env', variable: 'ENV_SECRET' } });
  mcpStore.upsert({ ...mcp, auth: { mode: 'env', variable: 'ENV_SECRET' } });
  models.upsert(model); mcpStore.upsert(mcp); // Missing memory values after restart.
  const partiallyUnavailable: NativeSafeStorage = { ...safeStorage, decryptString: bytes => {
    const value = safeStorage.decryptString(bytes); if (value === blocked) throw new Error(blocked); return value;
  } };
  const restarted = new ConnectionStore(directory, { safeStorage: partiallyUnavailable, platform: 'linux', environment: { ENV_SECRET: fromEnv } });
  const restartedMcp = new NativeMcpConnectionStore(directory, new NativeCredentialStore(partiallyUnavailable, 'linux'), { environment: { ENV_SECRET: fromEnv } });
  for (const store of [restarted, restartedMcp]) {
    privateValues(store.protectedValues(), [good, fromEnv]); assert.ok(!store.protectedValues().includes(blocked));
    publicValues(store.list(), [blocked, good, fromEnv]);
  }
});

test('disabled and diagnostic-locked credentials stop legacy retained-result disclosure before paging', async t => {
  const directory = temporary(t), safeStorage = storage(), secrets = Array.from({ length: 7 }, secret); let testing = false;
  const models = new ConnectionStore(directory, { safeStorage, platform: 'linux', environment: { MODEL_SECRET: secrets[2] }, isConnectionTesting: () => testing });
  const mcpStore = new NativeMcpConnectionStore(directory, new NativeCredentialStore(safeStorage, 'linux'), { environment: { MCP_SECRET: secrets[5], STDIO_SECRET: secrets[6] } });
  for (const [mode, index] of [['memory', 0], ['encrypted', 1]] as const) {
    const item = models.upsert({ ...model, enabled: mode === 'memory', auth: { mode } });
    models.setCredential({ id: item.id, revision: item.revision, mode, secret: secrets[index] });
    const mcpItem = mcpStore.upsert({ ...mcp, auth: { mode } });
    mcpStore.setCredential({ id: mcpItem.id, revision: mcpItem.revision, mode, secret: secrets[index + 3] });
  }
  models.upsert({ ...model, auth: { mode: 'env', variable: 'MODEL_SECRET' } });
  mcpStore.upsert({ ...mcp, auth: { mode: 'env', variable: 'MCP_SECRET' } });
  mcpStore.upsert({ name: 'stdio fixture', transport: 'stdio', enabled: false, protocolVersion: '2025-11-25', executable: process.execPath, argv: [],
    environment: { API_TOKEN: 'STDIO_SECRET', MISSING_TOKEN: 'MISSING_SECRET' }, auth: { mode: 'none' } });
  testing = true;
  const protectedValues = [...models.protectedValues(), ...mcpStore.protectedValues()];
  for (const value of secrets) assert.ok(protectedValues.includes(value));
  publicValues(models.list(), secrets); publicValues(mcpStore.list(), secrets);
  const parent = newIdentity(), child = newIdentity(), batchId = randomUUID(), childId = randomUUID(), taskId = randomUUID();
  const file = path.join(nativeAgentReceiptDirectory(directory, parent), batchId, childId, 'receipt.json'), patchPath = path.join(path.dirname(file), 'workspace.diff.patch');
  const receipt: NativeDelegationReceipt = { version: 1, batchId, childId, taskId, identity: child, parentIdentity: parent, parentTaskId: 'parent-task',
    toolCallId: 'delegate-fixture', title: 'legacy result', goal: 'read retained evidence', mode: 'implement', status: 'completed',
    createdAt: '2026-10-08T01:00:00.000Z', updatedAt: '2026-10-08T01:01:00.000Z', cwd: directory, receiptPath: file,
    artifact: { patchPath, changedFiles: [], head: 'a'.repeat(40), baseCommit: 'b'.repeat(40) },
    result: { identity: child, taskId, status: 'completed', reason: 'model_completed', committed: true, summary: 'unverified', modelRequests: 1, toolCalls: 0 } };
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(receipt));
  const request = { parentRunId: parent.runId, childId, patchCharacters: 1 };
  for (const value of secrets) {
    fs.writeFileSync(patchPath, '+ordinary\n'.repeat(3000) + value);
    await assert.rejects(readNativeAgentResult(directory, parent, request, { forbiddenValues: protectedValues }),
      error => error instanceof NativeAgentResultReadError && error.code === 'protected_value');
  }
  fs.writeFileSync(patchPath, '+safe\n'); receipt.result!.summary = secrets.join('\n'); fs.writeFileSync(file, JSON.stringify(receipt));
  await assert.rejects(readNativeAgentResult(directory, parent, request, { forbiddenValues: protectedValues }),
    error => error instanceof NativeAgentResultReadError && error.code === 'protected_value');
  assert.equal(fs.existsSync(patchPath), true); assert.equal(fs.existsSync(file), true);
});
