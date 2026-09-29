import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { checkEngineeringReadiness } from '../native-eval-engineering-readiness.mjs';
import { initializeEngineeringBatch, loadEngineeringBatch } from '../native-eval-engineering-reports.mjs';
import { createJson, evaluatorRoot, hashJson, suiteRoot } from '../native-eval-engineering-common.mjs';
import { METRIC_NUMBERS } from '../native-eval-engineering-schema.mjs';

const revision = 'a'.repeat(40);
const metadataFields = ['model', 'protocol', 'configurationReference', 'credentialSourceReference'];
const executionBudgets = ['modelRequests', 'toolCalls', 'inputTokens', 'outputTokens', 'activeDurationMs', 'wallDurationMs'];
const budgetFields = [...executionBudgets, 'costAmount', 'currency', 'approvalPolicy', 'stopConditions'];

async function fixture(t, complete = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-engineering-readiness-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const batch = path.join(root, 'batch');
  const manifest = await initializeEngineeringBatch(batch, revision);
  if (complete) for (const slot of manifest.slots) await editRecord(batch, slot.runId, fillMetadata);
  return { root, batch, manifest };
}

function fillMetadata(record) {
  Object.assign(record, {
    model: 'operator-selected-model', protocol: 'operator-selected-protocol',
    configurationReference: 'operator:configuration', credentialSourceReference: 'operator:credential-source',
  });
  Object.assign(record.budget, {
    modelRequests: 10, toolCalls: 20, inputTokens: 32000, outputTokens: 4000,
    activeDurationMs: 60000, wallDurationMs: 120000, costAmount: 0, currency: 'USD',
    approvalPolicy: 'Require operator confirmation for side effects.',
    stopConditions: ['Stop when any request, time, token or cost limit is reached.'],
  });
}

async function editRecord(batch, runId, change) {
  const file = path.join(batch, 'records', runId + '.json');
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  change(record);
  await fs.writeFile(file, JSON.stringify(record, null, 2) + '\n');
  return record;
}

async function bytesSnapshot(directory) {
  const result = {};
  async function visit(relative = '') {
    for (const entry of (await fs.readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) { result[name] = 'directory'; await visit(name); }
      else result[name] = createHash('sha256').update(await fs.readFile(path.join(directory, name))).digest('hex');
    }
  }
  await visit();
  return result;
}

function pendingBoundaries(result) {
  assert.equal(result.realQualityStatus, 'pending');
  assert.equal(result.graphicalAcceptance, 'pending');
  assert.equal(result.platformAcceptance, 'pending');
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.runtimeStatus, 'not_checked');
  assert.equal(result.batchBudgetStatus, 'external_confirmation_required');
  assert.ok(Array.isArray(result.limitations) && result.limitations.length > 0);
  assert.ok(result.limitations.every(value => typeof value === 'string' && value.trim()));
}

function issueFor(result, runId, field, code) {
  const slot = result.slots.find(value => value.runId === runId);
  assert.equal(slot.status, 'blocked');
  const issue = slot.issues.find(value => value.field === field && (!code || value.code === code));
  assert.ok(issue, `Missing ${code ?? 'issue'} for ${runId}:${field}`);
  assert.deepEqual(Object.keys(issue).sort(), ['code', 'field']);
}

async function addAttempt(batch, runId, { unfinished = false, candidateDirectory } = {}) {
  const loaded = await loadEngineeringBatch(batch);
  const record = loaded.records.get(runId), attemptId = randomUUID();
  const directory = path.join(batch, 'attempts', runId, attemptId);
  await fs.mkdir(directory, { recursive: true });
  const intent = {
    kind: 'native-engineering-attempt', schemaVersion: 1, attemptId, runId,
    suite: loaded.manifest.suite, record, recordDigest: hashJson(record),
    candidateDirectory: candidateDirectory ?? path.join(path.dirname(batch), 'candidate-not-opened'),
    startedAt: '2026-09-29T02:00:00.000Z', timeoutMs: 1000,
  };
  await createJson(path.join(directory, 'intent.json'), intent);
  if (!unfinished) await createJson(path.join(directory, 'result.json'), {
    kind: 'native-engineering-attempt-result', schemaVersion: 1, attemptId, runId,
    intentDigest: hashJson(intent), finishedAt: '2026-09-29T02:00:01.000Z',
    verification: {
      status: 'cancelled', exitCode: null, signal: null, durationMs: 0,
      stdout: 'RAW-ATTEMPT-LOG-MUST-NOT-LEAK', stderr: '', stdoutTruncated: false, stderrTruncated: false,
      output: null, cleanupConfirmed: true,
    },
    candidate: { head: null, beforeDigest: null, afterDigest: null, changedDuringVerification: null },
    realQualityStatus: 'pending',
  });
}

