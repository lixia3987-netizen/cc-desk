import { hashJson } from './native-eval-engineering-common.mjs';
import { loadEngineeringBatch } from './native-eval-engineering-reports.mjs';

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
    if (record.budget[field] === null) add('missing_budget', `budget.${field}`);
  }
  if (record.budget.approvalPolicy === null || !record.budget.approvalPolicy.trim()) add('missing_budget', 'budget.approvalPolicy');
  if (!record.budget.stopConditions.length || record.budget.stopConditions.some(value => !value.trim())) add('missing_budget', 'budget.stopConditions');
  if (record.budget.activeDurationMs !== null && record.budget.wallDurationMs !== null && record.budget.activeDurationMs > record.budget.wallDurationMs) {
    add('inconsistent_duration_budget', 'budget.activeDurationMs');
  }
  if (slot.attempts.length) add('existing_verification_attempt', 'attempts');
  // Zero usage, false usageComplete and references on otherwise pending records
  // are still evidence of an existing run, never permission to start it again.
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

/** Read only the fixed batch metadata; references are opaque declarations. */
export async function checkEngineeringReadiness(batchDirectory) {
  let batch;
  try {
    // Preserve the existing complete matrix, suite, size, attempt and lock
    // validation. Invalid historical-schema data is an error, not a ready slot.
    batch = await loadEngineeringBatch(batchDirectory);
  } catch {
    // Parser and filesystem errors can contain record fragments or paths.
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
