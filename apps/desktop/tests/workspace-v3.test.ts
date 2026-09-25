import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StateStore } from '../src/main/store';
import { engineConfigSchema, persistedStateSchema, stateSchema } from '../src/shared/schema';

function legacySession(providerId = 'claude') {
  return {
    id: randomUUID(), projectId: randomUUID(), title: '保留会话', kind: providerId === 'shell' ? 'shell' : 'agent',
    execution: providerId === 'shell' ? { providerId, mode: 'terminal' } : {
      providerId, mode: 'structured', conversationId: 'conversation:42', forkFrom: 'parent:21', imported: true,
    },
    cwd: '/projects/旧项目', started: true, model: 'custom-model', effort: 'max', permissionMode: 'plan',
    status: 'stopped', archived: false, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
    draft: '未发送的草稿', worktree: '/projects/旧项目/.worktrees/task', worktreeBase: '/projects/旧项目',
  };
}
function legacyState() {
  const session = legacySession();
  return {
    version: 2, settings: {
      claudePath: '/tools/claude', shellPath: '/bin/bash', idePath: '/tools/editor',
      maxSessions: 6, fontSize: 15, scrollback: 9000, defaultPermissionMode: 'bypassPermissions',
      worktreeLocation: 'custom', worktreeRoot: '/worktrees', notifications: false, closeToTray: true,
    },
    projects: [{ id: session.projectId, name: '旧项目', path: '/projects/旧项目', createdAt: session.createdAt }],
    sessions: [session], selectedSessionId: session.id,
  };
}
function fixture(state: unknown = legacyState()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdesk-v3-'));
  const file = path.join(directory, 'workspace.json');
  const original = JSON.stringify(state, null, 4) + '\n';
  fs.writeFileSync(file, original);
  return {
    directory, file, original,
    backups: () => fs.readdirSync(directory).filter(name => /^workspace\.pre-v3\..+\.json$/.test(name)),
    dispose: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

test('v2 migration preserves identities, project data and separate session/default Claude options', () => {
  const old = legacyState();
  const migrated = persistedStateSchema.parse(old);
  const { model, effort, permissionMode, ...session } = old.sessions[0];
  assert.equal(migrated.version, 3);
  assert.deepEqual(migrated.sessions[0], { ...session, engineConfig: { schemaVersion: 1, options: { model, effort, permissionMode } } });
  assert.deepEqual(migrated.projects, old.projects);
  assert.equal(migrated.selectedSessionId, old.selectedSessionId);
  assert.deepEqual(migrated.settings.engineDefaults, {
    claude: { schemaVersion: 1, options: { model: '', effort: 'default', permissionMode: 'bypassPermissions' } },
  });
  for (const key of ['claudePath', 'shellPath', 'idePath', 'maxSessions', 'fontSize', 'scrollback', 'worktreeLocation', 'worktreeRoot', 'notifications', 'closeToTray'] as const) {
    assert.deepEqual(migrated.settings[key], old.settings[key]);
  }
  assert.equal('defaultPermissionMode' in migrated.settings, false);
  assert.deepEqual(persistedStateSchema.parse(migrated), migrated);
  assert.equal(stateSchema.safeParse(old).success, false, 'live writes never accept legacy state');
});

test('Shell retains non-default legacy options without applying Claude semantics; other providers receive version zero', () => {
  const old = legacyState();
  const shell = legacySession('shell');
  const cleanShell = { ...legacySession('shell'), model: '', effort: 'default', permissionMode: 'default' };
  const unknown = legacySession('vendor.legacy-agent');
  const migrated = persistedStateSchema.parse({ ...old, sessions: [shell, cleanShell, unknown] });
  assert.deepEqual(migrated.sessions[0].engineConfig, {
    schemaVersion: 1, options: { legacy: { model: 'custom-model', effort: 'max', permissionMode: 'plan' } },
  });
  assert.deepEqual(migrated.sessions[1].engineConfig, { schemaVersion: 1, options: {} });
  assert.deepEqual(migrated.sessions[2].engineConfig, {
    schemaVersion: 0, options: { model: 'custom-model', effort: 'max', permissionMode: 'plan' },
  });
  assert.deepEqual(migrated.sessions[2].execution, unknown.execution);
});

test('v3 keeps unknown provider config versions and nested options through unrelated edits and restart', () => {
  const state = persistedStateSchema.parse(legacyState());
  state.sessions[0].execution.providerId = 'vendor.future-agent';
  const config = { schemaVersion: 123, options: { endpoint: 'local', modes: ['fast', null], custom: { enabled: true, limit: 42 } } };
  state.sessions[0].engineConfig = config;
  state.settings.engineDefaults['vendor.future-agent'] = { schemaVersion: 456, options: { newOption: ['keep', 1] } };
  state.settings.engineDefaults.claude = { schemaVersion: 99, options: { futureOption: 'preserve' } };
  const f = fixture(state);
  try {
    const store = new StateStore(f.directory);
    store.change(draft => { draft.sessions[0].title = '新标题'; draft.settings.fontSize = 16; });
    const reloaded = new StateStore(f.directory).state;
    assert.deepEqual(reloaded.sessions[0].engineConfig, config);
    assert.deepEqual(reloaded.settings.engineDefaults, state.settings.engineDefaults);
    assert.deepEqual(reloaded.sessions[0].execution, state.sessions[0].execution);
    assert.equal(f.backups().length, 0, 'a current workspace is not migrated again');
  } finally { f.dispose(); }
});

test('migration writes one unique exact backup and never replaces it during saves or subsequent migrations', () => {
  const f = fixture();
  try {
    const priorBackup = path.join(f.directory, 'workspace.pre-v3.existing.json');
    fs.writeFileSync(priorBackup, 'older immutable backup\n');
    const store = new StateStore(f.directory);
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original, 'reading migration does not overwrite its source');
    store.flush();
    const created = f.backups().filter(name => name !== path.basename(priorBackup));
    assert.equal(created.length, 1);
    const migrationBackup = path.join(f.directory, created[0]);
    assert.equal(fs.readFileSync(migrationBackup, 'utf8'), f.original);
    assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).version, 3);
    store.change(state => { state.sessions[0].title = 'changed'; });
    store.flush();
    const restored = new StateStore(f.directory);
    restored.flush();
    assert.deepEqual(restored.state, store.state);
    assert.equal(f.backups().length, 2, 'restart and no-op flush create no extra migration backups');
    assert.equal(fs.readFileSync(migrationBackup, 'utf8'), f.original);
    assert.equal(fs.readFileSync(priorBackup, 'utf8'), 'older immutable backup\n');
    // Restoring an older workspace later creates another independent backup.
    const secondOriginal = JSON.stringify({ ...legacyState(), selectedSessionId: '' });
    fs.writeFileSync(f.file, secondOriginal);
    new StateStore(f.directory).flush();
    assert.equal(f.backups().length, 3);
    assert.ok(f.backups().some(name => fs.readFileSync(path.join(f.directory, name), 'utf8') === secondOriginal));
    assert.equal(fs.readFileSync(migrationBackup, 'utf8'), f.original);
  } finally { f.dispose(); }
});

