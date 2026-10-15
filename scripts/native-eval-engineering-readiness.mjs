import { hashJson } from './native-eval-engineering-common.mjs';
import { loadEngineeringBatch } from './native-eval-engineering-reports.mjs';
import { UNLIMITED_BUDGET } from './native-eval-engineering-schema.mjs';

const METADATA_FIELDS = ['model', 'protocol', 'configurationReference', 'credentialSourceReference'];
const EXECUTION_BUDGET_FIELDS = ['modelRequests', 'toolCalls', 'inputTokens', 'outputTokens', 'activeDurationMs', 'wallDurationMs'];
const LIMITATIONS = [
  'This check inspects operator-declared metadata only; metadata_complete does not authorize execution.',
  'Configuration and credential references are checked for declared presence only; their targets are neither read nor authenticated.',
  'The declared application revision, model and service are not compared with actual installed binaries or live services.',
  'Per-run budgets are declarations; a batch spending limit and authorization require external confirmation.',
  'This command does not execute candidates, call models or assess real quality, graphical behavior or platform behavior.',
];

function inspectSlot(slot) {
  const { record } = slot, issues = [];
  const add = (code, field) => issues.push({ code, field });
  for (const field of METADATA_FIELDS) {
    if (record[field] === null || !record[field].trim()) add('missing_metadata', field);
  }
  for (const field of EXECUTION_BUDGET_FIELDS) {
    if (record.budget[field] === null) add('missing_budget', `budget.${field}`);
    else if (record.budget[field] === 0) add('nonpositive_execution_budget', `budget.${field}`);
  }
  for (const field of ['costAmount', 'currency']) {
    if (field === 'currency' && record.budget.costAmount === UNLIMITED_BUDGET) continue;
    if (record.budget[field] === null) add('missing_budget', `budget.${field}`);
  }
  if (record.budget.approvalPolicy === null || !record.budget.approvalPolicy.trim()) add('missing_budget', 'budget.approvalPolicy');
  if (!record.budget.stopConditions.length || record.budget.stopConditions.some(value => !value.trim())) add('missing_budget', 'budget.stopConditions');
  if (typeof record.budget.wallDurationMs === 'number' && (record.budget.activeDurationMs === UNLIMITED_BUDGET || typeof record.budget.activeDurationMs === 'number' && record.budget.activeDurationMs > record.budget.wallDurationMs)) {
    add('inconsistent_duration_budget', 'budget.activeDurationMs');
  }
  if (slot.attempts.length) add('existing_verification_attempt', 'attempts');
  // 即使记录仍处于待执行状态，零用量、为 false 的 usageComplete 或引用
  // 也能证明已经运行过，不能据此允许再次启动。
  for (const [field, value] of Object.entries(record.result)) {
    const initial = field === 'failureClass' || field === 'failureReason' ? null : 'pending';
    if (value !== initial) add('existing_run_evidence', `result.${field}`);
  }
  for (const [field, value] of Object.entries(record.evidence)) {
    if (value !== (field === 'kind' ? 'pending' : null)) add('existing_run_evidence', `evidence.${field}`);
  }
  for (const [field, value] of Object.entries(record.metrics)) {
    if (value !== null) add('existing_run_evidence', `metrics.${field}`);
  }
  return {
    runId: slot.runId, engine: slot.engine, taskId: slot.taskId, round: slot.round,
    recordDigest: slot.recordDigest, status: issues.length ? 'blocked' : 'metadata_complete', issues,
  };
}

/** 仅读取固定批次的元数据；引用仅视为声明，不解析其内容。 */
export async function checkEngineeringReadiness(batchDirectory) {
  let batch;
  try {
    // 保留现有的完整矩阵、测试集、大小、尝试次数及锁
    // 校验。旧版结构中的无效数据应报告错误，不能作为可运行的条目。
    batch = await loadEngineeringBatch(batchDirectory);
  } catch {
    // 解析器和文件系统错误可能包含记录片段或路径。
    throw new Error('Invalid engineering readiness batch; check manifest, records and attempts.');
  }
  const slots = batch.slots.map(inspectSlot);
  const blockers = batch.verificationLock === null ? [] : [{ code: 'verification_locked' }];
  const completeCount = slots.filter(slot => slot.status === 'metadata_complete').length;
  return {
    kind: 'native-engineering-readiness', schemaVersion: 1,
    appRevision: batch.manifest.appRevision, suite: batch.manifest.suite,
    manifestDigest: hashJson(batch.manifest),
    status: blockers.length || completeCount !== slots.length ? 'blocked' : 'metadata_complete',
    slots, blockers,
    summary: { slotCount: slots.length, completeCount, blockedCount: slots.length - completeCount },
    realQualityStatus: 'pending', graphicalAcceptance: 'pending', platformAcceptance: 'pending',
    executionAuthorized: false, runtimeStatus: 'not_checked', batchBudgetStatus: 'external_confirmation_required',
    limitations: [...LIMITATIONS],
  };
}
