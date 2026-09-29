import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { initializeEngineeringBatch, loadEngineeringBatch, generateEngineeringReport, compareEngineeringReports } from '../native-eval-engineering-reports.mjs';
import { createJson, hashJson, evaluatorRoot } from '../native-eval-engineering-common.mjs';
import { assertAttemptResult, assertVerifierOutput, assertEngineeringRecord, assertAttemptIntent, MAX_RECORD_BYTES, MAX_REPORT_BYTES } from '../native-eval-engineering-schema.mjs';

const revision = 'a'.repeat(40);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-engineering-report-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const batch = path.join(root, 'batch'); const manifest = await initializeEngineeringBatch(batch, revision);
  return { root, batch, manifest };
}
async function editRecord(batch, runId, edit) {
  const file = path.join(batch, 'records', runId + '.json');
  const value = JSON.parse(await fs.readFile(file, 'utf8')); edit(value);
  await fs.writeFile(file, JSON.stringify(value)); return value;
}
async function attempt(batch, runId, { unfinished = false, log = '', status = 'fail' } = {}) {
  const loaded = await loadEngineeringBatch(batch), record = loaded.records.get(runId), attemptId = randomUUID();
  const directory = path.join(batch, 'attempts', runId, attemptId); await fs.mkdir(directory, { recursive: true });
  const intent = { kind: 'native-engineering-attempt', schemaVersion: 1, attemptId, runId, suite: loaded.manifest.suite, record, recordDigest: hashJson(record), candidateDirectory: path.join(path.dirname(batch), 'candidate'), startedAt: new Date().toISOString(), timeoutMs: 1000 };
  await createJson(path.join(directory, 'intent.json'), intent);
  const result = { kind: 'native-engineering-attempt-result', schemaVersion: 1, attemptId, runId, intentDigest: hashJson(intent), finishedAt: new Date().toISOString(),
    verification: { status, exitCode: 1, signal: null, durationMs: 10, stdout: log, stderr: '', stdoutTruncated: false, stderrTruncated: false, cleanupConfirmed: true,
      output: { kind: 'native-engineering-verification', schemaVersion: 1, taskId: record.taskId, status: 'fail', functionalStatus: 'fail', verification: null, postIntegrity: null, error: 'expected fixture failure' } },
    candidate: { head: revision, beforeDigest: 'b'.repeat(64), afterDigest: 'b'.repeat(64), changedDuringVerification: false }, realQualityStatus: 'pending' };
  if (!unfinished) await createJson(path.join(directory, 'result.json'), result);
  return { directory, intent, result };
}

test('initialization fixes all twelve slots and preserves unknown metrics without overwriting', async t => {
  const { root, batch, manifest } = await fixture(t);
  assert.equal(manifest.slots.length, 12);
  assert.equal(new Set(manifest.slots.map(slot => slot.runId)).size, 12);
  const loaded = await loadEngineeringBatch(batch);
  for (const record of loaded.records.values()) {
    assert.equal(record.appRevision, revision); assert.equal(record.metrics.inputTokens, null); assert.equal(record.result.status, 'pending');
  }
  await assert.rejects(initializeEngineeringBatch(batch, revision), /nonempty/);
  await assert.rejects(initializeEngineeringBatch(path.join(root, 'bad'), 'abcdef'), /full lowercase/);
  await assert.rejects(initializeEngineeringBatch(path.join(evaluatorRoot, 'forbidden-evaluation-batch'), revision), /separate/);
  const reportFile = path.join(root, 'report.json'), report = await generateEngineeringReport(batch, reportFile);
  assert.equal(report.summary.slotCount, 12); assert.equal(report.summary.unattemptedSlots, 12); assert.equal(report.summary.declaredStatuses.pending, 12);
  assert.equal(report.summary.metrics.inputTokens.sum, null); assert.equal(report.summary.metrics.inputTokens.knownSum, null);
  assert.equal(report.realQualityStatus, 'pending'); assert.equal(report.verdict, 'manual-review-required');
  await assert.rejects(generateEngineeringReport(batch, reportFile), /EEXIST/);
});

test('missing, duplicate, unknown, misidentified and forged acceptance records fail closed', async t => {
  const { root, batch, manifest } = await fixture(t), slot = manifest.slots[0];
  const original = await fs.readFile(path.join(batch, slot.recordFile));
  for (const edit of [record => { record.result.realQualityStatus = 'pass'; }, record => { record.round = 3; }, record => { record.extra = true; }, record => { record.metrics.modelRequests = -1; }, record => { record.metrics.inputTokens = 0.1; }, record => { record.budget.costAmount = 1; }, record => { record.evidence.kind = 'manual-real'; }, record => { record.metrics.startedAtBeijing = '2026-09-28T10:00:00Z'; }]) {
    await editRecord(batch, slot.runId, edit); await assert.rejects(loadEngineeringBatch(batch), /Invalid engineering/); await fs.writeFile(path.join(batch, slot.recordFile), original);
  }
  await fs.writeFile(path.join(batch, 'records', 'unknown.json'), '{}'); await assert.rejects(loadEngineeringBatch(batch), /every fixed batch slot/); await fs.rm(path.join(batch, 'records', 'unknown.json'));
  await fs.rm(path.join(batch, slot.recordFile)); await assert.rejects(loadEngineeringBatch(batch), /every fixed batch slot/); await fs.writeFile(path.join(batch, slot.recordFile), original);
  const modified = structuredClone(manifest); modified.slots[1] = modified.slots[0]; await fs.writeFile(path.join(batch, 'manifest.json'), JSON.stringify(modified));
  await assert.rejects(generateEngineeringReport(batch, path.join(root, 'report.json')), /slot identity/);
});