test('failed migration replacement leaves original bytes intact and retries reuse the completed backup', () => {
  const f = fixture();
  try {
    const store = new StateStore(f.directory);
    fs.mkdirSync(f.file + '.tmp');
    assert.throws(() => store.flush());
    assert.ok(store.persistenceError);
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
    assert.equal(store.state.version, 3, 'validated migration remains available for explicit retry');
    assert.equal(f.backups().length, 1);
    const backup = f.backups()[0];
    assert.equal(fs.readFileSync(path.join(f.directory, backup), 'utf8'), f.original);
    assert.throws(() => store.change(state => { state.sessions[0].title = 'must not commit'; }));
    assert.equal(store.state.sessions[0].title, '保留会话');
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
    fs.rmdirSync(f.file + '.tmp');
    store.flush();
    assert.equal(store.persistenceError, undefined);
    assert.deepEqual(f.backups(), [backup]);
    assert.deepEqual(new StateStore(f.directory).state, store.state);
    assert.equal(fs.readFileSync(path.join(f.directory, backup), 'utf8'), f.original);
  } finally { f.dispose(); }
});

test('backup creation failure cannot replace the original migration source', t => {
  const f = fixture();
  try {
    const store = new StateStore(f.directory);
    const openSync = fs.openSync;
    const mocked = t.mock.method(fs, 'openSync', (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (String(file).includes('workspace.pre-v3.')) throw new Error('backup unavailable');
      return openSync(file, flags, mode);
    });
    assert.throws(() => store.flush(), /backup unavailable/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
    assert.equal(fs.existsSync(f.file + '.tmp'), false);
    assert.equal(f.backups().length, 0);
    mocked.mock.restore();
    store.flush();
    assert.equal(f.backups().length, 1);
    assert.deepEqual(new StateStore(f.directory).state, store.state);
  } finally { f.dispose(); }
});

test('future workspace versions and malformed legacy config are rejected without writing any files', () => {
  for (const state of [
    { ...legacyState(), version: 4 },
    { ...legacyState(), sessions: [{ ...legacySession(), effort: 'unsupported' }] },
  ]) {
    const f = fixture(state);
    try {
      assert.throws(() => new StateStore(f.directory), state.version === 4 ? /更新的数据版本.*原文件已保留/ : /原文件已保留/);
      assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
      assert.deepEqual(fs.readdirSync(f.directory), ['workspace.json']);
    } finally { f.dispose(); }
  }
});

test('generic engine config rejects non-JSON, unbounded and unsafe options without assuming provider fields', () => {
  assert.equal(engineConfigSchema.safeParse({ schemaVersion: 0, options: { arbitrary: [null, true, 1, 'text'] } }).success, true);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  let deep: unknown = 'leaf';
  for (let i = 0; i < 10; i++) deep = { nested: deep };
  for (const options of [[], null, { value: NaN }, { value: undefined }, { value: () => 1 }, { value: new Date() }, cyclic, deep, { huge: 'x'.repeat(65537) }, JSON.parse('{"__proto__":{"polluted":true}}')]) {
    assert.equal(engineConfigSchema.safeParse({ schemaVersion: 1, options }).success, false);
  }
  for (const schemaVersion of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(engineConfigSchema.safeParse({ schemaVersion, options: {} }).success, false);
  }
});
