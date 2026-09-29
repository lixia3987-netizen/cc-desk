import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NativeContextMaintenance, NativeRecoveryStatus } from '../src/shared/chat';
import { ContextMeter } from '../src/renderer/ContextMeter';
import { NativeRecoveryPanel } from '../src/renderer/NativeRecoveryPanel';

const fail = () => { throw new Error('Rendering must not perform an operation'); };
const recovery: NativeRecoveryStatus = { status: 'recoverable', headHash: 'a'.repeat(64), tools: { completed: 2, notExecuted: 1, unknown: 0 } };
const renderRecovery = (status: NativeRecoveryStatus['status'], disabled = false, pending = false) => renderToStaticMarkup(createElement(NativeRecoveryPanel, {
  recovery: { ...recovery, status, tools: { ...recovery.tools, unknown: status === 'recoverable' ? 0 : 1 } }, disabled, pending, onResume: fail, onConfirm: fail,
}));

test('safe native recovery requires checking the scene and clearly retains tool results without running tools or queue', () => {
  const markup = renderRecovery('recoverable');
  assert.match(markup, /aria-label="中断任务恢复"/);
  assert.match(markup, /已核查，恢复会话/);
  assert.match(markup, /确认旧命令及其子进程已停止/);
  assert.match(markup, /已记录结果 2 项 · 未执行 1 项 · 结果未知 0 项/);
  assert.match(markup, /已完成工具不会重放/);
  assert.match(markup, /未执行工具不会自动运行，旧审批不再有效/);
  assert.match(markup, /恢复后请发送新指令继续；排队消息保持暂停/);
  assert.doesNotMatch(markup, /确认只解除工作目录隔离|确认已核查执行现场/);
  assert.match(renderRecovery('recoverable', true), /disabled=""/);
  assert.match(renderRecovery('recoverable', false, true), /disabled=""[^>]*>正在恢复…/);
});

test('unknown recovery only releases the directory after confirmation and keeps its conversation read-only', () => {
  const blocked = renderRecovery('blocked');
  assert.match(blocked, /此会话只读/);
  assert.match(blocked, /确认已核查执行现场/);
  assert.match(blocked, /确认只解除工作目录隔离，旧会话仍为只读/);
  assert.match(blocked, /不会重放结果未知的工具/);
  assert.doesNotMatch(blocked, /已核查，恢复会话/);
  const acknowledged = renderRecovery('acknowledged');
  assert.match(acknowledged, /此会话只读/);
  assert.match(acknowledged, /原始记录继续保留/);
  assert.doesNotMatch(acknowledged, /<button/);
});

const maintenance: NativeContextMaintenance = { headHash: 'b'.repeat(64), canCompact: true };
const renderContext = (state = maintenance, compactDisabled = false) => renderToStaticMarkup(createElement(ContextMeter, {
  native: true, maintenance: state, compactDisabled, onCompact: fail, onCancelCompact: fail,
}));

test('native manual compaction explains billing, lossy summary and retained history before the explicit action', () => {
  const ready = renderContext();
  assert.match(ready, /压缩上下文（可能计费）/);
  assert.match(ready, /使用当前模型生成摘要，可能产生费用；不会执行工具/);
  assert.match(ready, /摘要会省略细节，原始记录保留/);
  assert.doesNotMatch(ready, /disabled=""|\/compact|\/context/);
  assert.match(renderContext({ ...maintenance, canCompact: false }), /disabled=""[^>]*>压缩上下文/);
  assert.match(renderContext(maintenance, true), /disabled=""[^>]*>压缩上下文/);
  const busy = renderContext({ ...maintenance, compacting: true, canCompact: false });
  assert.match(busy, /正在压缩上下文/);
  assert.match(busy, /role="status">正在生成摘要，完成前原上下文保持不变/);
  assert.match(busy, />取消压缩</);
  assert.doesNotMatch(busy, />压缩上下文（可能计费）</);
});

