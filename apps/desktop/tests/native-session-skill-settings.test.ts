import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { StateStore } from '../src/main/store';
import { NativeSessionSkillSettings, type NativeSessionSkillSettingsHost } from '../src/main/engines/native/session-skill-settings';
import { nativeConfigDigest, normalizeNativeLegacySkillPolicy } from '../src/main/engines/native/config';
import { registerNativeSessionSkillHandlers } from '../src/main/ipc/native-session-skill-handlers';
import { SessionService } from '../src/main/session-service';
import { ExecutionRegistry } from '../src/main/execution/registry';
import type { StructuredExecutor } from '../src/main/execution/ports';
import type { EngineConfig } from '../src/shared/execution';
import type { NativeSessionSkillsSave } from '../src/shared/native-skills';

async function fixture(paths = ['custom/SKILL.md', 'missing/SKILL.md']) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'native-session-skills-'));
  const cwd = path.join(root, 'project'); await fsp.mkdir(cwd);
  const store = new StateStore(path.join(root, 'data'), { writeDelayMs: 60_000 });
  const id = randomUUID(), projectId = randomUUID(), now = new Date().toISOString();
  const original: EngineConfig = { schemaVersion: 1, options: { projectSkills: paths, model: 'kept-model', mcpConnections: ['kept-mcp'] } };
  store.change(state => {
    state.projects.push({ id: projectId, path: cwd, name: 'project', createdAt: now });
    state.sessions.push({ id, projectId, title: 'Native', kind: 'agent', cwd,
      execution: { providerId: 'native', mode: 'structured', conversationId: randomUUID() },
      engineConfig: original, started: false, status: 'idle', archived: false, createdAt: now, updatedAt: now });
  });
  await fsp.mkdir(path.join(cwd, 'custom'));
  await fsp.writeFile(path.join(cwd, 'custom/SKILL.md'), '---\nname: legacy-frontmatter\n---\nwhole guide');
  let busy = false, pending = false, locked = false, maintenance = false, epoch = 0;
  let beforeManage = () => {}, onState = () => {};
  let manages = 0, changes = 0;
  const host: NativeSessionSkillSettingsHost = {
    store,
    manage: async (_id, action) => { manages++; beforeManage(); locked = true; try { return await action(); } finally { locked = false; } },
    assertUnlocked: () => { if (locked) throw new Error('管理操作正在执行。'); },
    taskOccupied: () => busy, hasPending: () => pending,
    captureAdmission: () => { const initial = epoch; return () => { if (maintenance || epoch !== initial) throw new Error('引擎维护已取消操作。'); }; },
    onState: () => { changes++; onState(); },
  };
  const settings = new NativeSessionSkillSettings(host);
  const handlers = new Map<string, (input: unknown) => unknown>();
  registerNativeSessionSkillHandlers((name, schema, action) => handlers.set(name, input => action(schema.parse(input))), host);
  const request = (): NativeSessionSkillsSave => ({ sessionId: id, mutationId: randomUUID(), expectedConfigDigest: nativeConfigDigest(store.state.sessions[0].engineConfig), policy: normalizeNativeLegacySkillPolicy(paths) });
  const files = () => fs.existsSync(path.join(store.directory, 'native-session-skills')) ? fs.readdirSync(path.join(store.directory, 'native-session-skills')) : [];
  return { root, cwd, id, store, original, host, settings, handlers, request, files,
    current: () => store.state.sessions[0],
    setBusy: (value: boolean) => { busy = value; }, setPending: (value: boolean) => { pending = value; },
    setMaintenance: (value: boolean) => { maintenance = value; }, advanceEpoch: () => { epoch++; },
    beforeManage: (action: () => void) => { beforeManage = action; }, onState: (action: () => void) => { onState = action; },
    counts: () => ({ manages, changes }),
    dispose: async () => { store.flush(); await fsp.rm(root, { recursive: true, force: true }); },
  };
}