function cli(...args) {
  const result = spawnSync(process.execPath, [path.join(evaluatorRoot, 'scripts/native-eval.mjs'), ...args], {
    cwd: evaluatorRoot, encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

test('readiness diagnoses every missing field in all twelve fixed slots without changing the batch or suite', async t => {
  const { batch, manifest } = await fixture(t);
  const before = await bytesSnapshot(batch), suiteBefore = await bytesSnapshot(suiteRoot);
  const result = await checkEngineeringReadiness(batch);
  assert.equal(result.kind, 'native-engineering-readiness');
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.appRevision, revision);
  assert.deepEqual(result.suite, manifest.suite);
  assert.equal(result.manifestDigest, hashJson(manifest));
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.summary, { slotCount: 12, completeCount: 0, blockedCount: 12 });
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.slots.map(slot => slot.runId), manifest.slots.map(slot => slot.runId));
  for (const [index, slot] of result.slots.entries()) {
    const expected = manifest.slots[index];
    assert.deepEqual({ runId: slot.runId, engine: slot.engine, taskId: slot.taskId, round: slot.round }, {
      runId: expected.runId, engine: expected.engine, taskId: expected.taskId, round: expected.round,
    });
    const record = JSON.parse(await fs.readFile(path.join(batch, expected.recordFile), 'utf8'));
    assert.equal(slot.recordDigest, hashJson(record));
    assert.equal(slot.status, 'blocked');
    assert.deepEqual(slot.issues.map(issue => issue.field).sort(), [...metadataFields, ...budgetFields.map(field => `budget.${field}`)].sort());
    for (const issue of slot.issues) {
      assert.deepEqual(Object.keys(issue).sort(), ['code', 'field']);
      assert.equal(issue.code, issue.field.startsWith('budget.') ? 'missing_budget' : 'missing_metadata');
    }
    assert.equal('record' in slot, false);
  }
  pendingBoundaries(result);
  assert.deepEqual(await bytesSnapshot(batch), before);
  assert.deepEqual(await bytesSnapshot(suiteRoot), suiteBefore);
});

test('complete metadata and a zero cost budget stay separate from unknown actual usage and authorization', async t => {
  const { batch, manifest } = await fixture(t, true);
  const before = await bytesSnapshot(batch), result = await checkEngineeringReadiness(batch);
  assert.equal(result.status, 'metadata_complete');
  assert.deepEqual(result.summary, { slotCount: 12, completeCount: 12, blockedCount: 0 });
  assert.deepEqual(result.blockers, []);
  assert.ok(result.slots.every(slot => slot.status === 'metadata_complete' && slot.issues.length === 0));
  pendingBoundaries(result);
  for (const slot of manifest.slots) {
    const record = JSON.parse(await fs.readFile(path.join(batch, slot.recordFile), 'utf8'));
    assert.equal(record.budget.costAmount, 0);
    assert.ok(Object.values(record.metrics).every(value => value === null));
    assert.equal(record.result.status, 'pending');
  }
  assert.deepEqual(await bytesSnapshot(batch), before);
  await editRecord(batch, manifest.slots[0].runId, record => { record.model = null; });
  const blocked = await checkEngineeringReadiness(batch);
  assert.deepEqual(blocked.summary, { slotCount: 12, completeCount: 11, blockedCount: 1 });
  assert.deepEqual(blocked.limitations, result.limitations);
});

