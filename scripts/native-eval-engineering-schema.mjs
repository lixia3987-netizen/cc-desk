// Pure validation shared by the operator report and verification runner.
export const MAX_ATTEMPTS = 120;
export const MAX_REPORT_BYTES = 8 * 1024 * 1024;
export const MAX_RECORD_BYTES = 16 * 1024;
export const MAX_INTENT_BYTES = 24 * 1024;
export const MAX_VERIFIER_METADATA_BYTES = 24 * 1024;
export const MAX_RECEIPT_BYTES = 32 * 1024;
export const RECORD_STATUSES = ['pending', 'completed', 'failed', 'cancelled', 'budget_exceeded', 'environment_error'];
export const ENGINES = ['native', 'claude'];
export const ROUNDS = [1, 2];
export const SHA256 = /^[a-f0-9]{64}$/;
export const REVISION = /^[a-f0-9]{40}$/;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function fail(label) { throw new Error(`Invalid engineering ${label}.`); }
export function assertJsonBudget(value, maximum, label) {
  if (new TextEncoder().encode(JSON.stringify(value, null, 2)).length > maximum) fail(`${label} byte budget`);
}
export function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(label);
  const actual = Object.keys(value).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== [...keys].sort()[index])) fail(`${label} fields`);
}
function text(value, label, { nullable = false, max = 2000, nonempty = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim()) || value.includes('\0')) fail(label);
}
function number(value, label, { nullable = true, integer = true } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) fail(label);
}
function choice(value, allowed, label) { if (!allowed.includes(value)) fail(label); }
function hash(value, pattern, label) { if (typeof value !== 'string' || !pattern.test(value)) fail(label); }
function timestamp(value, label, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|\+08:00)$/.test(value) || !Number.isFinite(Date.parse(value))) fail(label);
}
function texts(value, label, limit = 32) {
  if (!Array.isArray(value) || value.length > limit) fail(label);
  value.forEach(entry => text(entry, label));
}
function amountCurrency(value, label) {
  number(value.costAmount, `${label} costAmount`, { integer: false });
  if (value.currency !== null && (typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency))) fail(`${label} currency`);
  if (value.costAmount !== null && value.currency === null) fail(`${label} cost currency`);
}
export function assertSuiteIdentity(value, expected) {
  object(value, ['id', 'taskBaseline', 'digest'], 'suite');
  text(value.id, 'suite id', { max: 100, nonempty: true });
  hash(value.taskBaseline, REVISION, 'task baseline'); hash(value.digest, SHA256, 'suite digest');
  if (expected && ['id', 'taskBaseline', 'digest'].some(key => value[key] !== expected[key])) fail('suite identity mismatch');
}
export function engineeringSlots(tasks) {
  return ENGINES.flatMap(engine => tasks.flatMap(({ id: taskId }) => ROUNDS.map(round => {
    const runId = `${engine}-${taskId}-r${round}`;
    return { runId, taskId, engine, round, recordFile: `records/${runId}.json` };
  })));
}
export function assertBatchManifest(manifest, suite, tasks) {
  object(manifest, ['kind', 'schemaVersion', 'suite', 'appRevision', 'createdAt', 'slots'], 'batch manifest');
  if (manifest.kind !== 'native-engineering-batch' || manifest.schemaVersion !== 1) fail('batch version');
  assertSuiteIdentity(manifest.suite, suite); hash(manifest.appRevision, REVISION, 'app revision'); timestamp(manifest.createdAt, 'createdAt');
  const expected = engineeringSlots(tasks);
  if (!Array.isArray(manifest.slots) || manifest.slots.length !== expected.length) fail('batch slots');
  manifest.slots.forEach((slot, index) => {
    object(slot, ['runId', 'taskId', 'engine', 'round', 'recordFile'], 'slot');
    if (Object.keys(expected[index]).some(key => slot[key] !== expected[index][key])) fail('batch slot identity/order');
  });
  return manifest;
}
const budgetNumbers = ['modelRequests', 'toolCalls', 'inputTokens', 'outputTokens', 'activeDurationMs', 'wallDurationMs'];
export const METRIC_NUMBERS = ['activeDurationMs', 'approvalWaitMs', 'verificationDurationMs', 'inputTokens', 'outputTokens', 'modelRequests', 'toolCalls', 'searchCalls', 'approvalCount', 'clarificationCount', 'rescuePromptCount', 'manualCodeEdits', 'wrongScopeChanges', 'statusMismatches'];
export function assertEngineeringRecord(record, slot, manifest) {
  object(record, ['schemaVersion', 'suiteId', 'taskBaseline', 'suiteDigest', 'taskId', 'round', 'engine', 'appRevision', 'model', 'protocol', 'configurationReference', 'credentialSourceReference', 'budget', 'evidence', 'result', 'metrics', 'limitations'], 'record');
  if (record.schemaVersion !== 1 || record.suiteId !== manifest.suite.id || record.taskBaseline !== manifest.suite.taskBaseline || record.suiteDigest !== manifest.suite.digest || record.appRevision !== manifest.appRevision || record.taskId !== slot.taskId || record.engine !== slot.engine || record.round !== slot.round) fail('record identity');
  for (const key of ['model', 'protocol', 'configurationReference', 'credentialSourceReference']) text(record[key], key, { nullable: true, nonempty: true });
  object(record.budget, [...budgetNumbers, 'costAmount', 'currency', 'approvalPolicy', 'stopConditions'], 'budget');
  budgetNumbers.forEach(key => number(record.budget[key], `budget ${key}`)); amountCurrency(record.budget, 'budget');
  text(record.budget.approvalPolicy, 'approval policy', { nullable: true, nonempty: true }); texts(record.budget.stopConditions, 'stop conditions');
  const evidenceRefs = ['sessionReference', 'transcriptReference', 'candidateCommit', 'diffReference', 'independentVerifierReference', 'originalTestsReference', 'newTestsReference', 'humanReviewReference'];
  object(record.evidence, ['kind', ...evidenceRefs], 'evidence');
  choice(record.evidence.kind, ['pending', 'local-fixture', 'manual-real'], 'evidence kind');
  evidenceRefs.forEach(key => text(record.evidence[key], key, { nullable: true, nonempty: true }));
  if (record.evidence.candidateCommit !== null) hash(record.evidence.candidateCommit, REVISION, 'candidate commit');
  if (record.evidence.kind === 'manual-real' && !record.evidence.sessionReference && !record.evidence.transcriptReference) fail('manual-real evidence reference');
  object(record.result, ['status', 'functionalStatus', 'realQualityStatus', 'graphicalAcceptance', 'platformAcceptance', 'failureClass', 'failureReason'], 'declared result');
  choice(record.result.status, RECORD_STATUSES, 'declared status'); choice(record.result.functionalStatus, ['pending', 'pass', 'fail'], 'declared functional status');
  for (const key of ['realQualityStatus', 'graphicalAcceptance', 'platformAcceptance']) if (record.result[key] !== 'pending') fail(`${key}: independent manual review required`);
  text(record.result.failureClass, 'failure class', { nullable: true, max: 100, nonempty: true }); text(record.result.failureReason, 'failure reason', { nullable: true, max: 8000, nonempty: true });
  object(record.metrics, ['startedAtBeijing', 'finishedAtBeijing', ...METRIC_NUMBERS, 'usageComplete', 'costAmount', 'currency'], 'metrics');
  METRIC_NUMBERS.forEach(key => number(record.metrics[key], `metric ${key}`)); amountCurrency(record.metrics, 'metrics');
  timestamp(record.metrics.startedAtBeijing, 'startedAtBeijing', true); timestamp(record.metrics.finishedAtBeijing, 'finishedAtBeijing', true);
  for (const key of ['startedAtBeijing', 'finishedAtBeijing']) if (record.metrics[key] !== null && !record.metrics[key].endsWith('+08:00')) fail(`${key} timezone`);
  if (record.metrics.startedAtBeijing && record.metrics.finishedAtBeijing && Date.parse(record.metrics.finishedAtBeijing) < Date.parse(record.metrics.startedAtBeijing)) fail('metric time order');
  choice(record.metrics.usageComplete, [null, true, false], 'usageComplete'); texts(record.limitations, 'limitations', 64);
  assertJsonBudget(record, MAX_RECORD_BYTES, 'record');
  return record;
}

