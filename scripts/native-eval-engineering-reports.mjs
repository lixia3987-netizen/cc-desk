import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEngineeringSuite, ordinaryDirectory, readJson, createJson, hashJson, assertSeparate, evaluatorRoot } from './native-eval-engineering-common.mjs';
import { MAX_ATTEMPTS, MAX_REPORT_BYTES, MAX_RECEIPT_BYTES, RECORD_STATUSES, METRIC_NUMBERS, VERIFICATION_STATUSES, ENGINES, UUID, REVISION, engineeringSlots, assertSuiteIdentity, assertBatchManifest, assertEngineeringRecord, assertAttemptIntent, assertAttemptResult, assertJsonBudget, object } from './native-eval-engineering-schema.mjs';

const LIMITATIONS = [
  'Records, evidence references and human review references are operator declarations; this tool does not authenticate them or contact a model service.',
  'Verification is limited to the recorded independent checks. It does not establish real model quality, graphical acceptance or platform acceptance.',
  'Every stored attempt is retained, including failures and unfinished attempts. The tool cannot discover runs or edits omitted outside this batch.',
  'Unknown metrics remain null. Partial usage and mixed currencies do not establish complete token or cost totals.',
  'This small fixed task matrix does not estimate general success rates, select a winning engine, or change the default engine.',
  'Full logs remain in the referenced operator attempt files. Comparison validates report structure and summaries, but does not re-read or authenticate those external references.',
  'Metric totals describe the current twelve declared model-run records, not the number or total cost of repeated verifier attempts. Prior record snapshots remain attached to each attempt.',
];

export async function initializeEngineeringBatch(directory, appRevision) {
  if (typeof appRevision !== 'string' || !REVISION.test(appRevision)) throw new Error('Application revision must be a full lowercase 40-character commit hash.');
  const { suite, manifest: sourceManifest, template } = await loadEngineeringSuite();
  assertSeparate(path.resolve(directory), evaluatorRoot);
  await fs.mkdir(path.resolve(directory), { recursive: true });
  const root = await ordinaryDirectory(directory);
  if ((await fs.readdir(root)).length) throw new Error('Refusing to initialize a nonempty engineering batch directory.');
  const manifest = { kind: 'native-engineering-batch', schemaVersion: 1, suite, appRevision, createdAt: new Date().toISOString(), slots: engineeringSlots(sourceManifest.tasks) };
  await fs.mkdir(path.join(root, 'records')); await fs.mkdir(path.join(root, 'attempts'));
  for (const slot of manifest.slots) {
    const record = { ...structuredClone(template), suiteId: suite.id, taskBaseline: suite.taskBaseline, suiteDigest: suite.digest, taskId: slot.taskId, engine: slot.engine, round: slot.round, appRevision };
    assertEngineeringRecord(record, slot, manifest);
    await createJson(path.join(root, slot.recordFile), record);
  }
  await createJson(path.join(root, 'manifest.json'), manifest);
  return manifest;
}