test('a valid large legacy selection is preserved when its mirrored migration would exceed the existing configuration limit', async () => {
  const paths = Array.from({ length: 16 }, (_, index) => `p${index}/${'x'.repeat(2100)}/SKILL.md`);
  const f = await fixture(paths);
  try {
    const before = fs.readFileSync(f.store.file), original = structuredClone(f.current().engineConfig);
    await assert.rejects(f.settings.save(f.request()), /安全大小限制.*原配置已保留/);
    assert.deepEqual(f.current().engineConfig, original);
    assert.deepEqual(fs.readFileSync(f.store.file), before);
    assert.deepEqual(f.files(), [], 'capacity rejection happens before creating any backup or receipt');
  } finally { await f.dispose(); }
});

test('explicit migration preserves missing pins, full raw config and a flushed complete workspace snapshot', async () => {
  const f = await fixture();
  try {
    const view = await f.settings.get(f.id);
    assert.deepEqual(view.pinDiagnostics.map(item => [item.path, item.status]), [['custom/SKILL.md', 'available'], ['missing/SKILL.md', 'unavailable']]);
    assert.equal(view.runtimeEnabled, false);
    f.store.change(state => { state.sessions[0].draft = 'latest deferred draft'; }, { defer: true });
    const result = await f.settings.save(f.request());
    assert.equal(result.migrated, true); assert.equal(result.backupCreated, true);
    assert.equal(result.schemaVersion, 2); assert.equal(result.configDigest, nativeConfigDigest(f.current().engineConfig));
    assert.deepEqual(result.config.options, { ...f.original.options, skills: normalizeNativeLegacySkillPolicy(['custom/SKILL.md', 'missing/SKILL.md']) });
    const backups = f.files().filter(file => file.startsWith('workspace.pre-native-skills-v2.'));
    assert.equal(backups.length, 1);
    const backup = JSON.parse(fs.readFileSync(path.join(f.store.directory, 'native-session-skills', backups[0]), 'utf8'));
    assert.deepEqual(backup.sessions[0].engineConfig, f.original);
    assert.equal(backup.sessions[0].draft, 'latest deferred draft');
    assert.deepEqual(backup.projects, f.store.state.projects);
    assert.equal(result.pinDiagnostics[1].status, 'unavailable');
  } finally { await f.dispose(); }
});

test('first migration cannot delete missing pins; later v2 save can change only Skills and its legacy mirror', async () => {
  const f = await fixture();
  try {
    const request = f.request(); request.policy = normalizeNativeLegacySkillPolicy(['custom/SKILL.md']);
    await assert.rejects(f.settings.save(request), /首次迁移必须保留/);
    assert.deepEqual(f.current().engineConfig, f.original); assert.equal(f.files().length, 0);
    await f.settings.save(f.request());
    const next = f.request(); next.policy = normalizeNativeLegacySkillPolicy(['new/SKILL.md']);
    const saved = await f.settings.save(next);
    assert.equal(saved.migrated, false); assert.equal(saved.backupCreated, false);
    assert.deepEqual(saved.config.options.projectSkills, ['new/SKILL.md']);
    assert.deepEqual(saved.config.options.mcpConnections, ['kept-mcp']); assert.equal(saved.config.options.model, 'kept-model');
    assert.equal(f.files().filter(file => file.startsWith('workspace.pre-native-skills-v2.')).length, 1);
  } finally { await f.dispose(); }
});

test('migration backup failure leaves old config in memory and on disk without leaking filesystem errors', async t => {
  const f = await fixture();
  try {
    const before = fs.readFileSync(f.store.file), open = fs.openSync;
    t.mock.method(fs, 'openSync', (file: fs.PathLike, ...args: [fs.OpenMode, fs.Mode?]) => {
      if (String(file).includes('workspace.pre-native-skills-v2.')) throw new Error(`ENOSPC SENTINEL ${f.root}`);
      return Reflect.apply(open, fs, [file, ...args]);
    });
    await assert.rejects(f.settings.save(f.request()), error => error instanceof Error && /备份/.test(error.message) && !error.message.includes('SENTINEL') && !error.message.includes(f.root));
    assert.deepEqual(f.current().engineConfig, f.original); assert.deepEqual(fs.readFileSync(f.store.file), before);
    assert.equal(f.counts().changes, 0);
  } finally { t.mock.restoreAll(); await f.dispose(); }
});

