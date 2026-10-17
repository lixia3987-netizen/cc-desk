import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NativeAgentRuntime, NativeAgentSnapshot, NativeAgentView } from '../src/shared/chat';
import type { NativeWorkflowQualityState } from '@cc-desk/contracts/native-workflow-quality';
import type { Session, Settings } from '../src/shared/types';
import type { ExecutionDescriptor } from '../src/shared/execution';
import { NativeAgentPanel } from '../src/renderer/NativeAgentPanel';
import { NativeWorkflowQualityPanel } from '../src/renderer/NativeWorkflowQualityPanel';
import { SessionConfig, SessionConfigDraftStore } from '../src/renderer/SessionConfig';
import { EngineDefaultsGroup } from '../src/renderer/SettingsPanel';
import { WorkflowPanel, WorkflowReceiptDetails } from '../src/renderer/WorkflowPanel';
import { emptyWorkflowDraft } from '../src/shared/panel-drafts';

const unexpected = () => { throw new Error('Static rendering cannot start, save or accept execution'); };
const identity = { sessionId: 'one', conversationId: 'conversation', runId: 'current-parent', requestId: 'request', workerGeneration: 1 };
const runtime: NativeAgentRuntime = { parentRunId: identity.runId, maxSubagents: 12, policySource: 'defaults', total: 17, active: 2, running: 1, prepared: 1, completed: 12, failed: 1, cancelled: 2, unknown: 0 };
const child: NativeAgentView = { childId: 'child', batchId: 'batch', taskId: 'task', parentTaskId: 'parent', toolCallId: 'delegate', identity, parentIdentity: identity,
  title: 'Saved child', mode: 'review', status: 'completed', createdAt: '', updatedAt: '', cwd: '/project', receiptPath: '/receipts/child.json' };
const snapshot: NativeAgentSnapshot = { parentRunId: 'previous-parent', items: Array.from({ length: 30 }, (_, index) => ({ ...child, childId: `child-${index}` })), omitted: 27, receiptDirectory: '/receipts/previous' };
const renderAgents = (agents?: NativeAgentSnapshot, policy?: NativeAgentRuntime, loadError?: string) => renderToStaticMarkup(createElement(NativeAgentPanel, { sessionId: 'one', agents, runtime: policy, loadError }));

test('the current effective runtime remains visible before any child starts and never assumes a cap for old records', () => {
  const empty = renderAgents(undefined, { ...runtime, total: 0, active: 0, running: 0, prepared: 0, completed: 0, failed: 0, cancelled: 0 });
  assert.match(empty, /本轮子 Agent/); assert.match(empty, /活跃 0 \/ 有效上限 12 · 已启动 0/);
  assert.match(empty, /策略来源：跟随默认/); assert.match(empty, /完成和取消的任务不占并发/);
  assert.doesNotMatch(empty, /data-agent-id=/);
  const legacy = renderAgents(undefined, { ...runtime, maxSubagents: undefined, policySource: undefined });
  assert.match(legacy, /有效上限 未记录/); assert.match(legacy, /策略来源：旧记录未保存/);
  assert.doesNotMatch(legacy, /有效上限 4/);
});

test('a folded historical list exposes its full count without mixing it into current concurrency', () => {
  const html = renderAgents(snapshot, runtime);
  assert.match(html, /活跃 2 \/ 有效上限 12 · 已启动 17/);
  assert.match(html, /最近一轮子任务记录（57）/); assert.match(html, /已显示 4 \/ 57 条记录/);
  assert.match(html, /此前执行回合，不计入上方本轮活跃数量/);
  assert.equal((html.match(/data-agent-id=/g) ?? []).length, 4);
  assert.match(html, /查看全部子 Agent（30）/); assert.match(html, /另有 27 个结果保留/);
  const stale = renderAgents(snapshot, runtime, 'offline');
  assert.match(stale, /当前状态未知；以下为上次同步记录/); assert.match(stale, /上次记录：运行中 1/);
  assert.doesNotMatch(stale, /data-agent-status="completed"/);
});

