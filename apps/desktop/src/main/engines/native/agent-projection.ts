import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { RunIdentity } from '@cc-desk/agent-core';
import type { NativeAgentSnapshot, NativeAgentView } from '../../../shared/chat';
import type { NativeDelegationReceipt } from './agent-delegation';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const identifier = z.string().min(1).max(100).regex(/^[a-z0-9-]+$/i);
const requestId = z.string().min(1).max(256).refine(value => !value.includes('\0'));
const identity = z.object({ sessionId: identifier, conversationId: identifier, runId: identifier, requestId, workerGeneration: z.number().int().min(1) }).strict();
const location = z.string().min(1).max(32768).refine(value => path.isAbsolute(value) && !/[\x00-\x1f]/.test(value));
const timestamp = z.string().max(64).refine(value => Number.isFinite(Date.parse(value)));
const commit = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i);
const files = z.array(z.object({ path: z.string().min(1).max(32768), status: z.string().min(1).max(16) }).strict()).max(100000);
const result = z.object({ identity, taskId: uuid, status: z.enum(['completed', 'failed', 'cancelled', 'budget_exhausted', 'recovery_required']),
  reason: z.string().max(1024), committed: z.boolean(), summary: z.string().max(65536), modelRequests: z.number().int().nonnegative(), toolCalls: z.number().int().nonnegative(),
  evidence: z.object({ taskSnapshotPath: location.optional(), runJournalPath: location.optional(), commandReceipts: z.array(z.object({
    toolCallId: z.string().min(1).max(256), status: z.string().min(1).max(64), exitCode: z.number().int().nullable(), receiptPath: location,
  }).strict()).max(512).optional() }).strict().optional(),
}).strict();
const receiptSchema = z.object({ version: z.literal(1), batchId: uuid, childId: uuid, taskId: uuid, identity, parentIdentity: identity,
  parentTaskId: z.string().min(1).max(100), toolCallId: z.string().min(1).max(256), title: z.string().min(1).max(200), goal: z.string().min(1).max(6000),
  mode: z.enum(['review', 'implement']), status: z.enum(['prepared', 'running', 'completed', 'failed', 'cancelled', 'unknown']),
  createdAt: timestamp, updatedAt: timestamp, receiptPath: location, cwd: location,
  workspace: z.object({ path: location, cwd: location, branch: z.string().regex(/^codex\/native-agent-[0-9a-f-]{36}$/i), baseCommit: commit,
    parentHead: commit, baseline: z.enum(['head', 'snapshot']) }).strict().optional(), workspaceVerified: z.boolean().optional(),
  artifact: z.object({ patchPath: location, changedFiles: files, head: commit, baseCommit: commit }).strict().optional(),
  result: result.optional(), error: z.string().max(256).optional(),
}).strict();
const sameIdentity = (a: RunIdentity, b: RunIdentity) => (['sessionId', 'conversationId', 'runId', 'requestId', 'workerGeneration'] as const).every(key => a[key] === b[key]);

export function nativeAgentReceiptDirectory(dataDirectory: string, parent: RunIdentity): string {
  identity.parse(parent);
  return path.join(dataDirectory, 'native', 'delegations', parent.conversationId, parent.runId);
}
/** Only durable host receipts are projected; model prose and generic tool outputs are ignored. */
export function nativeAgentView(receipt: NativeDelegationReceipt, parent: RunIdentity): NativeAgentView {
  const value = receiptSchema.parse(receipt);
  if (!sameIdentity(value.parentIdentity, parent) || value.identity.sessionId === parent.sessionId || value.identity.conversationId === parent.conversationId || value.identity.runId === parent.runId ||
      value.result && (!sameIdentity(value.result.identity, value.identity) || value.result.taskId !== value.taskId) ||
      value.workspace && (value.mode !== 'implement' || value.workspace.branch !== `codex/native-agent-${value.childId}`)) throw new Error('Native child receipt identity mismatch.');
  const view: NativeAgentView = { childId: value.childId, batchId: value.batchId, taskId: value.taskId, parentTaskId: value.parentTaskId,
    identity: structuredClone(value.identity), parentIdentity: structuredClone(parent), toolCallId: value.toolCallId,
    title: value.title, mode: value.mode, status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt, cwd: value.cwd, receiptPath: value.receiptPath };
  if (value.error) view.error = value.error;
  if (value.workspace) view.worktree = { ...value.workspace, verified: value.workspaceVerified === true };
  if (value.artifact) view.artifact = { patchPath: value.artifact.patchPath, changedFiles: value.artifact.changedFiles.slice(0, 128), omittedFiles: Math.max(0, value.artifact.changedFiles.length - 128) };
  if (value.result) {
    view.summary = value.result.summary.slice(-16384); view.reason = value.result.reason;
    view.usage = { modelRequests: value.result.modelRequests, toolCalls: value.result.toolCalls };
    if (value.result.evidence) view.evidence = { ...structuredClone(value.result.evidence), commandReceipts: structuredClone(value.result.evidence.commandReceipts ?? []) };
  }
  if (value.result && (!value.result.committed || value.result.status === 'recovery_required') ||
    value.status === 'completed' && (!value.result?.committed || value.result.status !== 'completed') ||
    value.status === 'cancelled' && value.result && value.result.status !== 'cancelled') {
    view.status = 'unknown'; view.missingTerminal = true;
  }
  return view;
}

