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
