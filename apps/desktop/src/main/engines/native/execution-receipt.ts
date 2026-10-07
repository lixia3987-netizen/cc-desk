import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson, type RunResult } from '@cc-desk/agent-core';
import type { NativeExecutionReceipt, NativeTaskSnapshot } from '@cc-desk/contracts/native-task';
import { sameRun } from './worker-protocol';

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value as never)).digest('hex');
export function nativeExecutionReceipt(result: RunResult, task: NativeTaskSnapshot | null, activeMs: number,
  counts?: { modelRequests: number; toolCalls: number }): NativeExecutionReceipt {
  const bound = task && sameRun(task.identity, result.identity) ? task : null;
  const truncated = Boolean(bound && (bound.criteria.length > 32 || bound.evidence.length > 32 ||
    bound.workspace?.changes.truncated || ['added', 'modified', 'removed'].some(key =>
      (bound.workspace?.changes[key as 'added']?.length ?? 0) > 64)));
  const receipt: NativeExecutionReceipt = {
    version: 1, identity: { ...result.identity },
    ...(bound ? { taskId: bound.taskId, taskRevision: bound.revision, planRevision: bound.planRevision,
      acceptanceRevision: bound.acceptanceRevision, verification: bound.verification } : {}),
    ...(bound?.workspace ? { workspace: { fingerprint: bound.workspace.current.fingerprint,
      complete: bound.workspace.current.complete, capturedAt: bound.workspace.current.capturedAt },
    changes: { ...bound.workspace.changes, added: bound.workspace.changes.added.slice(0, 64),
      modified: bound.workspace.changes.modified.slice(0, 64), removed: bound.workspace.changes.removed.slice(0, 64),
      truncated: bound.workspace.changes.truncated || truncated } } : {}),
    criteria: bound?.criteria.slice(0, 32).map(item => ({ ...item, stepIds: [...item.stepIds] })) ?? [],
    evidence: bound?.evidence.slice(-32).map(({ id, identity, source, status, criterionIds, stepIds, planRevision,
      acceptanceRevision, workspaceFingerprint, workspaceComplete, toolCallId, command, exitCode, outputDigest, truncated, stale }) =>
      ({ id, identity, source, status, criterionIds, stepIds, planRevision, acceptanceRevision, workspaceFingerprint,
        workspaceComplete, ...(toolCallId === undefined ? {} : { toolCallId }), ...(command === undefined ? {} : { command }),
        ...(exitCode === undefined ? {} : { exitCode }), ...(outputDigest === undefined ? {} : { outputDigest }),
        ...(truncated === undefined ? {} : { truncated }), ...(stale === undefined ? {} : { stale }) })) ?? [],
    usage: { modelRequests: counts?.modelRequests ?? result.modelRequests, toolCalls: counts?.toolCalls ?? result.toolCalls,
      activeMs: Math.max(0, Math.ceil(activeMs)) }, truncated,
  };
  for (const evidence of receipt.evidence) {
    if (evidence.command && (evidence.command.argv.length > 128 || Buffer.byteLength(JSON.stringify(evidence.command)) > 4096)) {
      delete evidence.command; evidence.truncated = true; receipt.truncated = true;
    }
  }
  const oversized = () => Buffer.byteLength(JSON.stringify(receipt)) > 64 * 1024;
  if (oversized() && receipt.changes) {
    for (const key of ['added', 'modified', 'removed'] as const) {
      while (oversized() && receipt.changes[key].length) receipt.changes[key].pop();
    }
    receipt.changes.truncated = true; receipt.truncated = true;
  }
  while (oversized() && receipt.evidence.length) { receipt.evidence.shift(); receipt.truncated = true; }
  while (oversized() && receipt.criteria.length) { receipt.criteria.pop(); receipt.truncated = true; }
  return receipt;
}
function receiptPath(directory: string, runId: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(runId)) throw new Error('无效的执行回执身份。');
  return path.join(directory, 'native', 'execution-receipts', `${runId}.json`);
}
/** A duplicate dispatch reads its original receipt; it must never pick up later task edits or a new elapsed time. */
export async function readNativeExecutionReceipt(directory: string, result: RunResult): Promise<NativeExecutionReceipt | null> {
  let text: string;
  try { text = await fs.readFile(receiptPath(directory, result.identity.runId), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (Buffer.byteLength(text) > 65 * 1024) throw new Error('执行回执超过容量限制。');
  const envelope = JSON.parse(text) as { receipt: NativeExecutionReceipt; hash: string };
  if (envelope.hash !== hash(envelope.receipt) || envelope.receipt.version !== 1 ||
    canonicalJson(envelope.receipt.identity as never) !== canonicalJson(result.identity as never)) throw new Error('执行回执与运行身份不匹配。');
  return envelope.receipt;
}
export async function saveNativeExecutionReceipt(directory: string, receipt: NativeExecutionReceipt): Promise<void> {
  const target = receiptPath(directory, receipt.identity.runId);
  const encoded = JSON.stringify({ receipt, hash: hash(receipt) }) + '\n';
  if (Buffer.byteLength(JSON.stringify(receipt)) > 64 * 1024) throw new Error('执行回执超过容量限制。');
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const file = await fs.open(target, 'wx', 0o600);
  try { await file.writeFile(encoded); await file.sync(); } finally { await file.close(); }
}