test('complete failed-sync backup is safely reused and synced before any config publication', async t => {
  const f = await fixture();
  try {
    const open = fs.openSync, sync = fs.fsyncSync, backupFds = new Set<number>(); let fail = true, syncs = 0;
    t.mock.method(fs, 'openSync', (file: fs.PathLike, ...args: [fs.OpenMode, fs.Mode?]) => {
      const fd = Reflect.apply(open, fs, [file, ...args]);
      if (String(file).includes('workspace.pre-native-skills-v2.')) backupFds.add(fd); else backupFds.delete(fd);
      return fd;
    });
    t.mock.method(fs, 'fsyncSync', (fd: number) => {
      if (backupFds.has(fd)) { syncs++; if (fail) throw new Error('sync failed'); }
      return sync(fd);
    });
    const request = f.request();
    await assert.rejects(f.settings.save(request), /备份/);
    assert.deepEqual(f.current().engineConfig, f.original);
    assert.equal(f.files().filter(file => file.startsWith('workspace.pre-native-skills-v2.')).length, 1);
    fail = false;
    await f.settings.save(request);
    assert.equal(syncs, 2);
    assert.equal(f.files().filter(file => file.startsWith('workspace.pre-native-skills-v2.')).length, 1);
  } finally { t.mock.restoreAll(); await f.dispose(); }
});

test('workspace publication failure preserves original bytes and permits the exact request retry', async t => {
  const f = await fixture();
  try {
    f.store.change(state => { state.sessions[0].updatedAt = ''; });
    const before = fs.readFileSync(f.store.file), rename = fs.renameSync; let fail = true;
    t.mock.method(fs, 'renameSync', (source: fs.PathLike, target: fs.PathLike) => {
      if (String(target) === f.store.file && fail) throw new Error('workspace rename failed');
      return rename(source, target);
    });
    const request = f.request();
    await assert.rejects(f.settings.save(request), /未能保存/);
    assert.deepEqual(f.current().engineConfig, f.original); assert.deepEqual(fs.readFileSync(f.store.file), before);
    fail = false;
    const saved = await f.settings.save(request);
    assert.equal(saved.schemaVersion, 2);
    assert.equal(f.files().filter(file => file.startsWith('workspace.pre-native-skills-v2.')).length, 1);
  } finally { t.mock.restoreAll(); await f.dispose(); }
});

test('failed flush aborts before a backup or config write and retains the pending draft', async t => {
  const f = await fixture();
  try {
    f.store.change(state => { state.sessions[0].draft = 'pending'; }, { defer: true });
    t.mock.method(fs, 'renameSync', () => { throw new Error('failed flush'); });
    await assert.rejects(f.settings.save(f.request()), /刷新工作区/);
    assert.deepEqual(f.current().engineConfig, f.original); assert.equal(f.current().draft, 'pending');
    assert.equal(f.files().length, 0);
  } finally { t.mock.restoreAll(); await f.dispose(); }
});

test('lost ACK is confirmed across settings/store restart; stale replay cannot overwrite concurrent non-Skills changes', async () => {
  const f = await fixture();
  try {
    const request = f.request(); f.onState(() => { throw new Error('lost ACK'); });
    await assert.rejects(f.settings.save(request), /已保存/);
    const after = fs.readFileSync(f.store.file), files = f.files();
    const reopened = new StateStore(f.store.directory);
    const restarted = new NativeSessionSkillSettings({ ...f.host, store: reopened });
    const confirmed = await restarted.save(request);
    assert.equal(confirmed.migrated, true); assert.deepEqual(fs.readFileSync(f.store.file), after); assert.deepEqual(f.files(), files);
    reopened.change(state => { state.sessions[0].engineConfig.options.mcpConnections = ['concurrent-mcp']; });
    await assert.rejects(restarted.save(request), /配置已变化/);
    assert.deepEqual(reopened.state.sessions[0].engineConfig.options.mcpConnections, ['concurrent-mcp']);
  } finally { await f.dispose(); }
});

