import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RunIdentity } from '@cc-desk/agent-core';
import { NativeAgentProjection, loadNativeAgents, nativeAgentReceiptDirectory } from '../src/main/engines/native/agent-projection';
import { writeAgentReceipt } from '../src/main/engines/native/agent-artifacts';
import { readNativeAgentResult } from '../src/main/engines/native/agent-results';
import type { NativeDelegationReceipt } from '../src/main/engines/native/agent-delegation';
import { NativeAgentPanel } from '../src/renderer/NativeAgentPanel';

const identity = (): RunIdentity => ({ sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 });
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-pool-visibility-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const parent = identity(), batchId = randomUUID();
  const projection = new NativeAgentProjection(parent, nativeAgentReceiptDirectory(directory, parent), { effectiveSubagentPolicy: { maxSubagents: 2, policySource: 'session' } });
  const child = (queueIndex: number, status: NativeDelegationReceipt['status'] = 'queued'): NativeDelegationReceipt => {
    const childId = randomUUID();
    return { version: 1, batchId, childId, taskId: randomUUID(), identity: identity(), parentIdentity: parent, parentTaskId: randomUUID(),
      toolCallId: 'pool-call', title: `任务 ${queueIndex + 1}`, goal: '独立核查指定模块', mode: 'review', status, queueIndex,
      createdAt: '2026-10-17T09:00:00.000Z', updatedAt: '2026-10-17T09:00:00.000Z', cwd: directory,
      receiptPath: path.join(nativeAgentReceiptDirectory(directory, parent), batchId, childId, 'receipt.json') };
  };
  return { directory, parent, projection, child };
}

test('queued tasks retain FIFO batch order without consuming active capacity or manufacturing usage', async t => {
  const f = await fixture(t), waiting = [f.child(2), f.child(0), f.child(1)];
  waiting.forEach(value => f.projection.record(value));
  const onlyQueued = f.projection.snapshot(true);
  assert.equal(onlyQueued.runtime!.total, 3); assert.equal(onlyQueued.runtime!.queued, 3); assert.equal(onlyQueued.runtime!.active, 0);
  assert.equal(onlyQueued.runtime!.prepared, 0); assert.equal(onlyQueued.runtime!.running, 0);
  assert.deepEqual(onlyQueued.items.map(value => value.queueIndex), [0, 1, 2]);
  assert.ok(onlyQueued.items.every(value => !value.usage && !value.summary && !value.worktree && !value.evidence));
  const running = f.child(3, 'running'), prepared = f.child(4, 'prepared');
  f.projection.record(running); f.projection.record(prepared);
  const mixed = f.projection.snapshot(true);
  assert.equal(mixed.runtime!.total, 5); assert.equal(mixed.runtime!.active, 2); assert.equal(mixed.runtime!.queued, 3);
  assert.ok(mixed.items.slice(0, 2).every(value => ['running', 'prepared'].includes(value.status)));
  assert.deepEqual(mixed.items.slice(2).map(value => value.queueIndex), [0, 1, 2]);
});

test('queued cancellation remains a host cancellation without a fake terminal child result', async t => {
  const f = await fixture(t), waiting = f.child(0); f.projection.record(waiting);
  const cancelled = { ...waiting, status: 'cancelled' as const, updatedAt: '2026-10-17T09:01:00.000Z' };
  f.projection.record(cancelled); await writeAgentReceipt(cancelled.receiptPath, cancelled);
  const live = f.projection.snapshot(true);
  assert.equal(live.runtime!.active, 0); assert.equal(live.runtime!.queued, 0); assert.equal(live.runtime!.cancelled, 1);
  const result = await readNativeAgentResult(f.directory, f.parent, { parentRunId: f.parent.runId, childId: waiting.childId });
  assert.equal(result.agent.status, 'cancelled'); assert.equal(result.agent.usage, undefined); assert.equal(result.agent.summary, undefined);
  assert.equal(result.agent.missingTerminal, undefined); assert.equal(result.acceptance, 'not_assessed');
  assert.equal(f.projection.receipts()[0].result, undefined);
});

