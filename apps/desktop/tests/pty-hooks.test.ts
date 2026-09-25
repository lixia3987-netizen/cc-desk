import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPtyHookBridge, PtyHookObserver, supportsPtyHooks, PTY_HOOK_EVENTS, type PtyHookInput, type PtySubtaskEvent } from '../src/main/pty-hooks';
import { StateStore } from '../src/main/store';
import { SubtaskTracker } from '../src/main/subtask-tracker';
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

test('only accepted main-session prompt hooks supply automatic naming text', async () => {
  const id = randomUUID(), nextId = randomUUID(); const prompts: string[] = [];
  const bridge = await createPtyHookBridge(id, () => {}, undefined, prompt => prompts.push(prompt));
  const handler = JSON.parse(bridge.settings).hooks.UserPromptSubmit[0].hooks[0];
  const send = async (event: PtyHookInput) => {
    const response = await fetch(handler.url, { method: 'POST', headers: { ...handler.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(event) });
    assert.equal(response.status, 200); assert.equal(await response.text(), '');
  };
  try {
    await send(input(id, 'UserPromptSubmit', { prompt_id: 'one', prompt: '修复登录页面' }));
    await send(input(id, 'UserPromptSubmit', { prompt_id: 'one', agent_id: 'child', prompt: '不应覆盖父会话' }));
    await send(input(id, 'UserPromptSubmit', { prompt_id: 'two', prompt: '增加回归测试' }));
    await send(input(id, 'UserPromptSubmit', { prompt_id: 'one', prompt: '迟到旧消息' }));
    await send(input(id, 'Stop', { prompt: '完成事件不是用户消息' }));
    await send(input(id, 'SessionEnd', { reason: 'clear' }));
    await send(input(id, 'UserPromptSubmit', { prompt: '身份切换期间的旧消息' }));
    await send(input(nextId, 'UserPromptSubmit', { prompt_id: 'fresh', prompt: '整理项目文档' }));
    await send(input(id, 'UserPromptSubmit', { prompt: '旧身份消息' }));
    assert.deepEqual(prompts, ['修复登录页面', '增加回归测试', '整理项目文档']);
  } finally { await bridge.close(); }
  const observer = new PtyHookObserver(id, undefined, () => { throw new Error('naming unavailable'); });
  assert.equal(observer.accept(input(id, 'UserPromptSubmit', { prompt: '保存失败不能阻止原生执行' }))?.taskState, 'thinking');
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

test('permissions without tool IDs resolve, supported modes synchronize and unknown launch modes remain observations', () => {
  const id = randomUUID(); const observer = new PtyHookObserver(id);
  observer.accept(input(id, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'one' }));
  observer.accept(input(id, 'PermissionRequest', { tool_name: 'Bash' }));
  assert.equal(observer.accept(input(id, 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'one' }))?.taskState, 'thinking');
  const supported = observer.accept(input(id, 'PostModelSwitch', { to_model: 'claude-model', permission_mode: 'plan' }));
  assert.equal(supported?.model, 'claude-model'); assert.equal(supported?.permissionMode, 'plan');
  const bypass = observer.accept(input(id, 'UserPromptSubmit', { permission_mode: 'bypassPermissions' }));
  assert.equal(bypass?.permissionMode, 'bypassPermissions'); assert.equal(bypass?.observedPermissionMode, 'bypassPermissions');
  const unsupported = observer.accept(input(id, 'UserPromptSubmit', { permission_mode: 'auto' }));
  assert.equal(unsupported?.permissionMode, undefined); assert.equal(unsupported?.observedPermissionMode, 'auto');
});

test('clear/resume await a fresh identity, ignore late old events and allow intentional return to an earlier session', () => {
  const oldId = randomUUID(); const nextId = randomUUID(); const observer = new PtyHookObserver(oldId);
  const ending = observer.accept(input(oldId, 'SessionEnd', { reason: 'clear' }));
  assert.equal(ending?.identityPending, true); assert.equal(ending?.terminalSync, 'waiting');
  assert.equal(observer.accept(input(oldId, 'Stop')), null);
  const fresh = observer.accept(input(nextId, 'UserPromptSubmit'));
  assert.equal(fresh?.conversationId, nextId); assert.equal(fresh?.identityPending, false); assert.equal(fresh?.terminalSync, 'synced');
  assert.equal(observer.accept(input(oldId, 'Stop')), null);
  observer.accept(input(nextId, 'SessionEnd', { reason: 'resume' }));
  assert.equal(observer.accept(input(oldId, 'UserPromptSubmit'))?.conversationId, oldId);
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

test('subagents report lifecycle and approval progress without replacing main-session state', () => {
  const id = randomUUID(); const events: PtySubtaskEvent[] = [];
  const observer = new PtyHookObserver(id, event => events.push(event));
  const send = (event: PtyHookInput['hook_event_name'], patch: Partial<PtyHookInput> = {}) => observer.accept(input(id, event, { prompt_id: 'prompt-one', ...patch }));
  send('UserPromptSubmit');
  assert.equal(send('SubagentStop', { agent_id: 'internal' }), null);
  assert.equal(events.length, 1, 'a spontaneous stop does not invent a user task');
  assert.equal(send('SubagentStart', { agent_id: 'review', agent_type: '代码审查', permission_mode: 'bypassPermissions' }), null);
  send('SubagentStart', { agent_id: 'review' });
  send('SubagentStart', { agent_id: 'test', agent_type: '测试' });
  assert.equal(events.filter(event => event.type === 'observe').length, 2, 'duplicate starts count once');
  const child = (event: PtyHookInput['hook_event_name'], patch: Partial<PtyHookInput> = {}) => send(event, { agent_id: 'review', ...patch });
  assert.equal(child('PostModelSwitch', { to_model: 'child-model', permission_mode: 'plan' }), null);
  assert.equal(child('PreToolUse', { tool_name: 'Bash', tool_use_id: 'bash-one' }), null);
  child('PermissionRequest', { tool_name: 'Bash' });
  let last = events.at(-1); assert.equal(last?.type === 'observe' && last.observation.status, 'waiting_approval');
  child('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'bash-one' });
  last = events.at(-1); assert.equal(last?.type === 'observe' && last.observation.status, 'running', 'a tool error may recover');
  child('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'ask-one' });
  last = events.at(-1); assert.equal(last?.type === 'observe' && last.observation.status, 'waiting_input');
  child('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'ask-one' });
  assert.equal(send('Stop')?.taskState, 'completed');
  assert.equal(events.some(event => event.type === 'end'), false, 'parent response end is not child completion');
  child('SubagentStop', { last_assistant_message: '审查完成' });
  last = events.at(-1);
  assert.equal(last?.type === 'observe' && last.observation.status, 'completed');
  assert.equal(last?.type === 'observe' && last.observation.summary, '审查完成');
  const count = events.length;
  child('SubagentStop'); child('PreToolUse', { tool_name: 'Read' });
  assert.equal(events.length, count, 'late child events cannot resurrect a finished task');
  assert.equal(send('StopFailure', { agent_id: 'test' }), null);
  last = events.at(-1); assert.equal(last?.type === 'observe' && last.observation.status, 'failed');
  const failedCount = events.length;
  send('SubagentStop', { agent_id: 'test' });
  assert.equal(events.length, failedCount, 'a later stop cannot overwrite a confirmed child response failure');
});

test('resuming the same hook agent within one prompt creates a separate invocation record', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-desk-hook-resume-'));
  const store = new StateStore(directory); const id = randomUUID(); const claudeId = randomUUID(); const now = new Date().toISOString();
  store.change(state => state.sessions.push({ id, projectId: randomUUID(), title: 'hook resume', kind: 'agent',
    cwd: directory, execution: { providerId: 'claude', mode: 'terminal', conversationId: claudeId }, started: true, engineConfig: { schemaVersion: 1, options: { model: '', effort: 'default', permissionMode: 'default' } },
    status: 'running', archived: false, createdAt: now, updatedAt: now }));
  const tracker = new SubtaskTracker(store, () => {});
  const observer = new PtyHookObserver(claudeId, event => {
    if (event.type === 'begin') tracker.begin(id, event.turnId);
    else if (event.type === 'observe') tracker.observe(id, event.observation);
    else tracker.end(id, event.status, event.reason);
  });
  const send = (event: PtyHookInput['hook_event_name'], patch: Partial<PtyHookInput> = {}) => observer.accept(input(claudeId, event, { prompt_id: 'same-prompt', ...patch }));
  const tasks = () => store.state.sessions[0].subtasks!.tasks;
  try {
    send('UserPromptSubmit');
    send('SubagentStart', { agent_id: 'resumed-agent', agent_type: 'Explore' });
    send('SubagentStop', { agent_id: 'resumed-agent', last_assistant_message: '第一轮完成' });
    const firstId = tasks()[0].taskId;
    send('SubagentStart', { agent_id: 'resumed-agent', agent_type: 'Explore' });
    assert.equal(tasks().length, 2);
    assert.deepEqual(tasks().map(task => task.status), ['completed', 'running']);
    assert.equal(tasks()[0].turnId, tasks()[1].turnId);
    assert.notEqual(tasks()[1].taskId, firstId);
    send('SubagentStart', { agent_id: 'resumed-agent' });
    assert.equal(tasks().length, 2, 'a duplicate start while running does not create a third invocation');
    send('PermissionRequest', { agent_id: 'resumed-agent', tool_name: 'Bash', tool_use_id: 'second-tool' });
    assert.deepEqual(tasks().map(task => task.status), ['completed', 'waiting_approval']);
    assert.equal(tasks()[0].lastTool, undefined);
    send('SubagentStop', { agent_id: 'resumed-agent', last_assistant_message: '恢复后完成' });
    assert.deepEqual(tasks().map(task => task.status), ['completed', 'completed']);
    assert.deepEqual(tasks().map(task => task.summary), ['第一轮完成', '恢复后完成']);
  } finally { store.flush(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('background agents retain their original turn across prompts and reject unrelated delayed events', () => {
  const id = randomUUID(); const events: PtySubtaskEvent[] = [];
  const observer = new PtyHookObserver(id, event => events.push(event));
  observer.accept(input(id, 'UserPromptSubmit', { prompt_id: 'old' }));
  observer.accept(input(id, 'SubagentStart', { agent_id: 'background', prompt_id: 'old' }));
  const started = events.at(-1);
  observer.accept(input(id, 'UserPromptSubmit', { prompt_id: 'new' }));
  const count = events.length;
  observer.accept(input(id, 'SubagentStart', { agent_id: 'stale-start', prompt_id: 'old' }));
  observer.accept(input(id, 'PreToolUse', { agent_id: 'background', prompt_id: 'new', tool_name: 'Read' }));
  assert.equal(observer.accept(input(id, 'UserPromptSubmit', { prompt_id: 'old' })), null);
  assert.equal(events.length, count);
  observer.accept(input(id, 'SubagentStop', { agent_id: 'background', prompt_id: 'old', last_assistant_message: '后台完成' }));
  const ended = events.at(-1);
  assert.equal(ended?.type === 'observe' && ended.observation.status, 'completed');
  assert.equal(ended?.type === 'observe' && ended.observation.turnId, started?.type === 'observe' && started.observation.turnId);
  observer.accept(input(id, 'SubagentStart', { agent_id: 'background', prompt_id: 'new' }));
  const restarted = events.at(-1);
  assert.notEqual(restarted?.type === 'observe' && restarted.observation.turnId, started?.type === 'observe' && started.observation.turnId);
});

test('identity switches retire children and inherited hooks cannot resolve an awaited identity', () => {
  const id = randomUUID(); const nextId = randomUUID(); const events: PtySubtaskEvent[] = [];
  const observer = new PtyHookObserver(id, event => events.push(event));
  observer.accept(input(id, 'SubagentStart', { agent_id: 'before-prompt' }));
  assert.equal(events.length, 0);
  observer.accept(input(id, 'UserPromptSubmit'));
  observer.accept(input(id, 'SubagentStart', { agent_id: 'old' }));
  observer.accept(input(id, 'SessionEnd', { reason: 'resume' }));
  assert.equal(events.at(-1)?.type, 'end');
  const count = events.length;
  assert.equal(observer.accept(input(nextId, 'SubagentStart', { agent_id: 'unknown' })), null);
  assert.equal(observer.accept(input(id, 'SubagentStop', { agent_id: 'old' })), null);
  assert.equal(events.length, count);
  assert.equal(observer.accept(input(nextId, 'UserPromptSubmit'))?.conversationId, nextId);
  const switchedCount = events.length;
  observer.accept(input(id, 'SubagentStart', { agent_id: 'delayed' }));
  observer.accept(input(nextId, 'SubagentStop', { agent_id: 'old' }));
  assert.equal(events.length, switchedCount);
});

test('HTTP child hooks expose only bounded observations and never read transcript paths', async () => {
  const id = randomUUID(); const events: PtySubtaskEvent[] = []; const patches: Partial<Session>[] = [];
  const bridge = await createPtyHookBridge(id, patch => patches.push(patch), event => events.push(event));
  const hooks = JSON.parse(bridge.settings).hooks;
  assert.ok(hooks.SubagentStart); assert.ok(hooks.SubagentStop);
  const handler = hooks.SubagentStart[0].hooks[0];
  const send = (payload: unknown) => fetch(handler.url, { method: 'POST', headers: { ...handler.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  try {
    await send(input(id, 'UserPromptSubmit'));
    await send({ ...input(id, 'SubagentStart', { agent_id: 'worker', agent_type: 'Explore' }), agent_transcript_path: '/private/never-read', prompt: 'not persisted' });
    assert.equal((await send(input(id, 'SubagentStart', { agent_id: 'x'.repeat(201) }))).status, 400);
    const response = await send({ ...input(id, 'SubagentStop', { agent_id: 'worker', last_assistant_message: 'x'.repeat(5000) }), agent_transcript_path: '/private/never-read' });
    assert.equal(response.status, 200); assert.equal(await response.text(), '');
    const last = events.at(-1);
    assert.equal(last?.type === 'observe' && last.observation.summary?.length, 4000);
    assert.equal(patches.length, 1, 'child hooks cannot update main metadata');
    assert.equal(JSON.stringify(events).includes('never-read'), false);
    assert.equal(JSON.stringify(events).includes('not persisted'), false);
  } finally { await bridge.close(); }
});

test('subtask observer failures do not block parent metadata or native hook responses', async () => {
  const id = randomUUID(); const patches: Partial<Session>[] = [];
  const bridge = await createPtyHookBridge(id, patch => patches.push(patch), () => { throw new Error('disk full'); });
  const handler = JSON.parse(bridge.settings).hooks.SubagentStart[0].hooks[0];
  try {
    for (const payload of [input(id, 'UserPromptSubmit'), input(id, 'SubagentStart', { agent_id: 'worker' }), input(id, 'SubagentStop', { agent_id: 'worker' })]) {
      const response = await fetch(handler.url, { method: 'POST', headers: { ...handler.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      assert.equal(response.status, 200); assert.equal(await response.text(), '');
    }
    assert.equal(patches[0].taskState, 'thinking');
  } finally { await bridge.close(); }
});
