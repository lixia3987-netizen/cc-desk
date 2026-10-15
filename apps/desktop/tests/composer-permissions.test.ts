import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComposerPermissionMode } from '../src/renderer/ComposerPermissionMode';
import type { Session } from '../src/shared/types';
import type { ExecutionDescriptor } from '../src/shared/execution';
import { NATIVE_PERMISSION_MODES, NATIVE_PERMISSION_LABELS } from '../src/shared/native-permissions';

const session: Session = { id: 'native-composer', projectId: 'project', title: 'task', cwd: '/fixture', kind: 'agent',
  execution: { providerId: 'native', mode: 'structured' }, engineConfig: { schemaVersion: 1, options: { permissionMode: 'acceptEdits' } },
  started: false, status: 'idle', archived: false, createdAt: '', updatedAt: '' };
const descriptor: ExecutionDescriptor = { providerId: 'native', mode: 'structured', displayName: '自研 Agent',
  capabilities: { available: true, structured: true, terminal: false, approvals: true, resume: false, fork: false,
    commands: false, contextUsage: true, liveConfig: false, attachments: false },
  configuration: { schemaVersion: 1, defaults: { schemaVersion: 1, options: { permissionMode: 'default' } }, fields: [
    { key: 'permissionMode', label: '权限模式', type: 'select', apply: 'stopped', options: NATIVE_PERMISSION_MODES.map(value => ({ value, label: NATIVE_PERMISSION_LABELS[value] })) },
  ] } };
const render = (target = session, engine: ExecutionDescriptor | undefined = descriptor, running = false, disabled = false) =>
  renderToStaticMarkup(createElement(ComposerPermissionMode, { session: target, descriptor: engine, running, disabled, onError: () => {} }));

test('composer shows current saved permissions and legacy sessions default to individual approval', () => {
  const markup = render();
  assert.match(markup, /aria-label="发送权限模式"/);
  assert.match(markup, /value="acceptEdits" selected=""/);
  assert.doesNotMatch(markup, /<select[^>]*disabled/);
  assert.match(render({ ...session, engineConfig: { schemaVersion: 1, options: {} } }), /value="default" selected=""/);
});

test('active Native sessions can select the next-round mode while archived and maintenance sessions are locked', () => {
  const running = render({ ...session, status: 'running', taskState: 'waiting_approval' }, descriptor, true);
  assert.match(running, /下轮生效/);
  assert.doesNotMatch(running, /<select[^>]*disabled/);
  assert.match(render({ ...session, archived: true }), /<select[^>]*disabled/);
  assert.match(render(session, { ...descriptor, maintenance: true }), /<select[^>]*disabled/);
  assert.match(render(session, descriptor, false, true), /<select[^>]*disabled/);
});

test('unsupported providers do not get a permission selector and busy Claude remains locked', () => {
  assert.equal(render(session, { ...descriptor, configuration: { ...descriptor.configuration!, fields: [] } }), '');
  const claude = { ...session, execution: { providerId: 'claude', mode: 'structured' as const }, status: 'running' as const, taskState: 'thinking' as const };
  assert.match(render(claude, { ...descriptor, providerId: 'claude' }, true), /<select[^>]*disabled/);
});