test('queued ordering keeps earlier batches first and legacy records in their saved insertion order', async t => {
  const f = await fixture(t), legacy = [f.child(0), f.child(1)];
  legacy.forEach(value => { delete value.queueIndex; f.projection.record(value); });
  const earlierBatch = randomUUID(), earlier = f.child(2);
  earlier.batchId = earlierBatch; earlier.createdAt = '2026-10-17T08:59:00.000Z';
  earlier.receiptPath = path.join(nativeAgentReceiptDirectory(f.directory, f.parent), earlierBatch, earlier.childId, 'receipt.json');
  f.projection.record(earlier);
  assert.deepEqual(f.projection.snapshot(true).items.map(value => value.childId), [earlier.childId, ...legacy.map(value => value.childId)]);
});

test('restoration and saved-result reads turn queued, prepared and running into unknown without replay', async t => {
  const f = await fixture(t);
  for (const [index, status] of (['queued', 'prepared', 'running'] as const).entries()) {
    const child = f.child(index, status); await writeAgentReceipt(child.receiptPath, child);
    const result = await readNativeAgentResult(f.directory, f.parent, { parentRunId: f.parent.runId, childId: child.childId });
    assert.equal(result.agent.status, 'unknown'); assert.equal(result.agent.missingTerminal, true); assert.equal(result.agent.usage, undefined);
    assert.equal(JSON.parse(await fs.readFile(child.receiptPath, 'utf8')).status, status, 'read-only recovery must preserve the durable host evidence');
  }
  const loaded = await loadNativeAgents(f.directory, f.parent), restored = loaded.snapshot();
  assert.equal(restored.runtime!.total, 3); assert.equal(restored.runtime!.queued, 0); assert.equal(restored.runtime!.active, 0);
  assert.equal(restored.runtime!.unknown, 3); assert.ok(restored.items.every(value => value.status === 'unknown' && value.missingTerminal));
  assert.deepEqual(loaded.receipts().map(value => value.status).sort(), ['prepared', 'queued', 'running']);
});

test('queued records reject execution evidence and queue index mutation', async t => {
  const f = await fixture(t), child = f.child(0);
  const result = { identity: child.identity, taskId: child.taskId, status: 'completed' as const, reason: 'model_completed', committed: true, summary: 'finished', modelRequests: 1, toolCalls: 0 };
  const workspace = { path: f.directory, cwd: f.directory, branch: `codex/native-agent-${child.childId}`, baseCommit: 'a'.repeat(40), parentHead: 'a'.repeat(40), baseline: 'head' as const };
  const artifact = { patchPath: path.join(path.dirname(child.receiptPath), 'workspace.diff.patch'), changedFiles: [], head: 'a'.repeat(40), baseCommit: 'a'.repeat(40) };
  for (const update of [{ result }, { workspace }, { workspaceVerified: false }, { artifact }])
    assert.throws(() => f.projection.record({ ...child, ...update }), /cannot have execution evidence/);
  for (const queueIndex of [-1, 30, 0.5]) assert.throws(() => f.projection.record({ ...child, queueIndex }));
  f.projection.record(child);
  assert.throws(() => f.projection.record({ ...child, status: 'running', queueIndex: 1 }), /identity changed/);
  f.projection.record({ ...child, status: 'running', updatedAt: '2026-10-17T09:01:00.000Z' });
  assert.equal(f.projection.snapshot(true).items[0].queueIndex, 0);
});

test('the panel distinguishes queued tasks from started capacity and handles legacy counts', async t => {
  const f = await fixture(t), child = f.child(0); f.projection.record(child);
  const agents = f.projection.snapshot(true), render = (runtime = agents.runtime!) => renderToStaticMarkup(createElement(NativeAgentPanel, { sessionId: f.parent.sessionId, agents, runtime }));
  const markup = render();
  assert.match(markup, /活跃 0 \/ 有效上限 2 · 任务总数 1/); assert.match(markup, /排队中 1 · 运行中 0/);
  assert.match(markup, /data-agent-status="queued"/); assert.match(markup, /尚未启动，不占活跃并发/);
  assert.match(markup, /单次可提交最多 30 个任务/); assert.match(markup, /空闲后按提交顺序补位/);
  assert.doesNotMatch(markup, /已启动 1|实时队列位置/);
  assert.match(render({ ...agents.runtime!, queued: undefined }), /排队中 0 · 运行中 0/);
});
