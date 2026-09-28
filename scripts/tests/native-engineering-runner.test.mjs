import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseEngineeringVerificationReceipt, verifyEngineeringRun } from '../native-eval-engineering-runner.mjs';
import { initializeEngineeringBatch, loadEngineeringBatch, generateEngineeringReport } from '../native-eval-engineering-reports.mjs';
import { createJson } from '../native-eval-engineering-common.mjs';

const taskId = '01-snapshot-refresh';
const runId = `native-${taskId}-r1`;
const revision = '82aa287' + '0'.repeat(33);
const cancelled = () => { const controller = new AbortController(); controller.abort(); return controller.signal; };

async function fixture(fn) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cc-desk-engineering-runner-')));
  const batch = path.join(root, 'batch'), candidate = path.join(root, 'candidate');
  try {
    await fs.mkdir(candidate); await initializeEngineeringBatch(batch, revision);
    await fn({ root, batch, candidate });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

function receipt() {
  const integrity = { protectedFiles: 169, changed: ['TASK.md'] };
  return { schemaVersion: 1, kind: 'native-engineering-verification', taskId, status: 'pass', functionalStatus: 'pass',
    verification: { task: taskId, functionalStatus: 'pass', realQualityStatus: 'pending', graphicalAcceptance: 'pending', independentHumanReview: 'required', integrity,
      testResults: ['compile contracts', 'compile engine-claude', 'compile agent-core', 'compile agent-node', 'selected original and new regression tests'].map(label => ({ label, executable: 'node', argv: ['test.mjs'], exitCode: 0, signal: null, durationMs: 1, output: '', truncated: false })) },
    postIntegrity: integrity, error: null };
}

test('engineering verification needs a complete receipt, exact task and matching exit', () => {
  const value = receipt();
  assert.deepEqual(parseEngineeringVerificationReceipt(JSON.stringify(value), 0, taskId), value);
  for (const text of ['', '{}', '{"functionalStatus":"pass"}', JSON.stringify(value) + '\n{}']) assert.throws(() => parseEngineeringVerificationReceipt(text, 0, taskId));
  assert.throws(() => parseEngineeringVerificationReceipt(JSON.stringify(value), 1, taskId));
  assert.throws(() => parseEngineeringVerificationReceipt(JSON.stringify(value), 0, '02-session-info'));
  value.verification.testResults.pop();
  assert.throws(() => parseEngineeringVerificationReceipt(JSON.stringify(value), 0, taskId));
  const failure = { schemaVersion: 1, kind: 'native-engineering-verification', taskId, status: 'fail', functionalStatus: 'fail', verification: null, postIntegrity: null, error: 'test failed' };
  assert.equal(parseEngineeringVerificationReceipt(JSON.stringify(failure), 1, taskId).status, 'fail');
  assert.throws(() => parseEngineeringVerificationReceipt(JSON.stringify(failure), 0, taskId));
});

test('engineering verification validates timeout and signal before accessing candidates', async () => {
  for (const timeoutMs of [0, -1, 300001, Infinity, 1.5, '1000']) await assert.rejects(verifyEngineeringRun({ timeoutMs }), /timeout/i);
  await assert.rejects(verifyEngineeringRun({ signal: {} }), /signal/i);
});

test('pre-cancelled attempts are retained and a candidate cannot be reused by another slot', async () => fixture(async ({ batch, candidate }) => {
  const attempt = await verifyEngineeringRun({ batchDirectory: batch, runId, candidateDirectory: candidate, signal: cancelled() });
  assert.equal(attempt.result.verification.status, 'cancelled');
  assert.equal(attempt.result.verification.cleanupConfirmed, true);
  await assert.rejects(fs.stat(path.join(batch, 'verification-lock.json')), { code: 'ENOENT' });
  await assert.rejects(verifyEngineeringRun({ batchDirectory: batch, runId: `claude-${taskId}-r1`, candidateDirectory: candidate, signal: cancelled() }), /independent candidate/);
  assert.equal((await loadEngineeringBatch(batch)).attemptCount, 1);
  await assert.rejects(fs.stat(path.join(batch, 'verification-lock.json')), { code: 'ENOENT' });
}));

test('an existing verification lock prevents a second run and remains reportable', async () => fixture(async ({ root, batch, candidate }) => {
  const lockFile = path.join(batch, 'verification-lock.json');
  await createJson(lockFile, { kind: 'native-engineering-verification-lock', schemaVersion: 1, owner: randomUUID(), runId, candidateDirectory: candidate, createdAt: new Date().toISOString() });
  await assert.rejects(verifyEngineeringRun({ batchDirectory: batch, runId, candidateDirectory: candidate, signal: cancelled() }), { code: 'EEXIST' });
  assert.equal((await loadEngineeringBatch(batch)).attemptCount, 0);
  const report = await generateEngineeringReport(batch, path.join(root, 'locked-report.json'));
  assert.equal(report.summary.verificationLocked, true);
  assert.ok(await fs.stat(lockFile));
}));

test('a lost result keeps its intent and lock, and cannot be retried automatically', async () => fixture(async ({ root, batch, candidate }) => {
  const originalLink = fs.link;
  fs.link = async (source, destination) => {
    if (path.basename(destination) === 'result.json') throw Object.assign(new Error('injected publication failure'), { code: 'EIO' });
    return originalLink(source, destination);
  };
  try { await assert.rejects(verifyEngineeringRun({ batchDirectory: batch, runId, candidateDirectory: candidate, signal: cancelled() }), /injected publication/); }
  finally { fs.link = originalLink; }
  assert.ok(await fs.stat(path.join(batch, 'verification-lock.json')));
  const report = await generateEngineeringReport(batch, path.join(root, 'interrupted-report.json'));
  assert.equal(report.summary.verificationStatuses.unknown, 1);
  await assert.rejects(verifyEngineeringRun({ batchDirectory: batch, runId, candidateDirectory: candidate, signal: cancelled() }), { code: 'EEXIST' });
  // Simulate an operator removing the lock after inspection: the missing receipt still forbids reusing this candidate.
  await fs.unlink(path.join(batch, 'verification-lock.json'));
  await assert.rejects(verifyEngineeringRun({ batchDirectory: batch, runId, candidateDirectory: candidate, signal: cancelled() }), /unfinished verification/);
  assert.equal((await loadEngineeringBatch(batch)).attemptCount, 1);
}));