test('every failed and unfinished attempt survives reports with compact external log references', async t => {
  const { root, batch, manifest } = await fixture(t), runId = manifest.slots[0].runId;
  const failed = await attempt(batch, runId, { log: 'sensitive operator log '.repeat(6000) });
  await editRecord(batch, runId, record => { record.result.status = 'completed'; record.result.functionalStatus = 'pass'; record.metrics.inputTokens = 0; });
  const unknown = await attempt(batch, runId, { unfinished: true });
  const report = await generateEngineeringReport(batch, path.join(root, 'report.json'));
  assert.equal(report.summary.attemptCount, 2); assert.equal(report.summary.verificationStatuses.fail, 1); assert.equal(report.summary.verificationStatuses.unknown, 1);
  assert.equal(report.summary.declaredStatuses.completed, 1); assert.equal(report.summary.unattemptedSlots, 11);
  const failedReceipt = report.slots[0].attempts.find(entry => entry.attemptId === failed.intent.attemptId);
  assert.equal(failedReceipt.recordChanged, true); assert.equal(failedReceipt.intent.record.metrics.inputTokens, null);
  assert.equal(failedReceipt.resultDigest, hashJson(failed.result)); assert.ok(failedReceipt.resultReference.endsWith('/result.json'));
  assert.equal('stdout' in failedReceipt.result.verification, false); assert.ok(failedReceipt.result.verification.stdoutBytes > 100000);
  assert.equal(report.slots[0].attempts.find(entry => entry.attemptId === unknown.intent.attemptId).result, null);
  assert.equal(report.summary.metrics.inputTokens.knownSum, 0); assert.equal(report.summary.metrics.inputTokens.sum, null);
  assert.equal(report.summary.metrics.inputTokens.knownCount, 1); assert.equal(report.realQualityStatus, 'pending');
  const comparison = await compareEngineeringReports(path.join(root, 'report.json'), path.join(root, 'report.json'));
  assert.equal(comparison.left.summary.verificationStatuses.fail, 1);
  await fs.mkdir(path.join(root, 'candidate'));
  await assert.rejects(generateEngineeringReport(batch, path.join(root, 'candidate', 'report.json')), /separate/);
  await assert.rejects(generateEngineeringReport(batch, path.join(batch, 'records', 'report.json')), /separate/);
});

test('complete totals require complete usage and compatible currency; zero remains known', async t => {
  const { root, batch, manifest } = await fixture(t);
  for (const slot of manifest.slots) await editRecord(batch, slot.runId, record => { record.metrics.inputTokens = 0; record.metrics.costAmount = 1; record.metrics.currency = 'USD'; record.metrics.usageComplete = true; });
  const complete = await generateEngineeringReport(batch, path.join(root, 'complete.json'));
  assert.equal(complete.summary.metrics.inputTokens.sum, 0); assert.equal(complete.summary.metrics.costAmount.sum, 12);
  await editRecord(batch, manifest.slots[0].runId, record => { record.metrics.currency = 'CNY'; record.metrics.usageComplete = false; });
  const partial = await generateEngineeringReport(batch, path.join(root, 'partial.json'));
  assert.equal(partial.summary.metrics.inputTokens.sum, null); assert.equal(partial.summary.metrics.costAmount.sum, null); assert.equal(partial.summary.metrics.costAmount.knownSum, null);
  assert.deepEqual(partial.summary.metrics.costAmount.currencies, ['CNY', 'USD']);
});

test('comparison rejects cross-suite data and recalculates summary instead of trusting assertions', async t => {
  const { root, batch } = await fixture(t), left = path.join(root, 'left.json'), right = path.join(root, 'right.json');
  const report = await generateEngineeringReport(batch, left);
  for (const edit of [value => { value.suite.digest = '0'.repeat(64); }, value => { value.summary.verificationStatuses.pass = 12; }, value => { value.realQualityStatus = 'pass'; }, value => { value.slots.pop(); }, value => { value.kind = 'toy-report'; }]) {
    const changed = structuredClone(report); edit(changed); await fs.writeFile(right, JSON.stringify(changed)); await assert.rejects(compareEngineeringReports(left, right));
  }
  await editRecord(batch, report.slots[0].runId, record => { record.model = 'different-model'; record.budget.toolCalls = 10; });
  const updated = path.join(root, 'updated.json'); await generateEngineeringReport(batch, updated);
  const compared = await compareEngineeringReports(left, updated);
  assert.deepEqual(compared.slots[0].metadataDifferences, ['model', 'budget']); assert.equal(compared.verdict, 'manual-review-required'); assert.equal(compared.comparability.warnings.length, 2);
  assert.equal(compared.comparability.missingMetadata.length, 12); assert.ok(compared.comparability.withinReportEngineDifferences.right.length > 0);
});