test('zero execution budgets, contradictory durations and empty stop conditions block readiness', async t => {
  const { batch, manifest } = await fixture(t, true);
  for (const [index, field] of executionBudgets.entries()) await editRecord(batch, manifest.slots[index].runId, record => { record.budget[field] = 0; });
  await editRecord(batch, manifest.slots[6].runId, record => { record.budget.activeDurationMs = record.budget.wallDurationMs + 1; });
  for (const [index, stopConditions] of [[], [''], ['Stop at limit.', ' \t ']].entries()) {
    await editRecord(batch, manifest.slots[index + 7].runId, record => { record.budget.stopConditions = stopConditions; });
  }
  await editRecord(batch, manifest.slots[10].runId, record => { record.budget.approvalPolicy = null; });
  const result = await checkEngineeringReadiness(batch);
  for (const [index, field] of executionBudgets.entries()) issueFor(result, manifest.slots[index].runId, `budget.${field}`, 'nonpositive_execution_budget');
  issueFor(result, manifest.slots[6].runId, 'budget.activeDurationMs', 'inconsistent_duration_budget');
  for (let index = 7; index <= 9; index++) issueFor(result, manifest.slots[index].runId, 'budget.stopConditions', 'missing_budget');
  issueFor(result, manifest.slots[10].runId, 'budget.approvalPolicy', 'missing_budget');
  assert.deepEqual(result.summary, { slotCount: 12, completeCount: 1, blockedCount: 11 });
});

test('missing nullable metadata and budget fields remain valid records but are never complete', async t => {
  const { batch, manifest } = await fixture(t, true);
  for (const [index, field] of [...metadataFields, ...executionBudgets].entries()) {
    await editRecord(batch, manifest.slots[index].runId, record => {
      if (metadataFields.includes(field)) record[field] = null;
      else record.budget[field] = null;
    });
  }
  await editRecord(batch, manifest.slots[10].runId, record => { record.budget.costAmount = null; });
  await editRecord(batch, manifest.slots[11].runId, record => { record.budget.costAmount = null; record.budget.currency = null; });
  await loadEngineeringBatch(batch);
  const result = await checkEngineeringReadiness(batch);
  assert.deepEqual(result.summary, { slotCount: 12, completeCount: 0, blockedCount: 12 });
  for (const [index, field] of [...metadataFields, ...executionBudgets].entries()) issueFor(result, manifest.slots[index].runId, metadataFields.includes(field) ? field : `budget.${field}`);
  issueFor(result, manifest.slots[10].runId, 'budget.costAmount', 'missing_budget');
  issueFor(result, manifest.slots[11].runId, 'budget.currency', 'missing_budget');
});

test('every nonnull metric including zero and false marks an already started record', async t => {
  const { batch, manifest } = await fixture(t, true);
  const changes = [
    ...METRIC_NUMBERS.map(field => [`metrics.${field}`, record => { record.metrics[field] = 0; }]),
    ...['startedAtBeijing', 'finishedAtBeijing'].map(field => [`metrics.${field}`, record => { record.metrics[field] = '2026-09-29T10:00:00+08:00'; }]),
    ['metrics.usageComplete', record => { record.metrics.usageComplete = false; }],
    ['metrics.costAmount', record => { record.metrics.costAmount = 0; record.metrics.currency = 'USD'; }],
    ['metrics.currency', record => { record.metrics.currency = 'USD'; }],
  ];
  for (let offset = 0; offset < changes.length; offset += 12) {
    for (const slot of manifest.slots) await editRecord(batch, slot.runId, record => { for (const field of Object.keys(record.metrics)) record.metrics[field] = null; });
    const group = changes.slice(offset, offset + 12);
    for (const [index, [, edit]] of group.entries()) await editRecord(batch, manifest.slots[index].runId, edit);
    const result = await checkEngineeringReadiness(batch);
    assert.equal(result.summary.blockedCount, group.length);
    for (const [index, [field]] of group.entries()) issueFor(result, manifest.slots[index].runId, field, 'existing_run_evidence');
    pendingBoundaries(result);
  }
});

test('evidence references and declared outcomes prevent readiness even without verifier attempts', async t => {
  const { batch, manifest } = await fixture(t, true);
  const refs = ['sessionReference', 'transcriptReference', 'candidateCommit', 'diffReference', 'independentVerifierReference', 'originalTestsReference', 'newTestsReference', 'humanReviewReference'];
  const changes = [
    ...refs.map(field => [`evidence.${field}`, record => { record.evidence[field] = field === 'candidateCommit' ? revision : 'operator:already-created-evidence'; }]),
    ['evidence.kind', record => { record.evidence.kind = 'local-fixture'; }],
    ['result.status', record => { record.result.status = 'completed'; }],
    ['result.functionalStatus', record => { record.result.functionalStatus = 'pass'; }],
    ['result.failureClass', record => { record.result.failureClass = 'interrupted'; }],
  ];
  for (const [index, [, edit]] of changes.entries()) await editRecord(batch, manifest.slots[index].runId, edit);
  const result = await checkEngineeringReadiness(batch);
  assert.deepEqual(result.summary, { slotCount: 12, completeCount: 0, blockedCount: 12 });
  for (const [index, [field]] of changes.entries()) issueFor(result, manifest.slots[index].runId, field, 'existing_run_evidence');
  await editRecord(batch, manifest.slots[0].runId, record => { record.result.failureReason = 'A prior attempt stopped.'; });
  issueFor(await checkEngineeringReadiness(batch), manifest.slots[0].runId, 'result.failureReason', 'existing_run_evidence');
});

