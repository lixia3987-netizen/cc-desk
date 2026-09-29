import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { initializeEngineeringBatch, loadEngineeringBatch, generateEngineeringReport, compareEngineeringReports } from '../native-eval-engineering-reports.mjs';
import { checkEngineeringReadiness } from '../native-eval-engineering-readiness.mjs';
import { assertEngineeringRecord, BUDGET_NUMBERS, METRIC_NUMBERS } from '../native-eval-engineering-schema.mjs';
import { createJson, evaluatorRoot, hashJson } from '../native-eval-engineering-common.mjs';

const revision = 'a'.repeat(40);
const limitFields = [...BUDGET_NUMBERS, 'costAmount'];

async function fixture(t, unlimitedBudget = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-engineering-unlimited-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const batch = path.join(root, 'batch');
  const manifest = await initializeEngineeringBatch(batch, revision, { unlimitedBudget });
  return { root, batch, manifest };
}

async function editRecord(batch, slot, edit) {
  const file = path.join(batch, slot.recordFile), record = JSON.parse(await fs.readFile(file, 'utf8'));
  edit(record);
  await fs.writeFile(file, JSON.stringify(record, null, 2) + '\n');
  return record;
}

function fillOperatorFields(record) {
  Object.assign(record, {
    model: 'operator-model', protocol: 'operator-protocol',
    configurationReference: 'operator:configuration', credentialSourceReference: 'operator:credential-source',
  });
  record.budget.approvalPolicy = 'Confirm side effects individually.';
  record.budget.stopConditions = ['Stop on operator cancellation or an unresolved safety failure.'];
}

async function unfinishedAttempt(batch, slot) {
  const loaded = await loadEngineeringBatch(batch), record = loaded.records.get(slot.runId), attemptId = randomUUID();
  const directory = path.join(batch, 'attempts', slot.runId, attemptId);
  await fs.mkdir(directory, { recursive: true });
  const intent = {
    kind: 'native-engineering-attempt', schemaVersion: 1, attemptId, runId: slot.runId,
    suite: loaded.manifest.suite, record, recordDigest: hashJson(record),
    candidateDirectory: path.join(path.dirname(batch), 'unopened-candidate'),
    startedAt: new Date().toISOString(), timeoutMs: 1000,
  };
  await createJson(path.join(directory, 'intent.json'), intent);
  return intent;
}