const session = (options: Session['engineConfig']['options'] = { maxSubagents: 4 }, providerId = 'native'): Session => ({ id: 'one', title: 'Current session', projectId: 'project', cwd: '/project', kind: 'agent', status: 'idle', started: false, archived: false,
  execution: { providerId, mode: 'structured', conversationId: 'conversation' }, engineConfig: { schemaVersion: 1, options }, createdAt: '', updatedAt: '' });
const descriptor: ExecutionDescriptor = { providerId: 'native', mode: 'structured', displayName: 'Native', configuration: { schemaVersion: 1, defaults: { schemaVersion: 1, options: { maxSubagents: 4 } },
  fields: [{ key: 'maxSubagents', label: '子 Agent 并发上限', type: 'number', min: 1, max: 30 }] }, capabilities: { available: true, structured: true, terminal: false, approvals: true, resume: true, fork: false, commands: false, contextUsage: true, liveConfig: true, attachments: true } };
const settings = { engineDefaults: { native: { schemaVersion: 1, options: { maxSubagents: 12 } } } } as unknown as Settings;
const renderConfig = (target = session(), draftStore?: SessionConfigDraftStore) => renderToStaticMarkup(createElement(SessionConfig, { session: target, descriptor, settings, group: 'limits', draftStore, onError: unexpected }));

test('global changes preserve legacy custom sessions and the source switch is explicit and draft-safe', () => {
  const custom = renderConfig();
  assert.match(custom, /此会话下轮并发上限（已保存）：4 · 来源：此会话单独设置/);
  assert.match(custom, />改为跟随默认（保存后生效）/); assert.match(custom, /全局修改只影响跟随默认的会话/);
  const follows = renderConfig(session({ runtimePolicy: 'defaults', maxSubagents: 4 }));
  assert.match(follows, /此会话下轮并发上限（已保存）：12 · 来源：跟随默认/);
  assert.doesNotMatch(follows, />改为跟随默认（保存后生效）/);
  const store = new SessionConfigDraftStore(); store.observe('one', session().engineConfig);
  store.change('one', { schemaVersion: 1, options: { maxSubagents: 8 } });
  const dirty = renderConfig(session(), store);
  assert.match(dirty, /草稿并发上限：8，保存后用于下一轮/);
  assert.match(dirty, /disabled=""[^>]*>改为跟随默认（保存后生效）/);
  store.observe('one', { schemaVersion: 1, options: { maxSubagents: 6 } });
  const conflict = renderConfig(session({ maxSubagents: 6 }), store);
  assert.match(conflict, /aria-label="会话运行策略来源" disabled=""/);
  assert.match(conflict, /此会话的已保存配置发生变化/);
  const global = renderToStaticMarkup(createElement(EngineDefaultsGroup, { value: settings, onChange: unexpected, executors: [descriptor], group: 'limits', disabled: false }));
  assert.match(global, /选择“跟随默认”的会话，从下一轮开始生效/);
});

test('new Native and old Native drafts explicitly default to adversarial collaboration while Claude has no extra selector', () => {
  const render = (providerId: string, collaboration?: 'parallel' | 'auto' | 'single_agent') => renderToStaticMarkup(createElement(WorkflowPanel, { session: session({}, providerId), draft: { ...emptyWorkflowDraft(), ...(collaboration ? { collaboration } : {}) }, onDraft: unexpected, onError: unexpected, onTemplate: unexpected }));
  const native = render('native');
  assert.match(native, /aria-label="工作流协作方式"/);
  assert.match(native, /value="adversarial" selected=""/);
  assert.match(native, /最多自动审查两轮；人工验收单独记录/);
  assert.match(native, /只读分析核对静态材料与最终交付正文/);
  assert.match(render('native', 'parallel'), /value="parallel" selected=""/);
  for (const mode of ['parallel', 'auto'] as const) {
    assert.match(render('native', mode), /交付前由宿主组织独立审阅者、反例检查者和隔离验证者检查/);
    assert.doesNotMatch(render('native', mode), /不强制独立对抗验证/);
  }
  assert.doesNotMatch(render('native', 'single_agent'), /交付前由宿主组织/);
  assert.doesNotMatch(render('claude'), /工作流协作方式|独立对抗验证|最多自动审查两轮/);
});

