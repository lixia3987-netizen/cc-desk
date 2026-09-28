import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NativeMcpChoices, NativeMcpSelection, toggleMcpConnection } from '../src/renderer/components/NativeMcpSelection';
import { NativeMcpConnections, submitMcpCredential } from '../src/renderer/components/NativeMcpConnections';
import { SessionConfig } from '../src/renderer/SessionConfig';
import type { NativeMcpConnectionInput, NativeMcpConnectionList, NativeMcpConnectionView } from '../src/shared/native-mcp';
import type { Session } from '../src/shared/types';
import type { ExecutionDescriptor } from '../src/shared/execution';

const fail = () => { throw new Error('Initial rendering must not read or change connections'); };
function connection(id: string, options: Partial<NativeMcpConnectionView> = {}): NativeMcpConnectionView {
  return { id, name: 'same-name', revision: 1, endpoint: `https://${id}.example.test/mcp`, allowLoopbackHttp: false,
    enabled: true, auth: { mode: 'none' }, credentialConfigured: true, ready: true, ...options };
}
const result: NativeMcpConnectionList = { connections: [connection('one'), connection('two'), connection('disabled', { enabled: false, ready: false }), connection('unready', { ready: false, error: '<script>missing token</script>' })], storage: { persistentAvailable: false } };
const renderChoices = (selected: string[], data: NativeMcpConnectionList | undefined = result, disabled = false) => renderToStaticMarkup(createElement(NativeMcpChoices, { selected, result: data, disabled, onChange: fail }));
function inputs(node: ReactNode): Array<{ checked: boolean; disabled: boolean; onChange(): void }> {
  if (Array.isArray(node)) return node.flatMap(inputs);
  if (!isValidElement<{ children?: ReactNode; checked: boolean; disabled: boolean; onChange(): void }>(node)) return [];
  return node.type === 'input' ? [node.props] : inputs(node.props.children);
}

test('MCP selection starts empty and reads metadata only after an explicit action', () => {
  const initial = renderToStaticMarkup(createElement(NativeMcpSelection, { sessionId: 'one', selected: [], onChange: fail }));
  assert.match(initial, /已选 0 \/ 4/);
  assert.match(initial, /type="button"[^>]*>读取 MCP 连接<\/button>/);
  assert.match(initial, /不访问远端服务/);
  assert.match(initial, /每次工具调用仍需审批/);
  assert.doesNotMatch(initial, /type="checkbox"/);
  const saved = renderToStaticMarkup(createElement(NativeMcpSelection, { sessionId: 'one', selected: ['missing'], onChange: fail }));
  assert.match(saved, /已保存的选择，尚未读取连接列表/);
  assert.match(saved, /checked=""/);
  assert.doesNotMatch(saved, /disabled=""/);
});

test('MCP choices disambiguate IDs, preserve missing entries, and escape metadata', () => {
  const markup = renderChoices(['two', 'gone']);
  assert.match(markup, /aria-label="MCP same-name \(one\)"/);
  assert.match(markup, /aria-label="MCP same-name \(two\)" checked=""/);
  assert.match(markup, /aria-label="MCP gone \(gone\)" checked=""/);
  assert.match(markup, /连接当前不可用，已保留选择；可取消勾选/);
  assert.match(markup, /已禁用/);
  assert.match(markup, /未就绪/);
  assert.match(markup, /&lt;script&gt;missing token&lt;\/script&gt;/);
  assert.doesNotMatch(markup, /<script>/);
});

test('actual checkbox handlers reject unavailable additions but allow unavailable saved selections to be removed', () => {
  let selected = ['disabled', 'missing'];
  const choices = inputs(NativeMcpChoices({ selected, result, onChange: next => { selected = next; } }));
  choices[3].onChange(); // Unready connection cannot be added.
  assert.deepEqual(selected, ['disabled', 'missing']);
  choices[2].onChange();
  assert.deepEqual(selected, ['missing']);
  const fresh = inputs(NativeMcpChoices({ selected, result, onChange: next => { selected = next; } }));
  fresh[4].onChange();
  assert.deepEqual(selected, []);
  inputs(NativeMcpChoices({ selected, result, onChange: next => { selected = next; } }))[1].onChange();
  assert.deepEqual(selected, ['two']);
});

test('four-service limit, metadata errors and active-session locks are enforced by event handlers', () => {
  const selected = ['a', 'b', 'c', 'd'];
  const full = inputs(NativeMcpChoices({ selected, result, onChange: fail }));
  full.slice(0, 4).forEach(input => { assert.equal(input.disabled, true); input.onChange(); });
  assert.deepEqual(toggleMcpConnection(selected, 'one'), selected);
  assert.deepEqual(toggleMcpConnection(selected, 'b'), ['a', 'c', 'd']);
  const locked = inputs(NativeMcpChoices({ selected: ['one'], result, disabled: true, onChange: fail }));
  locked.forEach(input => { assert.equal(input.disabled, true); input.onChange(); });
  const failed = inputs(NativeMcpChoices({ selected: [], result: { ...result, error: '元数据不可用' }, onChange: fail }));
  failed.forEach(input => { assert.equal(input.disabled, true); input.onChange(); });
});

