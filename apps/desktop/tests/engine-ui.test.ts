import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionDescriptor } from '../src/shared/execution';
import type { Session } from '../src/shared/types';
import { sessionActionAvailability } from '../src/renderer/workspace/session-action-availability';

const session: Session = {
  id: 'local-session', projectId: 'project', title: 'task', cwd: '/project', kind: 'agent',
  execution: { providerId: 'native', mode: 'structured', conversationId: 'native-conversation' },
  engineConfig: { schemaVersion: 1, options: {} }, started: true,
  draft: '', status: 'stopped', taskState: 'completed', archived: false, createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z',
};
const descriptor: ExecutionDescriptor = {
  providerId: 'native', mode: 'structured', displayName: 'Native Agent',
  capabilities: { available: true, structured: true, terminal: false, approvals: true, resume: true, fork: false, commands: false,
    contextUsage: true, liveConfig: false, attachments: true, export: true },
  configuration: { schemaVersion: 1, defaults: session.engineConfig, fields: [] },
};
test('session menus retain provider-owned read-only boundaries after moving operations out of the context panel', () => {
  for (const engine of [undefined, { ...descriptor, configuration: { ...descriptor.configuration!, schemaVersion: 2 } }]) {
    const value = sessionActionAvailability(session, engine);
    assert.equal(value.readOnly, true);
    for (const action of ['manage', 'fork', 'export', 'stop', 'continue'] as const) assert.equal(value[action], false, action);
  }
  const corrupt = { ...session, engineConfig: { schemaVersion: 0, options: {} } };
  assert.equal(sessionActionAvailability(corrupt, { ...descriptor, configuration: undefined }).manage, false);
});

test('offline credentials keep local management/export usable while Native never gains Claude fork capability', () => {
  const value = sessionActionAvailability(session, { ...descriptor, capabilities: { ...descriptor.capabilities, available: false, error: 'missing credential' } });
  assert.equal(value.manage, true); assert.equal(value.export, true); assert.equal(value.continue, true); assert.equal(value.fork, false);
  const claude = { ...descriptor, providerId: 'claude', capabilities: { ...descriptor.capabilities, fork: true } };
  assert.equal(sessionActionAvailability({ ...session, execution: { providerId: 'claude', mode: 'structured' } }, claude).fork, true);
  assert.equal(sessionActionAvailability({ ...session, identityPending: true }, claude).fork, false);
  assert.equal(sessionActionAvailability(session, { ...descriptor, capabilities: { ...descriptor.capabilities, export: false } }).export, false);
});

test('maintenance and live tasks cannot archive, delete, fork or continue but stop remains available', () => {
  for (const [target, engine] of [
    [session, { ...descriptor, maintenance: true }],
    [{ ...session, status: 'running', taskState: 'thinking' }, descriptor],
    [{ ...session, taskState: 'waiting_approval' }, descriptor],
  ] as [Session, ExecutionDescriptor][]) {
    const value = sessionActionAvailability(target, engine);
    for (const action of ['manage', 'fork', 'continue'] as const) assert.equal(value[action], false, action);
    assert.equal(value.stop, true);
  }
  assert.equal(sessionActionAvailability(session, { ...descriptor, maintenance: true }).export, false);
});

test('resident structured connections can be managed, while active old terminals remain protected', () => {
  assert.equal(sessionActionAvailability({ ...session, status: 'running', taskState: 'idle' }, descriptor).manage, true);
  const terminal = { ...session, execution: { providerId: 'shell', mode: 'terminal' as const }, kind: 'shell' as const, status: 'running' as const, taskState: 'idle' as const };
  const value = sessionActionAvailability(terminal, { ...descriptor, providerId: 'shell', mode: 'terminal' });
  assert.equal(value.manage, false); assert.equal(value.continue, false); assert.equal(value.stop, true);
});
