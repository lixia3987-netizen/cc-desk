import test from 'node:test';
import assert from 'node:assert/strict';
import { changeNativePermissionForNextTurn } from '../src/main/native-session-permission';
import type { Session } from '../src/shared/types';
import type { EngineConfig } from '../src/shared/execution';

function fixture() {
  const session: Session = { id: 'session', projectId: 'project', title: 'task', cwd: '/fixture', kind: 'agent',
    execution: { providerId: 'native', mode: 'structured' }, engineConfig: { schemaVersion: 1, options: {
      permissionMode: 'default', model: 'saved-model', runtimePolicy: 'defaults', maxToolCalls: 30, projectSkills: ['skill'] } },
    started: true, status: 'running', taskState: 'waiting_approval', archived: false, createdAt: '', updatedAt: '' };
  let commits = 0, changes = 0, blocked = false;
  const ports = {
    session: (id: string) => { assert.equal(id, session.id); return session; },
    assertAllowed: () => { if (blocked) throw new Error('maintenance/recovery/lifecycle'); },
    validateConfig: (_id: string, config: EngineConfig) => { if (config.schemaVersion !== 1) throw new Error('unsupported schema'); return structuredClone(config); },
    commit: (_id: string, config: EngineConfig) => { commits++; session.engineConfig = config; },
    changed: () => { changes++; },
  };
  return { session, ports, block: () => { blocked = true; }, get commits() { return commits; }, get changes() { return changes; } };
}

test('next-turn permission updates only saved config while current approval and run policy stay intact', () => {
  const f = fixture(), previous = structuredClone(f.session.engineConfig);
  const activePolicy = structuredClone(previous.options), pending = { requestId: 'approval', mode: activePolicy.permissionMode };
  assert.equal(changeNativePermissionForNextTurn(f.session.id, 'bypassPermissions', f.ports), 'bypassPermissions');
  assert.deepEqual(f.session.engineConfig, { ...previous, options: { ...previous.options, permissionMode: 'bypassPermissions' } });
  assert.deepEqual(activePolicy, previous.options);
  assert.deepEqual(pending, { requestId: 'approval', mode: 'default' });
  assert.equal(f.session.taskState, 'waiting_approval');
  assert.equal(f.commits, 1); assert.equal(f.changes, 1);
});

test('permission merge reads latest saved values and never overwrites unrelated newer options', () => {
  const f = fixture();
  f.session.engineConfig.options.maxToolCalls = 77;
  changeNativePermissionForNextTurn(f.session.id, 'acceptEdits', f.ports);
  assert.equal(f.session.engineConfig.options.maxToolCalls, 77);
  assert.deepEqual(f.session.engineConfig.options.projectSkills, ['skill']);
});

test('unsupported provider, kind, mode, archived and stopping sessions cannot change permissions', () => {
  const variants = [
    { execution: { providerId: 'claude', mode: 'structured' as const } },
    { kind: 'shell' as const },
    { execution: { providerId: 'native', mode: 'terminal' as const } },
    { archived: true }, { status: 'stopping' as const },
  ];
  for (const patch of variants) {
    const f = fixture(); Object.assign(f.session, patch);
    assert.throws(() => changeNativePermissionForNextTurn(f.session.id, 'acceptEdits', f.ports));
    assert.equal(f.commits, 0); assert.equal(f.changes, 0);
  }
});

test('invalid permission values and maintenance/recovery/lifecycle guards leave the config unchanged', () => {
  for (const mode of ['unknown', 'plan', ''] as Parameters<typeof changeNativePermissionForNextTurn>[1][]) {
    const f = fixture(); assert.throws(() => changeNativePermissionForNextTurn(f.session.id, mode, f.ports)); assert.equal(f.commits, 0);
  }
  const f = fixture(), original = structuredClone(f.session.engineConfig); f.block();
  assert.throws(() => changeNativePermissionForNextTurn(f.session.id, 'acceptEdits', f.ports), /maintenance/);
  assert.deepEqual(f.session.engineConfig, original); assert.equal(f.commits, 0);
});

test('schema validation and persistence failures cannot publish success notifications', () => {
  const f = fixture(); f.session.engineConfig.schemaVersion = 99;
  assert.throws(() => changeNativePermissionForNextTurn(f.session.id, 'acceptEdits', f.ports), /schema/);
  assert.equal(f.commits, 0); assert.equal(f.changes, 0);
  const g = fixture();
  assert.throws(() => changeNativePermissionForNextTurn(g.session.id, 'acceptEdits', { ...g.ports, commit: () => { throw new Error('disk failure'); } }), /disk/);
  assert.equal(g.session.engineConfig.options.permissionMode, 'default'); assert.equal(g.changes, 0);
});
