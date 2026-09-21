import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPtyHookBridge, PtyHookObserver, supportsPtyHooks, PTY_HOOK_EVENTS, type PtyHookInput } from '../src/main/pty-hooks';
import type { Capabilities, Session } from '../src/shared/types';

const capabilities = (version: string): Capabilities => ({ available: true, executable: 'claude', version, flags: ['--settings'], efforts: ['default'] });
const input = (id: string, event: PtyHookInput['hook_event_name'], patch: Partial<PtyHookInput> = {}): PtyHookInput => ({ session_id: id, cwd: '/project', hook_event_name: event, ...patch });

test('HTTP hooks require the documented version baseline and settings flag', () => {
  assert.equal(supportsPtyHooks(capabilities('2.1.250 (Claude Code)')), false);
  assert.equal(supportsPtyHooks(capabilities('2.1.251 (Claude Code)')), true);
  assert.equal(supportsPtyHooks(capabilities('v2.1.278')), true);
  assert.equal(supportsPtyHooks(capabilities('unknown')), false);
  assert.equal(supportsPtyHooks({ ...capabilities('2.1.278'), flags: [] }), false);
  assert.equal((PTY_HOOK_EVENTS as readonly string[]).includes('SessionStart'), false);
});

test('main-session hook states distinguish approval, question, parallel tool work, completion and failure', () => {
  const id = randomUUID(); const observer = new PtyHookObserver(id);
  assert.equal(observer.accept(input(id, 'UserPromptSubmit'))?.taskState, 'thinking');
  assert.equal(observer.accept(input(id, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'one' }))?.taskState, 'tool_running');
  observer.accept(input(id, 'PreToolUse', { tool_name: 'Read', tool_use_id: 'two' }));
  assert.equal(observer.accept(input(id, 'PermissionRequest', { tool_name: 'Bash', tool_use_id: 'one' }))?.taskState, 'waiting_approval');
  assert.equal(observer.accept(input(id, 'PostToolUse', { tool_name: 'Read', tool_use_id: 'two' }))?.taskState, 'waiting_approval');
  assert.equal(observer.accept(input(id, 'PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'one' }))?.taskState, 'thinking');
  assert.equal(observer.accept(input(id, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'question' }))?.taskState, 'waiting_input');
  assert.equal(observer.accept(input(id, 'PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'question' }))?.taskState, 'thinking');
  assert.equal(observer.accept(input(id, 'Stop'))?.taskState, 'completed');
  assert.equal(observer.accept(input(id, 'StopFailure'))?.taskState, 'error');
  assert.equal(observer.accept(input(id, 'Stop', { agent_id: 'child' })), null);
});

test('permissions without tool IDs resolve, and model/config observations do not enable bypass launch modes', () => {
  const id = randomUUID(); const observer = new PtyHookObserver(id);
  observer.accept(input(id, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'one' }));
  observer.accept(input(id, 'PermissionRequest', { tool_name: 'Bash' }));
  assert.equal(observer.accept(input(id, 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'one' }))?.taskState, 'thinking');
  const supported = observer.accept(input(id, 'PostModelSwitch', { to_model: 'claude-model', permission_mode: 'plan' }));
  assert.equal(supported?.model, 'claude-model'); assert.equal(supported?.permissionMode, 'plan');
  const unsupported = observer.accept(input(id, 'UserPromptSubmit', { permission_mode: 'bypassPermissions' }));
  assert.equal(unsupported?.permissionMode, undefined); assert.equal(unsupported?.observedPermissionMode, 'bypassPermissions');
});

test('clear/resume await a fresh identity, ignore late old events and allow intentional return to an earlier session', () => {
  const oldId = randomUUID(); const nextId = randomUUID(); const observer = new PtyHookObserver(oldId);
  const ending = observer.accept(input(oldId, 'SessionEnd', { reason: 'clear' }));
  assert.equal(ending?.identityPending, true); assert.equal(ending?.terminalSync, 'waiting');
  assert.equal(observer.accept(input(oldId, 'Stop')), null);
  const fresh = observer.accept(input(nextId, 'UserPromptSubmit'));
  assert.equal(fresh?.claudeId, nextId); assert.equal(fresh?.identityPending, false); assert.equal(fresh?.terminalSync, 'synced');
  assert.equal(observer.accept(input(oldId, 'Stop')), null);
  observer.accept(input(nextId, 'SessionEnd', { reason: 'resume' }));
  assert.equal(observer.accept(input(oldId, 'UserPromptSubmit'))?.claudeId, oldId);
  observer.accept(input(oldId, 'UserPromptSubmit', { prompt_id: 'new-prompt' }));
  assert.equal(observer.accept(input(oldId, 'Stop', { prompt_id: 'old-prompt' }))?.taskState, undefined);
});

test('HTTP bridge authenticates, bounds input, never returns approval decisions, and closes with the run', async () => {
  const id = randomUUID(); const patches: Partial<Session>[] = [];
  const bridge = await createPtyHookBridge(id, patch => patches.push(patch));
  const config = JSON.parse(bridge.settings);
  const handler = config.hooks.PermissionRequest[0].hooks[0];
  assert.deepEqual(Object.keys(config), ['hooks']);
  assert.equal(handler.type, 'http'); assert.match(handler.url, /^http:\/\/127\.0\.0\.1:\d+\/events$/);
  const send = (payload: unknown, authorization = handler.headers.Authorization) => fetch(handler.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization }, body: JSON.stringify(payload) });
  try {
    assert.equal((await send(input(id, 'Stop'), 'Bearer incorrect')).status, 403); assert.equal(patches.length, 0);
    assert.equal((await send({ ...input(id, 'Stop'), session_id: '../invalid' })).status, 400);
    assert.equal((await send({ ...input(id, 'Stop'), padding: 'x'.repeat(2 * 1024 * 1024) })).status, 413);
    const result = await send({ ...input(id, 'PermissionRequest', { tool_name: 'Bash', permission_mode: 'default' }), tool_input: { command: 'never execute this' }, prompt: 'private text' });
    assert.equal(result.status, 200); assert.equal(await result.text(), '');
    assert.equal(patches[0].taskState, 'waiting_approval'); assert.equal(JSON.stringify(patches).includes('private text'), false);
    await send(input(id, 'Stop', { agent_id: 'child' })); assert.equal(patches.length, 1);
  } finally { await bridge.close(); }
  await assert.rejects(send(input(id, 'Stop')));
});

test('UI/persistence errors never turn an observer hook into a permission decision', async () => {
  const id = randomUUID(); const bridge = await createPtyHookBridge(id, () => { throw new Error('disk full'); });
  const handler = JSON.parse(bridge.settings).hooks.PermissionRequest[0].hooks[0];
  try {
    const response = await fetch(handler.url, { method: 'POST', headers: { ...handler.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(input(id, 'PermissionRequest')) });
    assert.equal(response.status, 200); assert.equal(await response.text(), '');
  } finally { await bridge.close(); }
});
