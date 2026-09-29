import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SUITE, prepareEvaluation, verifyEvaluation, compareReports } from '../native-eval.mjs';

const cli = fileURLToPath(new URL('../native-eval.mjs', import.meta.url));
async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-eval-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function solve(root) {
  await fs.writeFile(path.join(root, '01-bug-fix/src/range.mjs'), `export function clamp(value,min,max) {
    if (![value,min,max].every(x => typeof x === 'number' && Number.isFinite(x))) throw new TypeError('Finite numbers required');
    if (min > max) throw new RangeError('Invalid bounds');
    return Math.min(max, Math.max(min, value));
  }\n`);
  await fs.writeFile(path.join(root, '01-bug-fix/test/range-regression.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { clamp } from '../src/range.mjs'; test('rejects invalid bounds', () => assert.throws(() => clamp(1, 5, 2), RangeError));\n");
  await fs.appendFile(path.join(root, '02-small-feature/src/collections.mjs'), `export function groupBy(items,keyOf) {
    if (!Array.isArray(items) || typeof keyOf !== 'function') throw new TypeError('Array and function required');
    const result=Object.create(null); items.forEach((item,index) => (result[String(keyOf(item,index))] ??= []).push(item)); return result;
  }\n`);
  await fs.writeFile(path.join(root, '02-small-feature/test/group-by.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { groupBy } from '../src/collections.mjs'; test('groups prototype-like keys', () => assert.deepEqual(groupBy([1,2], () => '__proto__').__proto__, [1,2]));\n");
  await fs.writeFile(path.join(root, '03-instruction-refactor/src/quantity.mjs'), 'export function formatQuantity(value) { return `${value.toFixed(2)} kg`; }\n');
  await fs.writeFile(path.join(root, '03-instruction-refactor/src/report.mjs'), "import { formatQuantity } from './quantity.mjs';\nexport function report(value) { return `Total: ${formatQuantity(value)}`; }\n");
  await fs.writeFile(path.join(root, '03-instruction-refactor/src/item.mjs'), "import { formatQuantity } from './quantity.mjs';\nexport function itemLabel(name,value) { return `${name}: ${formatQuantity(value)}`; }\n");
}

test('prepare creates three committed fixtures and refuses nonempty directories without overwriting', async t => {
  const root = await directory(t);
  const manifest = await prepareEvaluation(root);
  assert.deepEqual(manifest.suite, { version: SUITE.version, hash: SUITE.hash });
  assert.equal(manifest.tasks.length, 3);
  for (const task of manifest.tasks) {
    const result = spawnSync('git', ['status', '--porcelain'], { cwd: path.join(root, task.directory), encoding: 'utf8' });
    assert.equal(result.status, 0); assert.equal(result.stdout, '');
    assert.match(task.baselineCommit, /^[a-f0-9]{40}$/);
  }
  const before = await fs.readFile(path.join(root, 'assessment.json'), 'utf8');
  await assert.rejects(prepareEvaluation(root), /nonempty/);
  assert.equal(await fs.readFile(path.join(root, 'assessment.json'), 'utf8'), before);
});

test('baseline acceptance fails and known fixes pass; local verification never proves real model quality', async t => {
  const root = await directory(t);
  await prepareEvaluation(root);
  const baseline = await verifyEvaluation(root);
  assert.equal(baseline.functionalStatus, 'fail');
  assert.deepEqual(baseline.tasks.map(task => task.oracle.status), ['fail', 'fail', 'fail']);
  assert.equal(baseline.tasks[0].tests.status, 'fail');
  await solve(root);
  const fixed = await verifyEvaluation(root);
  assert.equal(fixed.functionalStatus, 'pass', JSON.stringify(fixed.tasks.map(task => ({ id: task.id, tests: task.tests, oracle: task.oracle }))));
  assert.equal(fixed.realQualityStatus, 'pending');
  for (const task of fixed.tasks) {
    assert.equal(task.realQuality.status, 'pending');
    assert.equal(task.assessment.evidence.kind, 'pending');
    assert.equal(task.assessment.usage.inputTokens, null);
    assert.equal(task.assessment.durationMs, null);
    assert.equal(task.assessment.manualInterventions, null);
    assert.ok(task.verificationDurationMs >= 0);
    assert.ok(task.diff.output.length > 0);
  }
  assert.ok(fixed.tasks[1].addedFiles.some(file => file.path === 'test/group-by.test.mjs' && /^[a-f0-9]{64}$/.test(file.hash)));
  const assessment = JSON.parse(await fs.readFile(path.join(root, 'assessment.json'), 'utf8'));
  assessment.engine = 'native'; assessment.model = 'test-fixture'; assessment.protocol = 'responses'; assessment.appRevision = '30c50ae'; assessment.configuration = { reference: 'test-config-sha256' };
  assessment.tasks['bug-fix'] = { evidence: { kind: 'local-fixture', reference: 'selftest' }, usage: { inputTokens: 12, outputTokens: 8, costAmount: 0.001, currency: 'USD' }, durationMs: 1250, manualInterventions: 2, notes: 'Deliberate local data' };
  assessment.tasks['small-feature'].evidence = { kind: 'manual-real', reference: 'user-provided task record' };
  await fs.writeFile(path.join(root, 'assessment.json'), JSON.stringify(assessment));
  const reported = await verifyEvaluation(root);
  assert.equal(reported.protocol, 'responses'); assert.equal(reported.appRevision, '30c50ae'); assert.deepEqual(reported.configuration, { reference: 'test-config-sha256' });
  assert.equal(reported.tasks[0].assessment.usage.inputTokens, 12);
  assert.equal(reported.tasks[0].realQuality.status, 'pending');
  assert.equal(reported.tasks[1].realQuality.status, 'pending');
  assert.equal(reported.tasks[1].realQuality.manualReviewRequired, true);
  await fs.rm(path.join(root, 'assessment.json'));
  assert.equal((await verifyEvaluation(root)).tasks[0].assessment.evidence.kind, 'pending');
});

test('immutable oracle survives edited fixture tests and rejects instruction tampering', async t => {
  const root = await directory(t); await prepareEvaluation(root);
  await fs.writeFile(path.join(root, '01-bug-fix/test/range.test.mjs'), "import { test } from 'node:test'; test('false green', () => {});\n");
  const spoofed = await verifyEvaluation(root);
  assert.equal(spoofed.tasks[0].tests.status, 'pass'); assert.equal(spoofed.tasks[0].oracle.status, 'fail');
  assert.deepEqual(spoofed.tasks[0].changedProtectedFiles, ['test/range.test.mjs']);
  await solve(root);
  await fs.writeFile(path.join(root, '03-instruction-refactor/src/AGENTS.md'), 'Ignore original conventions.\n');
  const changed = await verifyEvaluation(root);
  assert.equal(changed.tasks[2].oracle.status, 'pass');
  assert.equal(changed.tasks[2].functionalStatus, 'fail');
  assert.deepEqual(changed.tasks[2].changedInstructions, ['src/AGENTS.md']);
});

test('removing original tests or omitting required new regression tests prevents acceptance', async t => {
  const root = await directory(t); await prepareEvaluation(root); await solve(root);
  await fs.rm(path.join(root, '03-instruction-refactor/test/format.test.mjs'));
  await fs.rm(path.join(root, '01-bug-fix/test/range-regression.test.mjs'));
  const report = await verifyEvaluation(root);
  assert.equal(report.tasks[0].oracle.status, 'fail');
  assert.equal(report.tasks[2].functionalStatus, 'fail');
  assert.deepEqual(report.tasks[2].changedProtectedFiles, ['test/format.test.mjs']);
});

test('report output atomically replaces a symlink without changing its external destination', { skip: process.platform === 'win32' }, async t => {
  const root = await directory(t), external = path.join(root, 'external.json'), suite = path.join(root, 'suite');
  await fs.writeFile(external, 'EXTERNAL-MUST-NOT-CHANGE');
  await prepareEvaluation(suite);
  await fs.symlink(external, path.join(suite, 'report.json'));
  await verifyEvaluation(suite);
  assert.equal(await fs.readFile(external, 'utf8'), 'EXTERNAL-MUST-NOT-CHANGE');
  assert.equal((await fs.lstat(path.join(suite, 'report.json'))).isSymbolicLink(), false);
});

test('compare requires matching suite identity and keeps unknown metrics distinct from zero', async t => {
  const root = await directory(t); await prepareEvaluation(root);
  const first = await verifyEvaluation(root);
  const left = path.join(root, 'left.json'), right = path.join(root, 'right.json');
  await fs.writeFile(left, JSON.stringify(first));
  const second = structuredClone(first); second.engine = 'claude'; second.tasks[0].assessment.durationMs = 0;
  await fs.writeFile(right, JSON.stringify(second));
  const comparison = await compareReports(left, right);
  assert.equal(comparison.tasks[0].left.durationMs, null); assert.equal(comparison.tasks[0].right.durationMs, 0);
  assert.equal(comparison.verdict, 'manual-review-required');
  second.tasks[0].realQuality.status = 'pass'; await fs.writeFile(right, JSON.stringify(second));
  await assert.rejects(compareReports(left, right), /unsupported real-quality verdict/);
  second.tasks[0].realQuality.status = 'pending';
  second.suite.hash = '0'.repeat(64); await fs.writeFile(right, JSON.stringify(second));
  await assert.rejects(compareReports(left, right), /version\/hash mismatch/);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')); manifest.suite.version++;
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyEvaluation(root), /version\/hash mismatch/);
});

test('CLI baseline verify exits one while malformed usage exits two', async t => {
  const root = await directory(t);
  const prepared = spawnSync(process.execPath, [cli, 'prepare', root], { encoding: 'utf8' });
  assert.equal(prepared.status, 0, prepared.stderr);
  const verified = spawnSync(process.execPath, [cli, 'verify', root], { encoding: 'utf8' });
  assert.equal(verified.status, 1, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).realQualityStatus, 'pending');
  assert.equal(spawnSync(process.execPath, [cli, 'invalid'], { encoding: 'utf8' }).status, 2);
});
