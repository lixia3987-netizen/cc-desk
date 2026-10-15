import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { z } from 'zod';
import type { RunIdentity, RunResult } from '@cc-desk/agent-core';
import { NativeRunStore, type StoredRun } from '@cc-desk/agent-node/run-store';
import { extractNativeAssistantText } from '@cc-desk/agent-node/native-model';
import type { NativeDelegationReceipt } from './agent-delegation';
import { missingNativeReviewGoalSections, nativeParallelReviewIntent, nativeReviewQuestion, nativeReviewGoalSections, type NativeParallelReviewIntent } from './agent-prompts';
import { loadNativeAgents, nativeAgentReceiptDirectory } from './agent-projection';
import { writeAgentReceipt } from './agent-artifacts';

export interface NativeDelegationInstant { monotonicMs: number; wallTime: string }
/** 单一父宿主的单调时钟锚；独立于可覆盖的 receipt.updatedAt。 */
export interface NativeDelegationExecution {
  version: 1;
  batchId: string;
  parentRunId: string;
  toolCallId: string;
  mode: 'review' | 'implement';
  clock: { id: string; timeOrigin: number };
  children: Array<{ childId: string; identity: RunIdentity; started?: NativeDelegationInstant; settled?: NativeDelegationInstant }>;
}
const identifier = z.string().min(1).max(100).regex(/^[a-z0-9-]+$/iu);
const instant = z.object({ monotonicMs: z.number().finite().nonnegative(), wallTime: z.string().max(64).refine(value => Number.isFinite(Date.parse(value))) }).strict();
const executionSchema = z.object({ version: z.literal(1), batchId: z.string().uuid(), parentRunId: identifier,
  toolCallId: z.string().min(1).max(256), mode: z.enum(['review', 'implement']),
  clock: z.object({ id: z.string().uuid(), timeOrigin: z.number().finite().nonnegative() }).strict(),
  children: z.array(z.object({ childId: z.string().uuid(), identity: z.object({ sessionId: identifier, conversationId: identifier, runId: identifier,
    requestId: z.string().min(1).max(256), workerGeneration: z.number().int().positive() }).strict(), started: instant.optional(), settled: instant.optional() }).strict()).min(1).max(4),
}).strict();
export interface NativeDelegationAudit {
  version: 1;
  parentRunId: string;
  intent: NativeParallelReviewIntent;
  status: 'not_required' | 'satisfied' | 'unmet' | 'unknown';
  /** 只核对真实工具/回执/交接，不替模型结论或人工验收背书。 */
  scope: 'host_execution_and_handoff';
  issues: string[];
  attempts: Array<{ toolCallId: string; tool: string; status: string; batchIds: string[] }>;
  batches: Array<{ batchId: string; toolCallId: string; childIds: string[]; actualOverlappingChildren: boolean;
    completedChildren: number; inspectedChildren: number; childrenWithMaterialReads: number; issues: string[] }>;
}

/** 确认同一批中两个实际调用的区间交叠；同名、同毫秒和 UI 卡片都不算证明。 */
export function nativeDelegationIntervalsOverlap(execution: NativeDelegationExecution): boolean {
  const rows = execution.children.filter(row => row.started && row.settled && row.settled.monotonicMs >= row.started.monotonicMs);
  return rows.some((left, index) => rows.slice(index + 1).some(right => left.childId !== right.childId && left.identity.runId !== right.identity.runId &&
    Math.max(left.started!.monotonicMs, right.started!.monotonicMs) < Math.min(left.settled!.monotonicMs, right.settled!.monotonicMs)));
}

const sameIdentity = (a: RunIdentity, b: RunIdentity) => (['sessionId', 'conversationId', 'runId', 'requestId', 'workerGeneration'] as const).every(key => a[key] === b[key]);