async function entries(directory) {
  const root = await ordinaryDirectory(directory);
  return (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
}
function validateLock(lock, manifest) {
  if (lock === null) return null;
  object(lock, ['kind', 'schemaVersion', 'owner', 'runId', 'candidateDirectory', 'createdAt'], 'verification lock');
  if (lock.kind !== 'native-engineering-verification-lock' || lock.schemaVersion !== 1 || !UUID.test(lock.owner) || !manifest.slots.some(slot => slot.runId === lock.runId) || typeof lock.candidateDirectory !== 'string' || !path.isAbsolute(lock.candidateDirectory) || lock.candidateDirectory.length > 8000 || typeof lock.createdAt !== 'string' || !Number.isFinite(Date.parse(lock.createdAt))) throw new Error('Invalid engineering verification lock.');
  return lock;
}
export async function loadEngineeringBatch(directory) {
  const root = await ordinaryDirectory(directory), { suite, manifest: sourceManifest } = await loadEngineeringSuite();
  assertSeparate(root, evaluatorRoot);
  const manifest = assertBatchManifest(await readJson(path.join(root, 'manifest.json')), suite, sourceManifest.tasks);
  const recordEntries = await entries(path.join(root, 'records'));
  if (recordEntries.length !== manifest.slots.length || recordEntries.some(entry => !entry.isFile() || entry.isSymbolicLink() || !manifest.slots.some(slot => slot.recordFile === `records/${entry.name}`))) throw new Error('Engineering records must match every fixed batch slot exactly.');
  await ordinaryDirectory(path.join(root, 'attempts'));
  const records = new Map();
  // Validate the entire matrix before any runner can execute a candidate.
  for (const slot of manifest.slots) records.set(slot.runId, assertEngineeringRecord(await readJson(path.join(root, slot.recordFile)), slot, manifest));
  const slots = manifest.slots.map(slot => ({ ...slot, record: records.get(slot.runId), recordDigest: hashJson(records.get(slot.runId)), attempts: [] }));
  await collectAttempts(root, manifest, slots);
  let verificationLock = null;
  try { verificationLock = validateLock(await readJson(path.join(root, 'verification-lock.json')), manifest); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { root, manifest, records, slots, verificationLock, attemptCount: slots.reduce((count, slot) => count + slot.attempts.length, 0), attempts: new Map(slots.map(slot => [slot.runId, slot.attempts])) };
}

function validateAttempt(attempt, slot, manifest) {
  object(attempt, ['attemptId', 'intent', 'intentDigest', 'intentReference', 'result', 'resultDigest', 'resultReference', 'receiptDigest', 'status', 'recordChanged'], 'reported attempt');
  const intent = assertAttemptIntent(attempt.intent);
  if (!path.isAbsolute(intent.candidateDirectory)) throw new Error('Attempt candidate directory must be absolute.');
  assertSuiteIdentity(intent.suite, manifest.suite);
  assertEngineeringRecord(intent.record, slot, manifest);
  if (intent.runId !== slot.runId || intent.attemptId !== attempt.attemptId || hashJson(intent.record) !== intent.recordDigest || hashJson(intent) !== attempt.intentDigest) throw new Error('Engineering attempt intent binding mismatch.');
  const prefix = `attempts/${slot.runId}/${attempt.attemptId}`;
  if (attempt.intentReference !== `${prefix}/intent.json`) throw new Error('Invalid attempt intent reference.');
  if (attempt.result !== null) {
    const result = validateReceipt(attempt.result);
    if (result.attemptId !== attempt.attemptId || result.runId !== slot.runId || result.intentDigest !== attempt.intentDigest || hashJson(result) !== attempt.receiptDigest || !/^[a-f0-9]{64}$/.test(attempt.resultDigest) || attempt.resultReference !== `${prefix}/result.json` || Date.parse(result.finishedAt) < Date.parse(intent.startedAt)) throw new Error('Engineering attempt result binding mismatch.');
  } else if (attempt.resultDigest !== null || attempt.receiptDigest !== null || attempt.resultReference !== null) throw new Error('Missing attempt result cannot have a digest or reference.');
  if (attempt.status !== (attempt.result?.verification.status ?? 'unknown') || attempt.recordChanged !== (intent.recordDigest !== slot.recordDigest)) throw new Error('Engineering attempt derived status mismatch.');
}
function receiptFor(result) {
  const { stdout, stderr, output, ...verification } = result.verification;
  const compactOutput = output === null ? null : structuredClone(output);
  if (compactOutput?.verification?.testResults) for (const test of compactOutput.verification.testResults) delete test.output;
  return { ...result, verification: { ...verification, output: compactOutput, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), stdoutDigest: hashJson(stdout), stderrDigest: hashJson(stderr), outputDigest: hashJson(output) } };
}
function validateReceipt(receipt) {
  object(receipt, ['kind', 'schemaVersion', 'attemptId', 'runId', 'intentDigest', 'finishedAt', 'verification', 'candidate', 'realQualityStatus'], 'attempt receipt');
  const { stdoutBytes, stderrBytes, stdoutDigest, stderrDigest, outputDigest, ...verification } = receipt.verification;
  object(receipt.verification, ['status', 'exitCode', 'signal', 'durationMs', 'stdoutTruncated', 'stderrTruncated', 'output', 'cleanupConfirmed', 'stdoutBytes', 'stderrBytes', 'stdoutDigest', 'stderrDigest', 'outputDigest'], 'attempt verification receipt');
  for (const count of [stdoutBytes, stderrBytes]) if (!Number.isSafeInteger(count) || count < 0 || count > 256 * 1024) throw new Error('Invalid attempt log byte count.');
  for (const digest of [stdoutDigest, stderrDigest, outputDigest]) if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid attempt log digest.');
  assertAttemptResult({ ...receipt, verification: { ...verification, stdout: '', stderr: '' } });
  if (receipt.verification.output?.verification?.testResults?.some(test => 'output' in test)) throw new Error('Full verifier logs must remain outside the compact report.');
  assertJsonBudget(receipt, MAX_RECEIPT_BYTES, 'compact receipt');
  return receipt;
}
async function collectAttempts(root, manifest, slots) {
  const directories = await entries(path.join(root, 'attempts'));
  const byRun = new Map(slots.map(slot => [slot.runId, slot]));
  let count = 0;
  for (const run of directories) {
    if (!run.isDirectory() || run.isSymbolicLink() || !byRun.has(run.name)) throw new Error('Unknown or nonordinary engineering attempt run directory.');
    const slot = byRun.get(run.name);
    for (const attemptEntry of await entries(path.join(root, 'attempts', run.name))) {
      if (!attemptEntry.isDirectory() || attemptEntry.isSymbolicLink() || !UUID.test(attemptEntry.name) || ++count > MAX_ATTEMPTS) throw new Error('Invalid or excessive engineering attempts.');
      const directory = path.join(root, 'attempts', run.name, attemptEntry.name);
      const files = await entries(directory);
      if (!files.some(file => file.name === 'intent.json') || files.some(file => !file.isFile() || file.isSymbolicLink() || !['intent.json', 'result.json'].includes(file.name))) throw new Error('Attempt directory must contain an ordinary intent and optional result.');
      const intent = await readJson(path.join(directory, 'intent.json'));
      const originalResult = files.some(file => file.name === 'result.json') ? assertAttemptResult(await readJson(path.join(directory, 'result.json'))) : null;
      const result = originalResult === null ? null : receiptFor(originalResult);
      const prefix = `attempts/${run.name}/${attemptEntry.name}`;
      const attempt = { attemptId: attemptEntry.name, intent, intentDigest: hashJson(intent), intentReference: `${prefix}/intent.json`, result, resultDigest: originalResult === null ? null : hashJson(originalResult), resultReference: result === null ? null : `${prefix}/result.json`, receiptDigest: result === null ? null : hashJson(result), status: result?.verification?.status ?? 'unknown', recordChanged: intent.recordDigest !== slot.recordDigest };
      validateAttempt(attempt, slot, manifest); slot.attempts.push(attempt);
    }
    slot.attempts.sort((a, b) => a.intent.startedAt.localeCompare(b.intent.startedAt) || a.attemptId.localeCompare(b.attemptId));
  }
}

function numericSummary(slots, key) {
  const known = slots.map(slot => slot.record.metrics[key]).filter(value => value !== null);
  const usageMetric = ['inputTokens', 'outputTokens', 'costAmount'].includes(key);
  const usageComplete = !usageMetric || slots.every(slot => slot.record.metrics.usageComplete === true);
  const currencies = [...new Set(slots.map(slot => slot.record.metrics.currency).filter(value => value !== null))].sort();
  const compatibleCurrency = key !== 'costAmount' || (currencies.length === 1 && slots.every(slot => slot.record.metrics.currency === currencies[0]));
  const complete = known.length === slots.length && usageComplete && compatibleCurrency;
  const knownSum = known.length ? known.reduce((sum, value) => sum + value, 0) : null;
  if (knownSum !== null && (!Number.isFinite(knownSum) || (key !== 'costAmount' && !Number.isSafeInteger(knownSum)))) throw new Error('Engineering metric aggregate exceeds its numeric bound.');
  return { knownCount: known.length, totalCount: slots.length, knownSum: key === 'costAmount' && currencies.length !== 1 ? null : knownSum, sum: complete ? knownSum : null, complete,
    ...(usageMetric ? { usageCompleteCount: slots.filter(slot => slot.record.metrics.usageComplete === true).length } : {}),
    ...(key === 'costAmount' ? { currency: currencies.length === 1 ? currencies[0] : null, currencies } : {}) };
}
function summarizeSlots(slots) {
  const attempts = slots.flatMap(slot => slot.attempts);
  return { slotCount: slots.length, attemptCount: attempts.length, unattemptedSlots: slots.filter(slot => !slot.attempts.length).length,
    declaredStatuses: Object.fromEntries(RECORD_STATUSES.map(status => [status, slots.filter(slot => slot.record.result.status === status).length])),
    verificationStatuses: Object.fromEntries(VERIFICATION_STATUSES.map(status => [status, attempts.filter(attempt => attempt.status === status).length])),
    recordsChangedSinceAttempt: attempts.filter(attempt => attempt.recordChanged).length,
    metrics: Object.fromEntries([...METRIC_NUMBERS, 'costAmount'].map(key => [key, numericSummary(slots, key)])) };
}
function summary(slots, verificationLock) { return { ...summarizeSlots(slots), verificationLocked: verificationLock !== null, byEngine: Object.fromEntries(ENGINES.map(engine => [engine, summarizeSlots(slots.filter(slot => slot.engine === engine))])) }; }

export async function generateEngineeringReport(batchDirectory, outputFile) {
  const { root, manifest, slots, verificationLock } = await loadEngineeringBatch(batchDirectory);
  assertSeparate(path.resolve(outputFile), evaluatorRoot);
  assertSeparate(path.resolve(outputFile), path.join(root, 'records'));
  assertSeparate(path.resolve(outputFile), path.join(root, 'attempts'));
  for (const attempt of slots.flatMap(slot => slot.attempts)) assertSeparate(path.resolve(outputFile), path.resolve(attempt.intent.candidateDirectory));
  if (verificationLock) assertSeparate(path.resolve(outputFile), path.resolve(verificationLock.candidateDirectory));
  const report = { kind: 'native-engineering-report', schemaVersion: 1, suite: manifest.suite, generatedAt: new Date().toISOString(), batch: { manifest, manifestDigest: hashJson(manifest), verificationLock }, slots, summary: summary(slots, verificationLock),
    realQualityStatus: 'pending', graphicalAcceptance: 'pending', platformAcceptance: 'pending', verdict: 'manual-review-required', limitations: LIMITATIONS };
  await createJson(path.resolve(outputFile), report, { maxBytes: MAX_REPORT_BYTES });
  return report;
}

async function validateReport(report) {
  object(report, ['kind', 'schemaVersion', 'suite', 'generatedAt', 'batch', 'slots', 'summary', 'realQualityStatus', 'graphicalAcceptance', 'platformAcceptance', 'verdict', 'limitations'], 'report');
  if (report.kind !== 'native-engineering-report' || report.schemaVersion !== 1 || !Number.isFinite(Date.parse(report.generatedAt))) throw new Error('Invalid engineering report version/date.');
  const { suite, manifest: sourceManifest } = await loadEngineeringSuite();
  assertSuiteIdentity(report.suite, suite);
  object(report.batch, ['manifest', 'manifestDigest', 'verificationLock'], 'report batch');
  const manifest = assertBatchManifest(report.batch.manifest, report.suite, sourceManifest.tasks);
  validateLock(report.batch.verificationLock, manifest);
  if (hashJson(manifest) !== report.batch.manifestDigest || !Array.isArray(report.slots) || report.slots.length !== manifest.slots.length) throw new Error('Invalid engineering report manifest/slots.');
  let count = 0;
  for (const [index, slot] of report.slots.entries()) {
    object(slot, ['runId', 'taskId', 'engine', 'round', 'recordFile', 'record', 'recordDigest', 'attempts'], 'report slot');
    if (Object.keys(manifest.slots[index]).some(key => slot[key] !== manifest.slots[index][key]) || !Array.isArray(slot.attempts)) throw new Error('Invalid engineering report slot identity.');
    assertEngineeringRecord(slot.record, slot, manifest);
    if (slot.recordDigest !== hashJson(slot.record)) throw new Error('Invalid engineering report record digest.');
    const seen = new Set();
    for (const attempt of slot.attempts) {
      if (++count > MAX_ATTEMPTS || seen.has(attempt.attemptId)) throw new Error('Duplicate or excessive report attempts.');
      seen.add(attempt.attemptId); validateAttempt(attempt, slot, manifest);
    }
  }
  if (hashJson(report.summary) !== hashJson(summary(report.slots, report.batch.verificationLock))) throw new Error('Engineering report summary does not match its complete records and attempts.');
  if (['realQualityStatus', 'graphicalAcceptance', 'platformAcceptance'].some(key => report[key] !== 'pending') || report.verdict !== 'manual-review-required' || hashJson(report.limitations) !== hashJson(LIMITATIONS)) throw new Error('Unsupported engineering acceptance verdict or limitations.');
  return report;
}

export async function compareEngineeringReports(leftFile, rightFile) {
  const left = await validateReport(await readJson(leftFile, { maxBytes: MAX_REPORT_BYTES }));
  const right = await validateReport(await readJson(rightFile, { maxBytes: MAX_REPORT_BYTES }));
  assertSuiteIdentity(left.suite, right.suite);
  const metadataKeys = ['model', 'protocol', 'configurationReference', 'credentialSourceReference', 'budget'];
  const differences = [];
  const missingFor = record => [
    ...metadataKeys.filter(key => key !== 'budget' && record[key] === null),
    ...Object.entries(record.budget).filter(([, value]) => value === null || (Array.isArray(value) && value.length === 0)).map(([key]) => `budget.${key}`),
  ];
  const missingMetadata = [];
  if (left.batch.manifest.appRevision !== right.batch.manifest.appRevision) differences.push('appRevision');
  const slots = left.slots.map((a, index) => {
    const b = right.slots[index];
    const changed = metadataKeys.filter(key => hashJson(a.record[key]) !== hashJson(b.record[key]));
    if (changed.length) differences.push(`${a.runId}: ${changed.join(', ')}`);
    const leftMissing = missingFor(a.record), rightMissing = missingFor(b.record);
    if (leftMissing.length || rightMissing.length) missingMetadata.push({ runId: a.runId, left: leftMissing, right: rightMissing });
    const fields = slot => ({ recordDigest: slot.recordDigest, declaredResult: slot.record.result, evidence: slot.record.evidence, metrics: slot.record.metrics,
      metadata: Object.fromEntries(metadataKeys.map(key => [key, slot.record[key]])), attempts: slot.attempts.map(attempt => ({ attemptId: attempt.attemptId, status: attempt.status, recordChanged: attempt.recordChanged, intentDigest: attempt.intentDigest, resultDigest: attempt.resultDigest })) });
    return { runId: a.runId, taskId: a.taskId, engine: a.engine, round: a.round, left: fields(a), right: fields(b), metadataDifferences: changed };
  });
  const engineDifferences = report => report.slots.filter(slot => slot.engine === 'native').flatMap(native => {
    const claude = report.slots.find(slot => slot.engine === 'claude' && slot.taskId === native.taskId && slot.round === native.round);
    const fields = metadataKeys.filter(key => hashJson(native.record[key]) !== hashJson(claude.record[key]));
    return fields.length ? [{ taskId: native.taskId, round: native.round, fields }] : [];
  });
  const withinReportEngineDifferences = { left: engineDifferences(left), right: engineDifferences(right) };
  const warnings = [];
  if (differences.length || withinReportEngineDifferences.left.length || withinReportEngineDifferences.right.length) warnings.push('Application, configuration, model, protocol or budget differences prevent attributing results to the engine alone.');
  if (missingMetadata.length) warnings.push('Unknown model, configuration or budget values remain unknown; matching null values do not establish equal evaluation conditions.');
  return { kind: 'native-engineering-comparison', schemaVersion: 1, suite: left.suite,
    left: { reportDigest: hashJson(left), appRevision: left.batch.manifest.appRevision, summary: left.summary }, right: { reportDigest: hashJson(right), appRevision: right.batch.manifest.appRevision, summary: right.summary }, slots,
    comparability: { sameApplicationRevision: left.batch.manifest.appRevision === right.batch.manifest.appRevision, metadataDifferences: differences, missingMetadata, withinReportEngineDifferences, warnings },
    realQualityStatus: 'pending', graphicalAcceptance: 'pending', platformAcceptance: 'pending', verdict: 'manual-review-required', limitations: LIMITATIONS };
}