export function assertAttemptIntent(value) {
  object(value, ['kind', 'schemaVersion', 'attemptId', 'runId', 'suite', 'record', 'recordDigest', 'candidateDirectory', 'startedAt', 'timeoutMs'], 'attempt intent');
  if (value.kind !== 'native-engineering-attempt' || value.schemaVersion !== 1) fail('attempt version');
  hash(value.attemptId, UUID, 'attempt id'); text(value.runId, 'run id', { max: 200, nonempty: true });
  assertSuiteIdentity(value.suite); hash(value.recordDigest, SHA256, 'attempt record digest');
  text(value.candidateDirectory, 'candidate directory', { max: 8000, nonempty: true }); timestamp(value.startedAt, 'attempt start');
  number(value.timeoutMs, 'attempt timeout', { nullable: false }); if (value.timeoutMs < 1 || value.timeoutMs > 300_000) fail('attempt timeout');
  const record = value.record;
  if (!record || !ENGINES.includes(record.engine) || !ROUNDS.includes(record.round) || !/^[a-z0-9-]{1,100}$/.test(record.taskId)) fail('attempt record identity');
  if (value.runId !== `${record.engine}-${record.taskId}-r${record.round}`) fail('attempt run identity');
  hash(record.appRevision, REVISION, 'attempt app revision');
  assertEngineeringRecord(record, { taskId: record.taskId, engine: record.engine, round: record.round }, { suite: value.suite, appRevision: record.appRevision });
  assertJsonBudget(value, MAX_INTENT_BYTES, 'intent');
  return value;
}
export const VERIFICATION_STATUSES = ['pass', 'fail', 'timeout', 'cancelled', 'error', 'unknown'];
export function assertVerifierOutput(output, exitCode, taskId) {
  object(output, ['schemaVersion', 'kind', 'taskId', 'status', 'functionalStatus', 'verification', 'postIntegrity', 'error'], 'verifier output');
  if (output.schemaVersion !== 1 || output.kind !== 'native-engineering-verification' || output.taskId !== taskId || !['pass', 'fail'].includes(output.status) || output.functionalStatus !== output.status) fail('verifier output identity');
  const metadata = structuredClone(output);
  if (Array.isArray(metadata.verification?.testResults)) for (const item of metadata.verification.testResults) if (item && typeof item === 'object') delete item.output;
  assertJsonBudget(metadata, MAX_VERIFIER_METADATA_BYTES, 'verifier metadata');
  if (output.status === 'fail') {
    if (exitCode !== 1 || output.verification !== null || output.postIntegrity !== null) fail('verifier failure closure');
    text(output.error, 'verifier error', { max: 16000 }); return output;
  }
  const value = output.verification, integrity = output.postIntegrity;
  if (exitCode !== 0 || output.error !== null || value?.task !== taskId || value?.functionalStatus !== 'pass' || value?.realQualityStatus !== 'pending' || value?.graphicalAcceptance !== 'pending' || value?.independentHumanReview !== 'required' || !Number.isSafeInteger(integrity?.protectedFiles) || integrity.protectedFiles < 1 || value?.integrity?.protectedFiles !== integrity.protectedFiles || !Array.isArray(value?.testResults) || value.testResults.length !== 5) fail('verifier success closure');
  texts(integrity.changed, 'integrity changed paths', 100); texts(value.integrity.changed, 'initial integrity changed paths', 100);
  const labels = ['compile contracts', 'compile engine-claude', 'compile agent-core', 'compile agent-node', 'selected original and new regression tests'];
  for (const [index, result] of value.testResults.entries()) {
    if (result?.exitCode !== 0 || result.signal !== null || result.label !== labels[index] || result.executable !== 'node' || !Array.isArray(result.argv) || !result.argv.length) fail('verifier selected checks');
    texts(result.argv, 'check argv', 40); number(result.durationMs, 'check duration', { nullable: false });
    if ('output' in result) text(result.output, 'check log', { max: 12000 });
    choice(result.truncated, [true, false], 'check truncation');
  }
  return output;
}
export function assertAttemptResult(value) {
  object(value, ['kind', 'schemaVersion', 'attemptId', 'runId', 'intentDigest', 'finishedAt', 'verification', 'candidate', 'realQualityStatus'], 'attempt result');
  if (value.kind !== 'native-engineering-attempt-result' || value.schemaVersion !== 1) fail('attempt result version');
  hash(value.attemptId, UUID, 'attempt id'); text(value.runId, 'run id', { max: 200, nonempty: true });
  hash(value.intentDigest, SHA256, 'intent digest'); timestamp(value.finishedAt, 'attempt finish');
  if (value.realQualityStatus !== 'pending') fail('attempt real quality');
  const verification = value.verification;
  object(verification, ['status', 'exitCode', 'signal', 'durationMs', 'stdout', 'stderr', 'stdoutTruncated', 'stderrTruncated', 'output', 'cleanupConfirmed'], 'verification');
  choice(verification.status, VERIFICATION_STATUSES, 'verification status'); number(verification.durationMs, 'verification duration', { nullable: false });
  if (verification.exitCode !== null && (!Number.isSafeInteger(verification.exitCode) || verification.exitCode < -2147483648 || verification.exitCode > 2147483647)) fail('verification exit code');
  text(verification.signal, 'verification signal', { nullable: true, max: 100, nonempty: true });
  for (const key of ['stdout', 'stderr']) {
    text(verification[key], `verification ${key}`, { max: 256 * 1024 });
    if (new TextEncoder().encode(verification[key]).length > 256 * 1024) fail(`verification ${key} bytes`);
  }
  for (const key of ['stdoutTruncated', 'stderrTruncated', 'cleanupConfirmed']) choice(verification[key], [true, false], key);
  if (verification.output !== null && (!verification.output || typeof verification.output !== 'object' || Array.isArray(verification.output))) fail('verification output');
  if (verification.output !== null) {
    const match = /^(?:native|claude)-(.+)-r[12]$/.exec(value.runId);
    if (!match) fail('verification run identity');
    assertVerifierOutput(verification.output, verification.exitCode, match[1]);
  }
  if (!verification.cleanupConfirmed && verification.status !== 'unknown') fail('unconfirmed verification cleanup');
  if (verification.status === 'pass' && (verification.exitCode !== 0 || verification.signal !== null || verification.stdoutTruncated || verification.stderrTruncated || verification.output?.functionalStatus !== 'pass')) fail('verification pass closure');
  object(value.candidate, ['head', 'beforeDigest', 'afterDigest', 'changedDuringVerification'], 'candidate');
  if (value.candidate.head !== null) hash(value.candidate.head, REVISION, 'candidate head');
  for (const key of ['beforeDigest', 'afterDigest']) if (value.candidate[key] !== null) hash(value.candidate[key], SHA256, `candidate ${key}`);
  choice(value.candidate.changedDuringVerification, [null, true, false], 'candidate changed');
  if (verification.status === 'pass' && (value.candidate.head === null || value.candidate.beforeDigest === null || value.candidate.afterDigest !== value.candidate.beforeDigest || value.candidate.changedDuringVerification !== false)) fail('candidate pass closure');
  return value;
}