const normalizeMaterialPath = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim().replace(/\\/gu, '/').replace(/^\.\//u, '');
  if (!candidate || path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || /[\x00-\x1f<>:"|?*]/u.test(candidate) || candidate.split('/').includes('..')) return undefined;
  const normalized = path.posix.normalize(candidate);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};
/** 仅解析 Materials 标签内可辨认的项目文件，散文或目录无法精确核对时保持 unknown。 */
export function nativeReviewMaterialPaths(goal: string): string[] {
  const material = nativeReviewGoalSections(goal).materials;
  if (!material) return [];
  const quoted = [...material.matchAll(/[`"']([^`"']+)[`"']/gu)].map(match => match[1]);
  const bare = [...material.matchAll(/(?:^|[\s,;，；(（])((?:[^\s`"'<>()[\]{},;，；:：]+\/)*[^\s`"'<>()[\]{},;，；:：/]+\.[a-z\d]{1,10})(?=$|[\s,;，；)）#])/giu)].map(match => match[1]);
  return [...new Set([...quoted, ...bare].map(value => normalizeMaterialPath(value.replace(/#L\d+(?:-L?\d+)?$/iu, ''))).filter((value): value is string => value !== undefined))];
}
export interface NativeMaterialReadEvidence { status: 'verified' | 'missing' | 'unknown'; materialPaths: string[]; observedPaths: string[] }
/** 成功读 AGENTS、空搜索或只有文件名都不等于读过 goal 中的材料。 */
export function nativeChildMaterialReadEvidence(goal: string, child: StoredRun): NativeMaterialReadEvidence {
  const materialPaths = nativeReviewMaterialPaths(goal), observed = new Map<string, Set<string>>();
  if (!materialPaths.length) return { status: 'unknown', materialPaths, observedPaths: [] };
  let uncertainMatchingReceipt = false;
  const retain = (file: unknown, hash: unknown, complete: boolean) => {
    const filePath = normalizeMaterialPath(file);
    if (!filePath || !materialPaths.includes(filePath)) return;
    if (!complete || typeof hash !== 'string' || !/^[a-f\d]{64}$/iu.test(hash)) { uncertainMatchingReceipt = true; return; }
    const hashes = observed.get(filePath) ?? new Set<string>(); hashes.add(hash.toLowerCase()); observed.set(filePath, hashes);
  };
  for (const tool of child.tools) {
    const result = tool.completed?.result, output = result?.output;
    if (!tool.prepared || result?.status !== 'completed' || !output || typeof output !== 'object' || Array.isArray(output)) continue;
    if (tool.call.name === 'read_file') {
      const preparedPath = normalizeMaterialPath(tool.prepared.prepared.input.path), outputPath = normalizeMaterialPath(output.path);
      if (preparedPath && preparedPath === outputPath) retain(output.path, output.hash, typeof output.content === 'string' && !result.truncated && output.truncated !== true);
    } else if (tool.call.name === 'search' && Array.isArray(output.matches)) {
      for (const match of output.matches) if (match && typeof match === 'object' && !Array.isArray(match)) {
        retain(match.path, match.hash, match.hashStatus === 'complete' && typeof match.text === 'string' && typeof match.line === 'number' && match.line >= 1 && match.textTruncated !== true);
      }
    }
  }
  const observedPaths = [...observed.keys()];
  if (!materialPaths.every(file => observed.has(file))) return { status: uncertainMatchingReceipt ? 'unknown' : 'missing', materialPaths, observedPaths };
  // 单文件交接声明了一个确切版本时必须与真实读回的完整文件 hash 对上。
  const declaredHashes = [...(nativeReviewGoalSections(goal).version ?? '').matchAll(/\b[a-f\d]{64}\b/giu)].map(match => match[0].toLowerCase());
  if (materialPaths.length === 1 && declaredHashes.length === 1 && !observed.get(materialPaths[0])!.has(declaredHashes[0])) return { status: 'unknown', materialPaths, observedPaths };
  return { status: 'verified', materialPaths, observedPaths };
}

/** 宿主子账本终局比 JSON 回执更强；状态、计数、任务绑定和摘要均须一致。 */
export function nativeDelegationChildTerminalMatches(receipt: NativeDelegationReceipt, child?: StoredRun): boolean {
  const actual = child?.result, claimed = receipt.result;
  return !!child && !!actual && !!claimed && sameIdentity(child.identity, receipt.identity) && sameIdentity(actual.identity, receipt.identity) && sameIdentity(claimed.identity, receipt.identity) &&
    claimed.taskId === receipt.taskId && child.status === actual.status && child.configuration.nativeTaskId === receipt.taskId && actual.committed === claimed.committed && actual.status === claimed.status && actual.reason === claimed.reason &&
    actual.modelRequests === claimed.modelRequests && actual.toolCalls === claimed.toolCalls &&
    extractNativeAssistantText(actual.context.items).slice(-16384) === claimed.summary;
}
/** 只接受已持久化当前回合工具记录和经归属校验的宿主回执；文本计划从不生成子任务。 */
export function auditNativeDelegation(input: { run: StoredRun; receipts: readonly NativeDelegationReceipt[]; executions: readonly NativeDelegationExecution[];
  childRuns?: ReadonlyMap<string, StoredRun>; incomplete?: boolean }): NativeDelegationAudit {
  const { run } = input, intent = nativeParallelReviewIntent(run.input), required = intent.mode === 'explicit_parallel_review';
  const audit: NativeDelegationAudit = { version: 1, parentRunId: run.identity.runId, intent, status: required ? 'unmet' : 'not_required',
    scope: 'host_execution_and_handoff', issues: [], attempts: run.tools.filter(tool => tool.call.name.startsWith('delegate_')).map(tool => ({
      toolCallId: tool.call.id, tool: tool.call.name, status: tool.completed?.result.status ?? tool.state,
      batchIds: [...new Set(input.receipts.filter(receipt => receipt.toolCallId === tool.call.id && sameIdentity(receipt.parentIdentity, run.identity)).map(receipt => receipt.batchId))],
    })), batches: [] };
  let validParallelBatch = false, unknownEvidence = input.incomplete === true, uninspectedResults = false;
  const reviewCalls = run.tools.filter(tool => tool.call.name === 'delegate_review' && tool.prepared && tool.completed);
  for (const call of reviewCalls) {
    const receipts = input.receipts.filter(receipt => receipt.mode === 'review' && receipt.toolCallId === call.call.id && sameIdentity(receipt.parentIdentity, run.identity));
    if (!receipts.length) continue;
    const batchId = receipts[0].batchId, execution = input.executions.find(value => value.batchId === batchId && value.parentRunId === run.identity.runId && value.toolCallId === call.call.id &&
      value.mode === 'review' && value.children.length === receipts.length && value.children.every(row => receipts.some(receipt => receipt.childId === row.childId && sameIdentity(receipt.identity, row.identity))));
    const inspected = receipts.filter(receipt => run.tools.some(tool => {
      const result = tool.completed?.result, output = result?.output;
      if (tool.call.name !== 'read_agent_result' || result?.status !== 'completed' || result.truncated || !output || typeof output !== 'object' || Array.isArray(output)) return false;
      const value = output as Record<string, unknown>, retained = value.result as { agent?: { childId?: string; identity?: RunIdentity }; acceptance?: string } | undefined;
      return tool.prepared?.prepared.input.parentRunId === run.identity.runId && tool.prepared.prepared.input.childId === receipt.childId &&
        value.source === 'untrusted_agent_result' && value.parentRunId === run.identity.runId && value.truncated !== true &&
        (!Array.isArray(value.omittedFields) || value.omittedFields.length === 0) && retained?.acceptance === 'not_assessed' &&
        retained.agent?.childId === receipt.childId && retained.agent.identity && sameIdentity(retained.agent.identity, receipt.identity);
    }));
    const confirmed = receipts.filter(receipt => nativeDelegationChildTerminalMatches(receipt, input.childRuns?.get(receipt.childId)));
    const completed = confirmed.filter(receipt => receipt.status === 'completed' && receipt.result?.committed && receipt.result.status === 'completed' && receipt.result.modelRequests > 0);
    const overlap = execution !== undefined && nativeDelegationIntervalsOverlap(execution);
    const readEvidence = new Map(receipts.map(receipt => {
      const child = input.childRuns?.get(receipt.childId);
      return [receipt.childId, child ? nativeChildMaterialReadEvidence(receipt.goal, child).status : 'unknown'] as const;
    }));
    const materialReads = completed.filter(receipt => readEvidence.get(receipt.childId) === 'verified');
    const issues: string[] = [];
    audit.batches.push({ batchId, toolCallId: call.call.id, childIds: receipts.map(receipt => receipt.childId), actualOverlappingChildren: overlap,
      completedChildren: completed.length, inspectedChildren: inspected.length, childrenWithMaterialReads: materialReads.length, issues });
    if (!required) continue;
    if (call.completed!.result.status !== 'completed' || completed.length !== receipts.length) issues.push('child_execution_incomplete');
    if (receipts.length < 2) issues.push('parallel_batch_requires_two_children');
    if (new Set(receipts.map(receipt => nativeReviewQuestion(receipt.goal) ?? receipt.goal.trim())).size !== receipts.length) issues.push('duplicate_review_goals');
    if (receipts.some(receipt => missingNativeReviewGoalSections(receipt.goal).length)) issues.push('review_handoff_incomplete');
    if (!execution) issues.push('parallel_execution_evidence_missing');
    else if (!overlap) issues.push('actual_child_intervals_do_not_overlap');
    if (inspected.length !== receipts.length) issues.push('actual_child_results_not_fully_inspected');
    if (materialReads.length !== receipts.length) issues.push('actual_child_material_reads_missing');
    if (confirmed.length !== receipts.length) { issues.push('child_terminal_receipt_mismatch'); unknownEvidence = true; }
    if (completed.some(receipt => readEvidence.get(receipt.childId) === 'unknown')) { issues.push('material_read_evidence_unconfirmed'); unknownEvidence = true; }
    if (receipts.some(receipt => receipt.status === 'unknown' || receipt.result?.committed === false)) unknownEvidence = true;
    if (inspected.length !== receipts.length) uninspectedResults = true;
    if (!issues.length) validParallelBatch = true;
    audit.issues.push(...issues);
  }
  if (required) {
    if (!audit.batches.length) audit.issues.push('no_actual_review_batch');
    if (unknownEvidence) { audit.status = 'unknown'; audit.issues.push('delegation_receipts_incomplete'); }
    else if (validParallelBatch && !uninspectedResults) { audit.status = 'satisfied'; audit.issues = []; }
    audit.issues = [...new Set(audit.issues)];
  }
  if (intent.mode === 'single_agent' && audit.attempts.length) { audit.status = 'unmet'; audit.issues = ['delegation_conflicts_with_single_agent']; }
  return audit;
}

/** execution.json 路径由已校验的回执产生；拒绝符号链接，并有界读取，绝不接收模型路径。 */
async function readExecution(file: string, root: string): Promise<NativeDelegationExecution> {
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Delegation execution path escaped its parent.');
  let current = root;
  for (const part of relative.split(path.sep).slice(0, -1)) {
    const stat = await fs.lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe delegation execution directory.');
    current = path.join(current, part);
  }
  const directory = await fs.lstat(current), before = await fs.lstat(file);
  if (!directory.isDirectory() || directory.isSymbolicLink() || !before.isFile() || before.isSymbolicLink() || before.size > 65536) throw new Error('Unsafe delegation execution record.');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error('Delegation execution record changed.');
    const buffer = Buffer.alloc(opened.size + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0), after = await handle.stat();
    if (bytesRead !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('Delegation execution record changed.');
    return executionSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))));
  } finally { await handle.close(); }
}

/** 与旧回执目录并列保存，避免旧版严格目录遍历把额外文件误认为损坏子任务。 */
export const nativeDelegationExecutionPath = (nativeDirectory: string, identity: RunIdentity, batchId: string) => {
  nativeAgentReceiptDirectory(path.dirname(nativeDirectory), identity);
  z.string().uuid().parse(batchId);
  return path.join(nativeDirectory, 'delegation-executions', identity.conversationId, identity.runId, `${batchId}.json`);
};
export const nativeDelegationAuditPath = (dataDirectory: string, identity: RunIdentity) => {
  nativeAgentReceiptDirectory(dataDirectory, identity);
  return path.join(dataDirectory, 'native', 'delegation-audits', identity.conversationId, `${identity.runId}.json`);
};
/** 持久化核验可在重复请求或重新打开会话时重建，未知回执不能被成功状态覆盖。 */
export async function saveNativeDelegationAudit(dataDirectory: string, run: StoredRun): Promise<NativeDelegationAudit> {
  const projection = await loadNativeAgents(dataDirectory, run.identity), receipts = projection.receipts(), executions: NativeDelegationExecution[] = [];
  const childRuns = new Map<string, StoredRun>();
  let incomplete = projection.snapshot(false).incomplete === true;
  for (const batchId of new Set(receipts.map(receipt => receipt.batchId))) {
    try { executions.push(await readExecution(nativeDelegationExecutionPath(path.join(dataDirectory, 'native'), run.identity, batchId), path.resolve(dataDirectory))); }
    catch { if (nativeParallelReviewIntent(run.input).mode === 'explicit_parallel_review') incomplete = true; }
  }
  for (const receipt of receipts.filter(value => value.mode === 'review')) {
    let childStore: NativeRunStore | undefined;
    try {
      // 审计只打开实际存在的证据账本，不能因一次核验而创建缺失子会话。
      const journalPath = receipt.result?.evidence?.runJournalPath;
      if (!journalPath) { incomplete = true; continue; }
      const journal = await fs.lstat(journalPath);
      if (!journal.isFile() || journal.isSymbolicLink()) throw new Error('Delegated child journal evidence is unavailable.');
      childStore = await NativeRunStore.open({ rootDirectory: path.join(dataDirectory, 'native', 'conversations'), conversationId: receipt.identity.conversationId });
      const child = childStore.getRun(receipt.identity.runId);
      if (!childStore.recoveryRequired && child && sameIdentity(child.identity, receipt.identity)) childRuns.set(receipt.childId, child);
      else incomplete = true;
    } catch { incomplete = true; }
    finally { await childStore?.close(); }
  }
  const audit = auditNativeDelegation({ run, receipts, executions, childRuns, incomplete });
  if (audit.intent.mode !== 'not_explicit' || receipts.length) await writeAgentReceipt(nativeDelegationAuditPath(dataDirectory, run.identity), audit);
  return audit;
}

const issueMessages: Record<string, string> = {
  child_execution_incomplete: '子任务未全部完成', parallel_batch_requires_two_children: '同批没有至少两个子任务', duplicate_review_goals: '委派问题重复',
  review_handoff_incomplete: '材料、版本、范围、证据或返回格式交接不完整', parallel_execution_evidence_missing: '缺少实际并行执行证据',
  actual_child_intervals_do_not_overlap: '实际子任务执行区间未交叠', actual_child_results_not_fully_inspected: '未完整读取真实子任务成果',
  no_actual_review_batch: '没有实际批量只读委派', delegation_receipts_incomplete: '回执或执行证据无法确认',
  actual_child_material_reads_missing: '缺少子任务实际读取材料的账本证据',
  material_read_evidence_unconfirmed: '材料位置、版本或实际读取内容无法机械核对', child_terminal_receipt_mismatch: '子回执与实际账本终局不一致',
  delegation_conflicts_with_single_agent: '用户明确要求单 Agent 或禁止委派，但模型仍发起委派调用',
};
/** 宿主执行完成与用户请求完成分开；失败摘要优先展示核验缺口，不能沿用模型的成功宣称。 */
export function nativeDelegationAuditFailure(audit: NativeDelegationAudit, run: Pick<RunResult, 'status'>): string | undefined {
  if (run.status !== 'completed' || audit.status === 'not_required' || audit.status === 'satisfied') return undefined;
  return `${audit.intent.mode === 'single_agent' ? '单 Agent 要求' : '并行审阅要求'}未满足：${audit.issues.map(issue => issueMessages[issue] ?? issue).join('；')}。宿主未将本轮标为成功。`;
}