for (const [label, timestamp] of [['empty', ''], ['non-date', 'legacy timestamp'], ['long', 'x'.repeat(10_000)],
  ['date upper bound', '+275760-09-13T00:00:00.000Z']] as const) test(`legacy ${label} updatedAt migrates and confirms the same mutation after restart/lost ACK`, async () => {
  const f = await fixture();
  try {
    f.store.change(state => { state.sessions[0].updatedAt = timestamp; });
    const request = f.request(); f.onState(() => { throw new Error('lost ACK'); });
    await assert.rejects(f.settings.save(request), /已保存/);
    assert.equal(f.current().engineConfig.schemaVersion, 2);
    assert.notEqual(f.current().updatedAt, timestamp);
    assert.ok(Number.isFinite(Date.parse(f.current().updatedAt)));
    const receiptFile = f.files().find(file => file.endsWith('.receipt.json'))!;
    const receiptBytes = fs.readFileSync(path.join(f.store.directory, 'native-session-skills', receiptFile));
    assert.ok(receiptBytes.length < 2048);
    const receipt = JSON.parse(receiptBytes.toString('utf8'));
    assert.equal(receipt.sourceSessionUpdatedAtDigest, createHash('sha256').update(timestamp).digest('hex'));
    assert.equal(Object.hasOwn(receipt, 'sourceSessionUpdatedAt'), false);
    const before = fs.readFileSync(f.store.file);
    const restarted = new NativeSessionSkillSettings({ ...f.host, store: new StateStore(f.store.directory) });
    const confirmed = await restarted.save(request);
    assert.equal(confirmed.migrated, true); assert.deepEqual(fs.readFileSync(f.store.file), before);
  } finally { await f.dispose(); }
});

test('v2 independent save also supports lost ACK retry without another workspace backup or rewrite', async () => {
  const f = await fixture();
  try {
    await f.settings.save(f.request());
    const request = f.request(); request.policy = normalizeNativeLegacySkillPolicy(['different/SKILL.md']);
    f.onState(() => { throw new Error('lost ACK'); });
    await assert.rejects(f.settings.save(request), /已保存/);
    const after = fs.readFileSync(f.store.file), count = f.counts().changes;
    const confirmed = await f.settings.save(request);
    assert.equal(confirmed.migrated, false); assert.equal(confirmed.backupCreated, false);
    assert.deepEqual(fs.readFileSync(f.store.file), after); assert.equal(f.counts().changes, count);
    assert.equal(f.files().filter(file => file.startsWith('workspace.pre-native-skills-v2.')).length, 1);
  } finally { await f.dispose(); }
});

test('completed A→B→A mutation cannot be replayed from its old receipt', async () => {
  const f = await fixture();
  try {
    await f.settings.save(f.request());
    const stateA = structuredClone(f.current().engineConfig), timeA = f.current().updatedAt;
    const requestAB = f.request(); requestAB.policy = normalizeNativeLegacySkillPolicy(['other/SKILL.md']);
    await f.settings.save(requestAB);
    const requestBA = f.request(); requestBA.policy = normalizeNativeLegacySkillPolicy(['custom/SKILL.md', 'missing/SKILL.md']);
    await f.settings.save(requestBA);
    assert.deepEqual(f.current().engineConfig, stateA);
    assert.ok(Date.parse(f.current().updatedAt) > Date.parse(timeA));
    const after = fs.readFileSync(f.store.file);
    await assert.rejects(f.settings.save(requestAB), /配置已变化/);
    assert.deepEqual(fs.readFileSync(f.store.file), after); assert.deepEqual(f.current().engineConfig, stateA);
    const freshAB = { ...requestAB, mutationId: randomUUID() };
    const saved = await f.settings.save(freshAB);
    assert.deepEqual(saved.config.options.projectSkills, ['other/SKILL.md']);
  } finally { await f.dispose(); }
});