function snapshot(items: Iterable<NativeAgentView>, parent: RunIdentity, receiptDirectory: string, active: boolean, incomplete = false): NativeAgentSnapshot {
  const all = [...items].map(item => {
    const view = structuredClone(item);
    if (!active && ['prepared', 'running'].includes(view.status)) { view.status = 'unknown'; view.missingTerminal = true; }
    return view;
  });
  all.sort((a, b) => Number(['prepared', 'running'].includes(b.status)) - Number(['prepared', 'running'].includes(a.status)) ||
    b.createdAt.localeCompare(a.createdAt) || b.batchId.localeCompare(a.batchId) || a.childId.localeCompare(b.childId));
  return { parentRunId: parent.runId, items: all.slice(0, 4), omitted: Math.max(0, all.length - 4), receiptDirectory, ...(incomplete ? { incomplete: true } : {}) };
}

/** Keeps all (at most sixteen) parent-run receipts while exposing at most four children. */
export class NativeAgentProjection {
  private items = new Map<string, NativeAgentView>();
  private retained = new Map<string, NativeDelegationReceipt>();
  private incomplete = false;
  constructor(readonly parent: RunIdentity, readonly receiptDirectory: string) { identity.parse(parent); this.parent = structuredClone(parent); }
  record(receipt: NativeDelegationReceipt): void {
    const view = nativeAgentView(receipt, this.parent);
    const expected = path.join(this.receiptDirectory, view.batchId, view.childId, 'receipt.json');
    if (path.resolve(view.receiptPath) !== path.resolve(expected)) throw new Error('Native child receipt escaped its parent run directory.');
    if (receipt.artifact && path.resolve(receipt.artifact.patchPath) !== path.join(path.dirname(expected), 'workspace.diff.patch')) throw new Error('Native child artifact path changed.');
    const nativeRoot = path.resolve(this.receiptDirectory, '../../..');
    const expectedTask = path.join(nativeRoot, 'tasks', view.identity.conversationId, 'tasks.json'), expectedJournal = path.join(nativeRoot, 'conversations', view.identity.conversationId, 'journal.jsonl');
    const evidence = receipt.result?.evidence;
    if (evidence && (evidence.taskSnapshotPath && path.resolve(evidence.taskSnapshotPath) !== expectedTask ||
      evidence.runJournalPath && path.resolve(evidence.runJournalPath) !== expectedJournal || evidence.commandReceipts?.some(command => path.resolve(command.receiptPath) !== expectedJournal))) throw new Error('Native child evidence path changed.');
    const previous = this.items.get(view.childId);
    if (previous && (previous.batchId !== view.batchId || previous.taskId !== view.taskId || !sameIdentity(previous.identity, view.identity))) throw new Error('Native child identity changed.');
    if (previous && previous.updatedAt > view.updatedAt) return;
    if (this.items.size >= 16 && !previous) { this.incomplete = true; return; }
    this.items.set(view.childId, view);
    this.retained.set(view.childId, structuredClone(receipt));
  }
  snapshot(active = false): NativeAgentSnapshot { return snapshot(this.items.values(), this.parent, this.receiptDirectory, active, this.incomplete); }
  /** Verified host records for directory quarantine/recovery; never authorizes a new worker. */
  receipts(): NativeDelegationReceipt[] { return structuredClone([...this.retained.values()]); }
  merge(current: NativeAgentProjection | undefined): void {
    if (!current || !sameIdentity(current.parent, this.parent)) return;
    for (const [id, item] of current.items) {
      const old = this.items.get(id);
      if (!old || item.updatedAt >= old.updatedAt) {
        this.items.set(id, structuredClone(item));
        this.retained.set(id, structuredClone(current.retained.get(id)!));
      }
    }
    this.incomplete ||= current.incomplete;
  }
  markIncomplete(): void { this.incomplete = true; }
}

/** Bounded, symlink-free read of the current parent run; never adopts an old worker. */
export async function loadNativeAgents(dataDirectory: string, parent: RunIdentity): Promise<NativeAgentProjection> {
  const directory = nativeAgentReceiptDirectory(dataDirectory, parent), projection = new NativeAgentProjection(parent, directory);
  try {
    for (let current = directory; current !== path.dirname(current) && current !== path.resolve(dataDirectory); current = path.dirname(current)) {
      const stat = await fs.lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe Native child receipt directory.');
    }
    const batches = await fs.readdir(directory, { withFileTypes: true });
    if (batches.length > 32) projection.markIncomplete();
    for (const batch of batches.slice(0, 32)) {
      if (!batch.isDirectory() || batch.isSymbolicLink() || !uuid.safeParse(batch.name).success) { projection.markIncomplete(); continue; }
      const batchPath = path.join(directory, batch.name), children = await fs.readdir(batchPath, { withFileTypes: true });
      if (children.length > 4) projection.markIncomplete();
      for (const child of children.slice(0, 4)) {
        try {
          if (!child.isDirectory() || child.isSymbolicLink() || !uuid.safeParse(child.name).success) throw new Error('Unsafe Native child directory.');
          const file = path.join(batchPath, child.name, 'receipt.json'), stat = await fs.lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error('Unsafe Native child receipt.');
          const receipt = receiptSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
          if (receipt.childId !== child.name || receipt.batchId !== batch.name) throw new Error('Native child receipt directory mismatch.');
          projection.record(receipt);
        } catch { projection.markIncomplete(); }
      }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') projection.markIncomplete(); }
  return projection;
}