test('finished and unknown attempts stay blocked and a verification lock blocks the whole batch', async t => {
  const { root, batch, manifest } = await fixture(t, true);
  await addAttempt(batch, manifest.slots[0].runId);
  await addAttempt(batch, manifest.slots[1].runId, { unfinished: true });
  const before = await bytesSnapshot(batch), result = await checkEngineeringReadiness(batch);
  issueFor(result, manifest.slots[0].runId, 'attempts', 'existing_verification_attempt');
  issueFor(result, manifest.slots[1].runId, 'attempts', 'existing_verification_attempt');
  assert.deepEqual(result.summary, { slotCount: 12, completeCount: 10, blockedCount: 2 });
  assert.equal(JSON.stringify(result).includes('RAW-ATTEMPT-LOG-MUST-NOT-LEAK'), false);
  assert.deepEqual(await bytesSnapshot(batch), before);
  const lockFile = path.join(batch, 'verification-lock.json');
  await createJson(lockFile, {
    kind: 'native-engineering-verification-lock', schemaVersion: 1, owner: randomUUID(),
    runId: manifest.slots[2].runId, candidateDirectory: path.join(root, 'LOCK-PATH-MUST-NOT-LEAK'),
    createdAt: '2026-09-29T02:00:00.000Z',
  });
  const lockedBytes = await bytesSnapshot(batch), locked = await checkEngineeringReadiness(batch);
  assert.equal(locked.status, 'blocked');
  assert.deepEqual(locked.blockers, [{ code: 'verification_locked' }]);
  assert.equal(JSON.stringify(locked).includes('LOCK-PATH-MUST-NOT-LEAK'), false);
  assert.deepEqual(await bytesSnapshot(batch), lockedBytes);
});

test('a lock alone prevents metadata-complete batch status without claiming its twelve slots failed', async t => {
  const { root, batch, manifest } = await fixture(t, true);
  await createJson(path.join(batch, 'verification-lock.json'), {
    kind: 'native-engineering-verification-lock', schemaVersion: 1, owner: randomUUID(),
    runId: manifest.slots[0].runId, candidateDirectory: path.join(root, 'unopened-candidate'),
    createdAt: '2026-09-29T02:00:00.000Z',
  });
  const result = await checkEngineeringReadiness(batch);
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.blockers, [{ code: 'verification_locked' }]);
  assert.deepEqual(result.summary, { slotCount: 12, completeCount: 12, blockedCount: 0 });
  pendingBoundaries(result);
});