const quality: NativeWorkflowQualityState = { version: 1, parentIdentity: identity, taskId: 'parent-task', collaboration: 'adversarial', validationMode: 'commands', status: 'blocked', round: 1, maxRounds: 2, receiptPath: '/receipts/quality.json', updatedAt: '2026-10-17T06:00:00.000Z', automaticReview: 'blocked', manualAcceptance: 'not_requested',
  findings: [{ id: 'finding-1', severity: 'blocking', title: '<script>Failure</script>', detail: 'Incorrect branch', reproduction: 'Run a regression', evidence: [{ toolCallId: 'read-1', path: 'src/main.ts', fileHash: 'a'.repeat(64), startLine: 10, endLine: 12 }] }],
  rounds: [{ round: 1, status: 'blocked', snapshotCommit: 'b'.repeat(40), deliveryDigest: 'c'.repeat(64), roles: ['reviewer', 'challenger', 'verifier'].map((role, index) => ({ role: role as 'reviewer' | 'challenger' | 'verifier', childId: `quality-${role}`, identity: { ...identity, runId: `${role}-run` }, taskId: `task-${index}`, cwd: '/isolated', status: 'completed' })), issues: ['Real command failed'] }] };
const renderQuality = (state?: NativeWorkflowQualityState, loadError?: string) => renderToStaticMarkup(createElement(NativeWorkflowQualityPanel, { state, loadError }));

test('independent reviewer, challenger and verifier completion does not fabricate automatic or manual acceptance', () => {
  const html = renderQuality(quality);
  assert.match(html, /自动审查：阻塞 · 人工验收：未发起/);
  assert.equal((html.match(/报告执行已结束/g) ?? []).length, 3);
  assert.match(html, /独立代码审阅/); assert.match(html, /独立反例检查/); assert.match(html, /隔离验证/);
  assert.match(html, /待处理问题（1）/); assert.match(html, /src\/main.ts:10–12/);
  assert.match(html, /&lt;script&gt;Failure&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>|人工验收：通过|自动审查：通过/);
  assert.match(html, /Real command failed/); assert.match(html, /reviewer-run/);
  assert.match(html, new RegExp(`交付正文 SHA-256：<code>${'c'.repeat(64)}</code>`));
});

test('passed automatic review stays separate from manual acceptance and unavailable records cannot show current success', () => {
  const passed = { ...quality, findings: [], status: 'passed' as const, automaticReview: 'passed' as const };
  assert.match(renderQuality(passed), /自动审查：通过 · 人工验收：未发起/);
  const unavailable = renderQuality(passed, 'offline');
  assert.match(unavailable, /data-quality-status="unknown"/); assert.match(unavailable, /自动审查：状态未知/);
  assert.doesNotMatch(unavailable, /自动审查：通过/);
  assert.match(renderQuality(), /没有独立质量审查记录/);
  const receipt = { version: 1 as const, identity, criteria: [], evidence: [], usage: { modelRequests: 1, toolCalls: 0, activeMs: 0 }, truncated: false };
  assert.match(renderToStaticMarkup(createElement(WorkflowReceiptDetails, { receipt })), /没有独立质量审查记录/);
  assert.match(renderToStaticMarkup(createElement(WorkflowReceiptDetails, { receipt: { ...receipt, workflowQuality: passed } })), /自动审查：通过 · 人工验收：未发起/);
});
