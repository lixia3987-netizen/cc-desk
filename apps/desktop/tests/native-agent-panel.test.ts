import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatApproval, NativeAgentSnapshot, NativeAgentView, NativeAgentResult } from '../src/shared/chat';
import { NativeAgentPanel, NativeAgentSavedResult } from '../src/renderer/NativeAgentPanel';
import { NativeChildApprovalContext } from '../src/renderer/NativeChildApprovalContext';

const identity = { sessionId: 'child-session', conversationId: 'child-conversation', runId: 'child-run', requestId: 'request', workerGeneration: 1 };
const child: NativeAgentView = { childId: 'child', batchId: 'batch', taskId: 'task', parentTaskId: 'parent-task', toolCallId: 'delegate',
  identity, parentIdentity: { ...identity, sessionId: 'parent-session', conversationId: 'parent-conversation', runId: 'parent-run' },
  title: '审阅实现', mode: 'implement', status: 'completed', createdAt: '2026-10-08T01:00:00.000Z', updatedAt: '2026-10-08T01:01:00.000Z',
  receiptPath: 'F:\\private data\\receipt.json', cwd: 'F:\\workspace', summary: '<script>untrusted summary</script>',
  worktree: { path: 'F:\\workspace', cwd: 'F:\\workspace', branch: 'codex/native-agent-child', baseCommit: 'a'.repeat(40), parentHead: 'b'.repeat(40), baseline: 'snapshot', verified: true },
  artifact: { patchPath: 'F:\\private data\\workspace.diff.patch', changedFiles: [{ path: 'src/example.ts', status: 'M' }], omittedFiles: 0 },
  evidence: { taskSnapshotPath: 'F:\\private data\\tasks.json', runJournalPath: 'F:\\private data\\journal.jsonl',
    commandReceipts: [{ toolCallId: 'check', status: 'completed', exitCode: 0, receiptPath: 'F:\\private data\\journal.jsonl' }] }, usage: { modelRequests: 2, toolCalls: 3 } };
const snapshot: NativeAgentSnapshot = { parentRunId: 'parent-run', items: [child], omitted: 0, receiptDirectory: 'F:\\private data\\delegations' };
const render = (agents?: NativeAgentSnapshot, loadError?: string) => renderToStaticMarkup(createElement(NativeAgentPanel, { sessionId: 'parent-session', agents, loadError }));

test('child completion renders retained references and review semantics without claiming task acceptance', () => {
  const markup = render(snapshot);
  assert.match(markup, /aria-label="Native Agent 协作"/); assert.match(markup, /data-agent-status="completed"/);
  assert.match(markup, /执行已完成/); assert.match(markup, /任务验收需另行确认/); assert.ok(!markup.includes('验收通过'));
  assert.match(markup, /href="#native-agent-child-task"/); assert.match(markup, /href="#native-agent-child-run"/);
  assert.match(markup, /href="#native-agent-child-worktree"/); assert.match(markup, /href="#native-agent-child-patch"/);
  assert.match(markup, /复制执行回执路径/); assert.match(markup, /复制隔离分支/); assert.match(markup, /退出码：0/);
  assert.match(markup, /父工作区修改快照/); assert.match(markup, /&lt;script&gt;/); assert.ok(!markup.includes('<script>'));
});

test('the panel initially exposes four children while keeping the complete bounded list available', () => {
  const agents = { ...snapshot, items: Array.from({ length: 16 }, (_, index) => ({ ...child, childId: `child-${index}` })) };
  const markup = render(agents);
  assert.equal((markup.match(/data-agent-id=/g) ?? []).length, 4);
  assert.match(markup, /查看全部子 Agent（16）/);
  assert.equal((markup.match(/查看保存成果/g) ?? []).length, 4);
});

test('saved patch and goal remain escaped text with honest integrity and evidence labels', () => {
  const result: NativeAgentResult = { agent: child, goal: '<img src=x onerror=alert(1)>', acceptance: 'not_assessed',
    patch: { sha256: 'c'.repeat(64), integrity: 'legacy_unverified', text: '<script>patch</script>', offset: 0, nextOffset: null, totalCharacters: 22, totalBytes: 22 } };
  const markup = renderToStaticMarkup(createElement(NativeAgentSavedResult, { result }));
  assert.match(markup, /&lt;script&gt;patch&lt;\/script&gt;/); assert.ok(!markup.includes('<script>'));
  assert.match(markup, /&lt;img src=x/); assert.ok(!markup.includes('<img src=x'));
  assert.match(markup, /旧记录缺少原始哈希/); assert.match(markup, /退出码为 0 不能代替任务验收/);
  assert.match(markup, /隔离分支不代表改动已提交或已合入/); assert.match(markup, /父任务验收尚未确认/);
  assert.match(markup, /aria-label="保存补丁内容"/); assert.match(markup, /退出码：0/);
});
test('failed snapshot reads mask apparently running or complete states as unknown and preserve saved evidence', () => {
  const markup = render(snapshot, '读取失败'); assert.match(markup, /data-agent-status="unknown"/);
  assert.match(markup, /当前状态未知：读取失败/); assert.match(markup, /执行回执路径/); assert.ok(!markup.includes('data-agent-status="completed"'));
  const missing = render({ ...snapshot, items: [{ ...child, status: 'unknown', missingTerminal: true }], omitted: 5 });
  assert.match(missing, /无法确认子 Agent 已停止/); assert.match(missing, /另有 5 个结果保留/); assert.match(missing, /父回合子 Agent 记录目录/);
  assert.equal(render(), ''); assert.equal(render({ ...snapshot, items: [] }), '');
  assert.match(render({ ...snapshot, items: [], incomplete: true }), /部分子 Agent 记录无法读取或校验/);
});
test('child approval explicitly exposes the host-provided child title and target worktree', () => {
  const markup = renderToStaticMarkup(createElement(NativeChildApprovalContext, { scope: { title: '隔离实现 A', cwd: 'F:\\isolated\\A', taskId: 'task', runId: 'run' } }));
  assert.match(markup, /aria-label="子 Agent 操作范围"/); assert.match(markup, /隔离实现 A/); assert.match(markup, /F:\\isolated\\A/);
  const modelArgument: ChatApproval = { requestId: 'request', toolName: 'untrusted_external_tool', createdAt: '2026-10-08T01:00:00.000Z', kind: 'permission',
    input: { delegatedAgent: { title: 'spoofed child', cwd: 'F:\\spoofed', taskId: 'task', runId: 'run' } } };
  assert.equal(renderToStaticMarkup(createElement(NativeChildApprovalContext, { scope: modelArgument.nativeDelegation })), '');
});