test('readiness does not read opaque references, open candidate directories or fetch credential sources', async t => {
  const { root, batch, manifest } = await fixture(t, true);
  const sentinel = path.join(root, 'CREDENTIAL-CONFIG-CANDIDATE-SENTINEL');
  for (const slot of manifest.slots) await editRecord(batch, slot.runId, record => {
    record.configurationReference = sentinel + '/configuration.json';
    record.credentialSourceReference = sentinel + '/raw-credential-sk-SENTINEL';
    record.limitations = ['OPERATOR-LIMITATION-MUST-NOT-LEAK'];
  });
  await addAttempt(batch, manifest.slots[0].runId, { candidateDirectory: sentinel + '/candidate' });
  await editRecord(batch, manifest.slots[1].runId, record => { record.evidence.sessionReference = sentinel + '/session.json'; });
  const before = await bytesSnapshot(batch), accessed = [], originals = new Map();
  for (const method of ['readFile', 'open', 'stat', 'lstat', 'readdir', 'realpath', 'access']) {
    originals.set(method, fs[method]);
    fs[method] = async function (file, ...args) {
      if (String(file).includes('CREDENTIAL-CONFIG-CANDIDATE-SENTINEL')) { accessed.push(method); throw new Error('Opaque reference accessed.'); }
      return originals.get(method).call(this, file, ...args);
    };
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { accessed.push('fetch'); throw new Error('Network access attempted.'); };
  let result;
  try { result = await checkEngineeringReadiness(batch); }
  finally { for (const [method, original] of originals) fs[method] = original; globalThis.fetch = originalFetch; }
  assert.deepEqual(accessed, []);
  assert.equal(result.summary.completeCount, 10);
  const output = JSON.stringify(result);
  for (const secret of [sentinel, 'raw-credential-sk-SENTINEL', 'OPERATOR-LIMITATION-MUST-NOT-LEAK', 'RAW-ATTEMPT-LOG-MUST-NOT-LEAK']) assert.equal(output.includes(secret), false);
  assert.deepEqual(await bytesSnapshot(batch), before);
});

test('malformed fixed matrices and records fail closed while the nullable legacy schema is unchanged', async t => {
  const { batch, manifest } = await fixture(t, true);
  const manifestFile = path.join(batch, 'manifest.json'), original = await fs.readFile(manifestFile);
  for (const edit of [value => value.slots.pop(), value => { value.slots[1] = value.slots[0]; }, value => { value.slots.reverse(); }, value => { value.suite.digest = '0'.repeat(64); }]) {
    const changed = structuredClone(manifest); edit(changed); await fs.writeFile(manifestFile, JSON.stringify(changed));
    await assert.rejects(checkEngineeringReadiness(batch));
  }
  await fs.writeFile(manifestFile, original);
  const file = path.join(batch, manifest.slots[0].recordFile), recordBytes = await fs.readFile(file);
  for (const edit of [record => { record.model = ' \t '; }, record => { record.budget.approvalPolicy = ' '; }, record => { record.budget.modelRequests = -1; }, record => { record.budget.currency = null; }, record => { record.result.realQualityStatus = 'pass'; }]) {
    await fs.writeFile(file, recordBytes); await editRecord(batch, manifest.slots[0].runId, edit);
    await assert.rejects(checkEngineeringReadiness(batch));
  }
  await fs.writeFile(file, recordBytes);
  await fs.rm(file); await assert.rejects(checkEngineeringReadiness(batch));
  await fs.writeFile(file, recordBytes);
  await fs.writeFile(path.join(batch, 'records', 'unknown.json'), '{}');
  await assert.rejects(checkEngineeringReadiness(batch));
});

test('CLI exits 0 only for complete metadata, 1 for blockers and 2 for bad arguments or corrupt data without leaking it', async t => {
  const { root, batch, manifest } = await fixture(t);
  const blocked = cli('engineering-readiness', batch);
  assert.equal(blocked.status, 1); assert.equal(blocked.stderr, '');
  assert.equal(JSON.parse(blocked.stdout).status, 'blocked');
  for (const slot of manifest.slots) await editRecord(batch, slot.runId, fillMetadata);
  const before = await bytesSnapshot(batch), complete = cli('engineering-readiness', batch);
  assert.equal(complete.status, 0); assert.equal(complete.stderr, '');
  pendingBoundaries(JSON.parse(complete.stdout));
  assert.equal(JSON.parse(complete.stdout).status, 'metadata_complete');
  assert.deepEqual(await bytesSnapshot(batch), before);
  for (const args of [[], [batch, 'UNEXPECTED-ARGUMENT-DO-NOT-ECHO'], [path.join(root, 'MISSING-DIRECTORY-DO-NOT-ECHO')]]) {
    const result = cli('engineering-readiness', ...args);
    assert.equal(result.status, 2); assert.equal(result.stdout, '');
    assert.ok(result.stderr.trim());
    assert.equal(result.stderr.includes('DO-NOT-ECHO'), false);
  }
  await fs.writeFile(path.join(batch, manifest.slots[0].recordFile), '{"credentialSourceReference":"BAD-JSON-RAW-CREDENTIAL-DO-NOT-ECHO",oops');
  const malformed = cli('engineering-readiness', batch);
  assert.equal(malformed.status, 2); assert.equal(malformed.stdout, '');
  assert.equal(malformed.stderr.includes('BAD-JSON-RAW-CREDENTIAL-DO-NOT-ECHO'), false);
  assert.equal(malformed.stderr.includes(batch), false);
});