test('compaction result is local context bytes and does not fabricate provider token measurements', () => {
  const compacted = renderContext({ ...maintenance, lastCompaction: { beforeBytes: 24000, afterBytes: 8000, createdAt: '2026-09-27T00:00:00Z' } });
  assert.match(compacted, /role="status">最近压缩/);
  assert.match(compacted, /24,000 → 8,000 字节/);
  assert.match(compacted, /原始聊天和工具记录已保留/);
  assert.match(compacted, /未提供输入 token 用量/);
  const claude = renderToStaticMarkup(createElement(ContextMeter, { context: { status: 'compacted', lastCompaction: { at: '2026-09-27T00:00:00Z', trigger: 'manual', preTokens: 100 } } }));
  assert.match(claude, /已压缩 · 等待更新用量/);
  assert.match(claude, /\/context/);
  assert.doesNotMatch(claude, /压缩上下文（可能计费）|取消压缩/);
});

test('native automatic compaction explains opt-in billing, limits and cancellation of the pending send', () => {
  const enabled: NativeContextMaintenance = { ...maintenance, autoCompact: { enabled: true, thresholdPercent: 90 } };
  const ready = renderContext(enabled);
  assert.match(ready, /自动压缩已开启：仅发送新指令前，达到本地预算 90% 时尝试，每次提交最多一次/);
  assert.match(ready, /摘要请求可能计费，并计入本回合模型请求次数和运行时长/);
  assert.match(ready, /摘要会省略细节，原始记录保留/);
  assert.match(renderContext({ ...maintenance, autoCompact: { enabled: false, thresholdPercent: 90 } }), /自动压缩已关闭/);
  const busy = renderContext({ ...enabled, compacting: true, compactionTrigger: 'automatic', canCompact: false });
  assert.match(busy, /正在自动压缩上下文/);
  assert.match(busy, /正在自动压缩，完成后继续本次发送；取消会停止本次发送/);
  assert.match(busy, /原上下文在摘要成功前保持不变/);
  assert.match(busy, />取消压缩</);
  assert.doesNotMatch(busy, />压缩上下文（可能计费）</);
  assert.doesNotMatch(busy, /已停止自动重试/);
});

test('blocked automatic compaction gives manual recovery guidance and retains the explicit manual action', () => {
  const blocked = renderContext({ ...maintenance, autoCompact: { enabled: true, thresholdPercent: 90, blocked: true } });
  assert.match(blocked, /role="status">当前上下文的自动压缩未完成，已停止自动重试/);
  assert.match(blocked, /请先手动压缩，或在运行配置中关闭自动压缩后调整输入预算或新建会话/);
  assert.match(blocked, />压缩上下文（可能计费）</);
  assert.doesNotMatch(blocked, /disabled=""|>取消压缩</);
  const result = { beforeBytes: 24000, afterBytes: 8000, createdAt: '2026-09-27T00:00:00Z' };
  assert.match(renderContext({ ...maintenance, lastCompaction: { ...result, trigger: 'automatic' } }), /· 自动 · 上下文/);
  assert.match(renderContext({ ...maintenance, lastCompaction: { ...result, trigger: 'manual' } }), /· 手动 · 上下文/);
  assert.match(renderContext({ ...maintenance, lastCompaction: result }), /· 手动 · 上下文/);
});

test('in-turn maintenance distinguishes the running task from a pending send and explains shared limits', () => {
  const enabled: NativeContextMaintenance = { ...maintenance, autoCompact: { enabled: true, mode: 'before_send_and_during_run', thresholdPercent: 90 } };
  const ready = renderContext(enabled);
  assert.match(ready, /发送前与回合内达到本地预算 90%/);
  assert.match(ready, /发送前每次提交最多一次，回合内在完整响应与工具结果的边界最多一次/);
  assert.match(ready, /需保留摘要与继续执行的请求额度/);
  assert.match(ready, /长命令运行中或结果未知时暂缓。超出预算仍会停止/);
  assert.doesNotMatch(ready, /仅发送新指令前/);
  const busy = renderContext({ ...enabled, compacting: true, canCompact: false, compactionTrigger: 'in_turn',
    inTurn: { runId: 'run-1', status: 'attempted', createdAt: '2026-09-29T00:00:00Z' } });
  assert.match(busy, /正在回合内压缩上下文/);
  assert.match(busy, /持久保存后继续当前任务；取消会停止本回合/);
  assert.match(busy, /提交成功前保持不变，已完成工具不会重放/);
  assert.match(busy, /回合内压缩已登记，正在等待提交结果/);
  assert.match(busy, />取消压缩</);
  assert.doesNotMatch(busy, /继续本次发送|已持久保存|>压缩上下文（可能计费）</);
});