test('missing receipts, unknown attempt directories and retained locks are visible or rejected', async t => {
  const { root, batch, manifest } = await fixture(t), runId = manifest.slots[0].runId;
  const lock = { kind: 'native-engineering-verification-lock', schemaVersion: 1, owner: randomUUID(), runId, candidateDirectory: path.join(root, 'candidate'), createdAt: new Date().toISOString() };
  await createJson(path.join(batch, 'verification-lock.json'), lock);
  const report = await generateEngineeringReport(batch, path.join(root, 'locked.json'));
  assert.equal(report.summary.verificationLocked, true); assert.deepEqual(report.batch.verificationLock, lock); assert.ok(await fs.stat(path.join(batch, 'verification-lock.json')));
  await fs.mkdir(path.join(batch, 'attempts', 'unknown-run')); await assert.rejects(loadEngineeringBatch(batch), /Unknown or nonordinary/); await fs.rm(path.join(batch, 'attempts', 'unknown-run'), { recursive: true });
  const directory = path.join(batch, 'attempts', runId, randomUUID()); await fs.mkdir(directory, { recursive: true }); await assert.rejects(loadEngineeringBatch(batch), /ordinary intent/);
});

test('a claimed pass needs complete independent check and process closure evidence', async t => {
  const { batch, manifest } = await fixture(t), { result } = await attempt(batch, manifest.slots[0].runId);
  result.verification.status = 'pass'; result.verification.exitCode = 0; result.verification.output = { functionalStatus: 'pass' };
  assert.throws(() => assertAttemptResult(result), /verifier output fields/);
  assert.throws(() => assertVerifierOutput({ schemaVersion: 1, kind: 'native-engineering-verification', taskId: '01-snapshot-refresh', status: 'pass', functionalStatus: 'pass', verification: null, postIntegrity: null, error: null }, 0, '01-snapshot-refresh'), /success closure/);
});

test('all 120 attempts near the record limit fit a complete report with bounded metadata', async t => {
  const { root, batch, manifest } = await fixture(t), slot = manifest.slots[0];
  const record = await editRecord(batch, slot.runId, value => {
    value.limitations = Array.from({ length: 5 }, () => 'x'.repeat(2000));
    const remaining = MAX_RECORD_BYTES - Buffer.byteLength(JSON.stringify(value, null, 2)) - 100;
    value.result.failureReason = 'x'.repeat(remaining);
  });
  assert.ok(Buffer.byteLength(JSON.stringify(record, null, 2)) > 15 * 1024);
  assertEngineeringRecord(record, slot, manifest);
  const tooLarge = structuredClone(record); tooLarge.limitations.push('x'.repeat(2000));
  assert.throws(() => assertEngineeringRecord(tooLarge, slot, manifest), /record byte budget/);
  for (let index = 0; index < 120; index++) {
    const attemptId = randomUUID(), directory = path.join(batch, 'attempts', slot.runId, attemptId); await fs.mkdir(directory, { recursive: true });
    const intent = { kind: 'native-engineering-attempt', schemaVersion: 1, attemptId, runId: slot.runId, suite: manifest.suite, record, recordDigest: hashJson(record), candidateDirectory: '/candidate-' + 'x'.repeat(6900), startedAt: new Date().toISOString(), timeoutMs: 1000 };
    assertAttemptIntent(intent); await createJson(path.join(directory, 'intent.json'), intent);
    const result = { kind: 'native-engineering-attempt-result', schemaVersion: 1, attemptId, runId: slot.runId, intentDigest: hashJson(intent), finishedAt: new Date().toISOString(),
      verification: { status: 'fail', exitCode: 1, signal: null, durationMs: 1, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, cleanupConfirmed: true,
        output: { kind: 'native-engineering-verification', schemaVersion: 1, taskId: slot.taskId, status: 'fail', functionalStatus: 'fail', verification: null, postIntegrity: null, error: 'e'.repeat(16000) } },
      candidate: { head: revision, beforeDigest: 'b'.repeat(64), afterDigest: 'b'.repeat(64), changedDuringVerification: false }, realQualityStatus: 'pending' };
    assertAttemptResult(result); await createJson(path.join(directory, 'result.json'), result);
  }
  const file = path.join(root, 'capacity.json'), report = await generateEngineeringReport(batch, file);
  assert.equal(report.summary.attemptCount, 120); assert.equal(report.summary.verificationStatuses.fail, 120);
  assert.ok((await fs.stat(file)).size < MAX_REPORT_BYTES);
  const extra = path.join(batch, 'attempts', slot.runId, randomUUID()); await fs.mkdir(extra);
  await assert.rejects(loadEngineeringBatch(batch), /excessive|ordinary intent/);
});