function session(providerId = 'native'): Session {
  return { id: 'one', projectId: 'project', title: 'MCP', kind: 'agent', cwd: '/project', execution: { providerId, mode: 'structured' },
    engineConfig: { schemaVersion: 1, options: { mcpConnections: ['saved'] } }, started: false, status: 'idle', archived: false, createdAt: '', updatedAt: '' };
}
function descriptor(providerId = 'native'): ExecutionDescriptor {
  return { providerId, mode: 'structured', displayName: 'Native', capabilities: { available: true, structured: true, terminal: false, approvals: true, resume: true, fork: false, commands: false, contextUsage: true, liveConfig: true, attachments: false }, configuration: { schemaVersion: 1, defaults: { schemaVersion: 1, options: {} }, fields: [] } };
}
const renderConfig = (value = session(), executor = descriptor()) => renderToStaticMarkup(createElement(SessionConfig, { session: value, descriptor: executor, onError: fail }));

test('MCP session selector only appears for native structured sessions and shares config persistence', () => {
  const markup = renderConfig();
  assert.match(markup, /aria-label="会话 MCP 工具"/);
  assert.match(markup, /保存配置/);
  for (const provider of ['claude', 'shell', 'other']) assert.doesNotMatch(renderConfig(session(provider), descriptor(provider)), /aria-label="会话 MCP 工具"/);
  const terminal = session(); terminal.execution.mode = 'terminal';
  assert.doesNotMatch(renderConfig(terminal), /aria-label="会话 MCP 工具"/);
  const running = session(); running.status = 'running'; running.taskState = 'idle';
  assert.match(renderConfig(running), /disabled=""[^>]*>读取 MCP 连接<\/button>/);
  assert.match(renderConfig(running), /aria-label="MCP saved \(saved\)" disabled="" checked=""/);
  assert.match(renderConfig(session(), { ...descriptor(), maintenance: true }), /disabled=""[^>]*>读取 MCP 连接<\/button>/);
});

test('future MCP selection shape is preserved without coercion or an editable checkbox list', () => {
  const value = session(); value.engineConfig.options.mcpConnections = { future: ['keep'] };
  assert.match(renderConfig(value), /当前 MCP 连接配置无法编辑，原始值已保留/);
  assert.doesNotMatch(renderConfig(value), /aria-label="会话 MCP 工具"/);
  assert.deepEqual(value.engineConfig.options.mcpConnections, { future: ['keep'] });
});

test('MCP settings explain local-only operations, supported transport, and explicit session selection', () => {
  const markup = renderToStaticMarkup(createElement(NativeMcpConnections));
  assert.match(markup, /Native MCP 连接/);
  assert.match(markup, /MCP HTTP 2026-07-28/);
  assert.match(markup, /旧协议与 stdio 暂不支持/);
  assert.match(markup, /默认引擎仍为 Claude/);
  assert.doesNotMatch(markup, /测试连接|type="password"/);
});

test('MCP credential submission uses the write-only API and clears the DOM field immediately', async () => {
  const draft: NativeMcpConnectionInput = { ...connection('one'), auth: { mode: 'memory' } };
  const input = { value: 'secret-input-only' };
  let received: unknown;
  let finish!: (value: NativeMcpConnectionView) => void;
  const pending = new Promise<NativeMcpConnectionView>(resolve => { finish = resolve; });
  const api = { setCredential: (value: unknown) => { received = value; return pending; } };
  const response = submitMcpCredential(api, draft, input);
  assert.equal(input.value, '');
  assert.deepEqual(received, { id: 'one', revision: 1, mode: 'memory', secret: 'secret-input-only' });
  assert.doesNotMatch(JSON.stringify(draft), /secret-input-only/);
  finish(connection('one', { revision: 2 }));
  assert.equal((await response).revision, 2);
});

test('MCP credential clearing also covers synchronous bridge errors, rejection and invalid drafts', async () => {
  const draft: NativeMcpConnectionInput = { ...connection('one'), auth: { mode: 'encrypted' } };
  for (const setCredential of [() => { throw new Error('invoke failed'); }, () => Promise.reject(new Error('invoke failed'))]) {
    const input = { value: 'never-retain-me' };
    await assert.rejects(async () => await submitMcpCredential({ setCredential }, draft, input), /invoke failed/);
    assert.equal(input.value, '');
  }
  const input = { value: 'clear-invalid-too' };
  assert.throws(() => submitMcpCredential({ setCredential: fail }, { ...draft, id: undefined }, input), /请先保存/);
  assert.equal(input.value, '');
});