test('a mutation identifier cannot be reused with another source digest or policy', async () => {
  const f = await fixture();
  try {
    const request = f.request(); await f.settings.save(request);
    const after = fs.readFileSync(f.store.file);
    await assert.rejects(f.settings.save({ ...request, policy: normalizeNativeLegacySkillPolicy(['different/SKILL.md']) }), /请求标识已被使用/);
    await assert.rejects(f.settings.save({ ...request, expectedConfigDigest: nativeConfigDigest(f.current().engineConfig) }), /请求标识已被使用/);
    assert.deepEqual(fs.readFileSync(f.store.file), after);
  } finally { await f.dispose(); }
});

test('saving an unchanged v2 policy performs no write and does not advance updatedAt', async () => {
  const f = await fixture();
  try {
    await f.settings.save(f.request());
    const before = fs.readFileSync(f.store.file), files = f.files(), time = f.current().updatedAt, changes = f.counts().changes;
    const request = f.request(), saved = await f.settings.save(request);
    assert.equal(saved.migrated, false); assert.equal(saved.backupCreated, false);
    assert.equal(f.current().updatedAt, time); assert.deepEqual(fs.readFileSync(f.store.file), before);
    assert.equal(f.files().length, files.length + 1); assert.equal(f.counts().changes, changes);
    const afterFiles = f.files(); await f.settings.save(request); assert.deepEqual(f.files(), afterFiles);
    await assert.rejects(f.settings.save({ ...request, policy: normalizeNativeLegacySkillPolicy(['changed/SKILL.md']) }), /请求标识已被使用/);
  } finally { await f.dispose(); }
});

test('a config change after backup sync aborts publication and retains the concurrent config', async t => {
  const f = await fixture();
  try {
    const open = fs.openSync, sync = fs.fsyncSync, backupFds = new Set<number>(); let changed = false;
    t.mock.method(fs, 'openSync', (file: fs.PathLike, ...args: [fs.OpenMode, fs.Mode?]) => {
      const fd = Reflect.apply(open, fs, [file, ...args]);
      if (String(file).includes('workspace.pre-native-skills-v2.')) backupFds.add(fd); else backupFds.delete(fd);
      return fd;
    });
    t.mock.method(fs, 'fsyncSync', (fd: number) => {
      sync(fd);
      if (backupFds.has(fd) && !changed) {
        changed = true;
        f.store.change(state => { state.sessions[0].engineConfig.options.model = 'changed-during-backup'; });
      }
    });
    await assert.rejects(f.settings.save(f.request()), /配置已变化/);
    assert.equal(f.current().engineConfig.schemaVersion, 1); assert.equal(f.current().engineConfig.options.model, 'changed-during-backup');
    assert.equal(JSON.parse(fs.readFileSync(f.store.file, 'utf8')).sessions[0].engineConfig.options.model, 'changed-during-backup');
    assert.equal(f.counts().changes, 0);
  } finally { t.mock.restoreAll(); await f.dispose(); }
});

test('diagnostic budget exhaustion is unverified and keeps every selected path', async () => {
  const paths = Array.from({ length: 6 }, (_, index) => `pin-${index}/SKILL.md`), f = await fixture(paths);
  try {
    const view = await f.settings.get(f.id);
    assert.equal(view.policy.pins.length, 6);
    assert.deepEqual(view.pinDiagnostics.map(item => item.status), ['unavailable', 'unavailable', 'unavailable', 'unavailable', 'unverified', 'unverified']);
    assert.match(view.pinDiagnostics[5].message!, /尚未检查/);
  } finally { await f.dispose(); }
});