test('only a committed in-turn host receipt displays saved bytes and separately reported summary cost', () => {
  const markup = renderContext({ ...maintenance, inTurn: { runId: 'run-1', status: 'committed', createdAt: '2026-09-29T00:00:00Z',
    beforeBytes: 30000, afterBytes: 6000, summaryUsage: { inputTokens: 1000, outputTokens: 0 }, summaryCostUSD: 0.000125 } });
  assert.match(markup, /回合内压缩已持久保存。上下文 30,000 → 6,000 字节/);
  assert.match(markup, /摘要调用：输入 1,000 tokens · 输出 0 tokens · 估算费用 \$0.000125/);
  assert.match(markup, /已计入所属回合汇总，不需重复相加/);
  assert.match(markup, /发送前及手动压缩另计/);
  assert.match(markup, /本回合最近一次模型响应未提供输入 token 用量/);
  assert.doesNotMatch(markup, /正在回合内压缩|尚未确认/);
  const last = renderContext({ ...maintenance, lastCompaction: { beforeBytes: 30000, afterBytes: 6000, createdAt: '2026-09-29T00:00:00Z', trigger: 'in_turn' } });
  assert.match(last, /· 回合内自动 · 上下文/);
});

test('unresolved and failed in-turn receipts never infer success or zero cost, even when stale byte counts exist', () => {
  for (const status of ['attempted', 'unknown', 'failed'] as const) {
    const markup = renderContext({ ...maintenance, inTurn: { runId: 'run-1', status, createdAt: '2026-09-29T00:00:00Z', beforeBytes: 30000, afterBytes: 6000 } });
    assert.match(markup, status === 'failed' ? /回合内压缩未完成，本回合不再自动重试/ : /回合内压缩结果尚未确认，不能视为已完成/);
    assert.match(markup, /输入用量未报告 · 输出用量未报告 · 费用未估算/);
    assert.doesNotMatch(markup, /已持久保存|30,000 → 6,000|估算费用 \$0|正在等待提交/);
  }
  const partial = renderContext({ ...maintenance, inTurn: { runId: 'run-1', status: 'failed', createdAt: '2026-09-29T00:00:00Z', summaryUsage: { outputTokens: 42 } } });
  assert.match(partial, /输入用量未报告 · 输出 42 tokens · 费用未估算/);
});

test('invalid summary measurements cannot become displayed costs or byte savings', () => {
  const markup = renderContext({ ...maintenance, inTurn: { runId: 'run-1', status: 'committed', createdAt: '2026-09-29T00:00:00Z', beforeBytes: NaN, afterBytes: -1,
    summaryUsage: { inputTokens: Infinity, outputTokens: -2 }, summaryCostUSD: NaN } });
  assert.match(markup, /回合内压缩已持久保存。原始记录保留/);
  assert.match(markup, /输入用量未报告 · 输出用量未报告 · 费用未估算/);
  assert.doesNotMatch(markup, /NaN|Infinity|→|\$|tokens/);
});


test('a historical receipt identifies its own turn and cannot be mistaken for current-turn billing', () => {
  const markup = renderToStaticMarkup(createElement(ContextMeter, { native: true, currentRunId: 'current-run',
    maintenance: { ...maintenance, inTurn: { status: 'committed', runId: 'prior-run', createdAt: '2026-09-29T00:00:00Z', summaryUsage: { inputTokens: 10, outputTokens: 5 }, summaryCostUSD: 0.01 } } }));
  assert.match(markup, /历史回合压缩回执/);
  assert.match(markup, /已计入所属回合汇总，不需重复相加/);
  assert.doesNotMatch(markup, /此项已计入本回合汇总/);
});