function cli(...args) {
  const result = spawnSync(process.execPath, [path.join(evaluatorRoot, 'scripts/native-eval.mjs'), ...args], {
    cwd: evaluatorRoot, encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(result.error); assert.equal(result.signal, null);
  return result;
}

test('only v2 budget fields accept explicit unlimited; legacy records and actual metrics remain numeric or null', async t => {
  const { batch, manifest } = await fixture(t), slot = manifest.slots[0];
  const record = (await loadEngineeringBatch(batch)).records.get(slot.runId);
  assert.equal(record.schemaVersion, 1);
  for (const field of limitFields) {
    const legacy = structuredClone(record); legacy.budget[field] = 'unlimited';
    assert.throws(() => assertEngineeringRecord(legacy, slot, manifest), /Invalid engineering budget/);
    legacy.schemaVersion = 2;
    assertEngineeringRecord(legacy, slot, manifest);
    for (const invalid of ['unknown', 'Unlimited', '0', -1]) {
      legacy.budget[field] = invalid;
      assert.throws(() => assertEngineeringRecord(legacy, slot, manifest), /Invalid engineering budget/);
    }
  }
  for (const schemaVersion of [1, 2]) for (const field of [...METRIC_NUMBERS, 'costAmount']) {
    const invalid = structuredClone(record); invalid.schemaVersion = schemaVersion; invalid.metrics[field] = 'unlimited';
    assert.throws(() => assertEngineeringRecord(invalid, slot, manifest), /Invalid engineering metric/);
  }
  record.schemaVersion = 3;
  assert.throws(() => assertEngineeringRecord(record, slot, manifest), /record identity/);
});

test('unlimited initialization, readiness and report comparison retain unknown usage and explicit budget declarations', async t => {
  const { root, batch, manifest } = await fixture(t, true);
  const initial = await loadEngineeringBatch(batch);
  for (const record of initial.records.values()) {
    assert.equal(record.schemaVersion, 2);
    assert.ok(limitFields.every(field => record.budget[field] === 'unlimited'));
    assert.equal(record.budget.currency, null);
    assert.equal(record.budget.approvalPolicy, null);
    assert.deepEqual(record.budget.stopConditions, []);
    assert.ok(Object.values(record.metrics).every(value => value === null));
  }
  const incomplete = await checkEngineeringReadiness(batch);
  assert.equal(incomplete.status, 'blocked');
  assert.deepEqual(incomplete.slots[0].issues.filter(issue => issue.code === 'missing_budget').map(issue => issue.field), ['budget.approvalPolicy', 'budget.stopConditions']);
  for (const slot of manifest.slots) await editRecord(batch, slot, fillOperatorFields);
  const before = [...(await loadEngineeringBatch(batch)).records.values()].map(hashJson);
  const ready = await checkEngineeringReadiness(batch);
  assert.equal(ready.status, 'metadata_complete');
  assert.equal(ready.executionAuthorized, false); assert.equal(ready.realQualityStatus, 'pending');
  assert.deepEqual([...(await loadEngineeringBatch(batch)).records.values()].map(hashJson), before);
  const reportFile = path.join(root, 'unlimited.json'), report = await generateEngineeringReport(batch, reportFile);
  assert.equal(report.slots[0].record.budget.modelRequests, 'unlimited');
  assert.equal(report.summary.metrics.modelRequests.sum, null);
  assert.equal(report.summary.metrics.costAmount.knownSum, null);
  const compared = await compareEngineeringReports(reportFile, reportFile);
  assert.deepEqual(compared.comparability.missingMetadata, []);
  assert.deepEqual(compared.comparability.metadataDifferences, []);
  assert.equal(compared.slots[0].left.metadata.budget.costAmount, 'unlimited');
  assert.equal(compared.slots[0].right.metadata.budget.currency, null);
});

test('duration budgets respect unlimited ordering and unknown or zero budgets still block readiness', async t => {
  const { batch, manifest } = await fixture(t, true);
  for (const slot of manifest.slots) await editRecord(batch, slot, fillOperatorFields);
  const changes = [
    { activeDurationMs: 100, wallDurationMs: 'unlimited' },
    { activeDurationMs: 'unlimited', wallDurationMs: 100 },
    { activeDurationMs: 101, wallDurationMs: 100 },
    { activeDurationMs: 100, wallDurationMs: 100 },
    { activeDurationMs: null, wallDurationMs: 'unlimited' },
    { modelRequests: 0 }, { costAmount: null }, { costAmount: 0, currency: 'USD' },
  ];
  for (const [index, change] of changes.entries()) await editRecord(batch, manifest.slots[index], record => Object.assign(record.budget, change));
  const result = await checkEngineeringReadiness(batch);
  assert.deepEqual(result.slots.map(slot => slot.status), ['metadata_complete', 'blocked', 'blocked', 'metadata_complete', 'blocked', 'blocked', 'blocked', 'metadata_complete', 'metadata_complete', 'metadata_complete', 'metadata_complete', 'metadata_complete']);
  assert.deepEqual(result.slots[1].issues, [{ code: 'inconsistent_duration_budget', field: 'budget.activeDurationMs' }]);
  assert.deepEqual(result.slots[2].issues, [{ code: 'inconsistent_duration_budget', field: 'budget.activeDurationMs' }]);
  assert.deepEqual(result.slots[4].issues, [{ code: 'missing_budget', field: 'budget.activeDurationMs' }]);
  assert.deepEqual(result.slots[5].issues, [{ code: 'nonpositive_execution_budget', field: 'budget.modelRequests' }]);
  assert.deepEqual(result.slots[6].issues, [{ code: 'missing_budget', field: 'budget.costAmount' }, { code: 'missing_budget', field: 'budget.currency' }]);
  await editRecord(batch, manifest.slots[7], record => { record.budget.currency = null; });
  await assert.rejects(loadEngineeringBatch(batch), /budget cost currency/);
});

test('legacy and v2 attempt snapshots survive report comparison without rewriting history', async t => {
  const { root, batch, manifest } = await fixture(t), first = manifest.slots[0], second = manifest.slots[1];
  for (const slot of manifest.slots) await editRecord(batch, slot, record => {
    fillOperatorFields(record);
    for (const field of limitFields) record.budget[field] = 10;
    record.budget.currency = 'USD';
  });
  const legacyIntent = await unfinishedAttempt(batch, first);
  const leftFile = path.join(root, 'legacy.json'); await generateEngineeringReport(batch, leftFile);
  for (const slot of manifest.slots) await editRecord(batch, slot, record => {
    record.schemaVersion = 2;
    for (const field of limitFields) record.budget[field] = 'unlimited';
    record.budget.currency = null;
  });
  const newIntent = await unfinishedAttempt(batch, second);
  const rightFile = path.join(root, 'updated.json'), report = await generateEngineeringReport(batch, rightFile);
  assert.deepEqual(report.slots[0].attempts[0].intent, legacyIntent);
  assert.equal(report.slots[0].attempts[0].recordChanged, true);
  assert.deepEqual(report.slots[1].attempts[0].intent, newIntent);
  assert.equal(report.slots[1].attempts[0].intent.record.schemaVersion, 2);
  const compared = await compareEngineeringReports(leftFile, rightFile);
  assert.deepEqual(compared.comparability.missingMetadata, []);
  assert.ok(compared.slots.every(slot => slot.metadataDifferences.join(',') === 'budget'));
  assert.equal(compared.slots[0].left.metadata.budget.modelRequests, 10);
  assert.equal(compared.slots[0].right.metadata.budget.modelRequests, 'unlimited');
  assert.equal(compared.right.summary.verificationStatuses.unknown, 2);
});

test('CLI opts into v2 explicitly and rejects invalid unlimited options before creating any files', async t => {
  const { root } = await fixture(t), batch = path.join(root, 'cli-batch');
  for (const args of [
    [batch, revision, '--unlimited'], [batch, revision, '--unlimited-budget', 'true'],
    [batch, revision, '--unlimited-budget', '--unlimited-budget'], [batch, '--unlimited-budget', revision],
    [batch, 'bad-revision', '--unlimited-budget'],
  ]) {
    const result = cli('engineering-init', ...args);
    assert.equal(result.status, 2); assert.equal(result.stdout, '');
    await assert.rejects(fs.stat(batch), { code: 'ENOENT' });
  }
  await assert.rejects(initializeEngineeringBatch(batch, revision, { unlimitedBudget: 'true' }), /explicit boolean/);
  await assert.rejects(fs.stat(batch), { code: 'ENOENT' });
  const success = cli('engineering-init', batch, revision, '--unlimited-budget');
  assert.equal(success.status, 0); assert.equal(success.stderr, '');
  assert.equal((await loadEngineeringBatch(batch)).slots[0].record.schemaVersion, 2);
  const before = [...(await loadEngineeringBatch(batch)).records.values()].map(hashJson);
  assert.equal(cli('engineering-init', batch, revision, '--unlimited-budget').status, 2);
  assert.deepEqual([...(await loadEngineeringBatch(batch)).records.values()].map(hashJson), before);
  const defaultBatch = path.join(root, 'default-batch');
  assert.equal(cli('engineering-init', defaultBatch, revision).status, 0);
  const legacy = (await loadEngineeringBatch(defaultBatch)).slots[0].record;
  assert.equal(legacy.schemaVersion, 1); assert.equal(legacy.budget.modelRequests, null);
});