test('immutable backup is never replaced if an existing pathname has different bytes', async () => {
  const f = await fixture();
  try {
    const before = fs.readFileSync(f.store.file), digest = createHash('sha256').update(before).digest('hex');
    const directory = path.join(f.store.directory, 'native-session-skills'); fs.mkdirSync(directory);
    const backup = path.join(directory, `workspace.pre-native-skills-v2.${digest}.json`), conflicting = Buffer.alloc(before.length, 0x20);
    fs.writeFileSync(backup, conflicting);
    await assert.rejects(f.settings.save(f.request()), /备份/);
    assert.deepEqual(fs.readFileSync(backup), conflicting); assert.deepEqual(f.current().engineConfig, f.original);
  } finally { await f.dispose(); }
});

for (const kind of ['project', 'projectPath', 'cwd', 'conversation', 'remove', 'config'] as const) test(`scope/CAS ${kind} drift while entering management aborts the save`, async () => {
  const f = await fixture();
  try {
    const request = f.request();
    f.beforeManage(() => f.store.change(state => {
      if (kind === 'project') state.sessions[0].projectId = randomUUID();
      if (kind === 'projectPath') state.projects[0].path = f.root;
      if (kind === 'cwd') state.sessions[0].cwd = f.root;
      if (kind === 'conversation') state.sessions[0].execution.conversationId = randomUUID();
      if (kind === 'remove') state.sessions = [];
      if (kind === 'config') state.sessions[0].engineConfig.options.model = 'concurrent';
    }));
    await assert.rejects(f.settings.save(request), /会话|配置已变化/);
    if (kind !== 'remove') assert.equal(f.current().engineConfig.schemaVersion, 1);
    assert.equal(f.files().length, 0);
  } finally { await f.dispose(); }
});

test('config or scope change during explicit pin reads invalidates the returned view', async () => {
  for (const kind of ['cwd', 'config'] as const) {
    const f = await fixture();
    try {
      const reading = f.settings.get(f.id);
      f.store.change(state => { if (kind === 'cwd') state.sessions[0].cwd = f.root; else state.sessions[0].engineConfig.options.model = 'concurrent'; });
      await assert.rejects(reading, /会话|配置已变化/);
    } finally { await f.dispose(); }
  }
});

test('busy, pending queue, archive and maintenance guards run before and inside management', async () => {
  const f = await fixture();
  try {
    f.setBusy(true); await assert.rejects(f.settings.save(f.request()), /停止任务/); f.setBusy(false);
    f.setPending(true); await assert.rejects(f.settings.save(f.request()), /队列/); f.setPending(false);
    f.store.change(state => { state.sessions[0].archived = true; });
    await assert.rejects(f.settings.save(f.request()), /取消会话归档/);
    f.store.change(state => { state.sessions[0].archived = false; });
    f.setMaintenance(true); await assert.rejects(f.settings.save(f.request()), /维护/); f.setMaintenance(false);
    assert.equal(f.counts().manages, 0);
    f.beforeManage(() => f.advanceEpoch()); await assert.rejects(f.settings.save(f.request()), /维护/);
    f.beforeManage(() => f.setPending(true)); await assert.rejects(f.settings.save(f.request()), /队列/);
    assert.deepEqual(f.current().engineConfig, f.original); assert.equal(f.files().length, 0);
  } finally { await f.dispose(); }
});

test('read inspects only explicit pins and malformed/catalog IPC requests cannot alter a config', async () => {
  const f = await fixture(['missing/SKILL.md']);
  try {
    // An oversized unrelated source must not be discovered or diagnosed by this read.
    await fsp.mkdir(path.join(f.cwd, '.agents/skills/unselected'), { recursive: true });
    await fsp.writeFile(path.join(f.cwd, '.agents/skills/unselected/SKILL.md'), 'private'.repeat(10_000));
    const view = await f.handlers.get('native:session-skills')!({ sessionId: f.id });
    assert.equal((view as { pinDiagnostics: unknown[] }).pinDiagnostics.length, 1);
    for (const policy of [null, { mode: 'catalog', autoActivation: false, pins: [], disabledIds: [] },
      { mode: 'legacy', autoActivation: true, pins: [], disabledIds: [] }, normalizeNativeLegacySkillPolicy(['missing/SKILL.md'])]) {
      if (policy && 'mode' in policy && policy.mode === 'legacy' && policy.autoActivation === false) continue;
      await assert.rejects(Promise.resolve().then(() => f.handlers.get('native:session-skills-save')!({ ...f.request(), policy })), /兼容模式/);
    }
    assert.deepEqual(f.current().engineConfig, f.original);
    await assert.rejects(Promise.resolve().then(() => f.handlers.get('native:session-skills')!({ sessionId: f.id, cwd: f.root })));
  } finally { await f.dispose(); }
});

test('SessionService registration enforces real busy/recovery/pending/cleanup guards and management ownership', { timeout: 5000 }, async () => {
  const f = await fixture();
  let service: SessionService | undefined;
  let releaseCleanup = () => {};
  try {
    let busy = false, recovery = false, blockCleanup = false;
    let cleanupEntered!: () => void;
    const cleanupReady = new Promise<void>(resolve => { cleanupEntered = resolve; });
    const cleanupWait = new Promise<void>(resolve => { releaseCleanup = resolve; });
    const registry = new ExecutionRegistry(id => {
      const session = f.store.state.sessions.find(item => item.id === id);
      if (!session) throw new Error('Session missing'); return session;
    });
    const driver = { activeCount: 0, has: () => false, isBusy: () => busy, recoveryRequired: () => recovery,
      taskState: () => 'idle', snapshot: () => ({ sessionId: f.id, taskState: 'idle', messages: [], pending: [] }),
      attention: () => [], hydrate: async () => {}, send: async () => ({ success: true, summary: 'done' }),
      stopIdle: async () => { if (blockCleanup) { cleanupEntered(); await cleanupWait; } }, whenReleased: async () => {},
      stop: () => {}, interrupt: () => {}, forget: () => {}, shutdown: async () => {},
      setMaintenance: () => {}, disconnectAll: async () => {},
    } as unknown as StructuredExecutor;
    registry.register({ providerId: 'native', mode: 'structured', executor: driver,
      capabilities: () => ({ available: true, structured: true, terminal: false, approvals: false, resume: false, fork: false, commands: false, contextUsage: false, liveConfig: false, attachments: false }) });
    service = new SessionService(f.store, registry, () => {}, () => null, {
      history: async () => ({ entries: [], total: 0, nextOffset: null }), diagnose: async () => { throw new Error('unused'); },
    });
    const handlers = new Map<string, (input: unknown) => unknown>();
    service.register((name, schema, action) => handlers.set(name, input => action(schema.parse(input))));
    const save = (request = f.request()) => Promise.resolve().then(() => handlers.get('native:session-skills-save')!(request));
    busy = true; await assert.rejects(save(), /停止任务/); busy = false;
    recovery = true; await assert.rejects(save(), /恢复状态/); recovery = false;
    service.queue.pause(f.id);
    const queued = await service.queue.submit(f.id, 'keep pending');
    await assert.rejects(save(), /队列/);
    assert.equal(service.queue.snapshot(f.id).items.length, 1);
    await service.queue.remove(f.id, queued.messageId);
    // A save pauses admission and holds the same lifecycle lock until awaited pin diagnostics settle.
    const request = f.request(), saving = save(request);
    await Promise.resolve();
    await assert.rejects(save(request), /管理操作/);
    await saving;
    assert.equal(f.current().engineConfig.schemaVersion, 2);
    assert.equal(service.queue.snapshot(f.id).paused, true);
    const second = f.request(); second.policy = normalizeNativeLegacySkillPolicy([]);
    await save(second);
    assert.deepEqual(f.current().engineConfig.options.projectSkills, []);
    blockCleanup = true;
    const sending = Promise.resolve().then(() => handlers.get('chat:send')!({ id: f.id, text: 'complete then release resources' }));
    await cleanupReady;
    await assert.rejects(save(), /停止任务/);
    releaseCleanup(); await sending;
    await save();
  } finally { releaseCleanup(); await service?.shutdown(); await f.dispose(); }
});
