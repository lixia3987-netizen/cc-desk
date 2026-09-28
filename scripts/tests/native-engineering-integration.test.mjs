import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initializeEngineeringBatch, generateEngineeringReport } from '../native-eval-engineering-reports.mjs';
import { verifyEngineeringRun } from '../native-eval-engineering-runner.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const suite = path.join(repository, 'evals/native-engineering/v1');
const baseline = 'b45bd0623d2a44a2878c46d4701fa4b388c7d9be';
const runId = 'native-01-snapshot-refresh-r1';
const sourcePath = 'apps/desktop/src/renderer/chat-snapshot-sync.ts';
const newTestPath = 'apps/desktop/tests/e0-snapshot-regression.test.ts';
const protectedPath = 'apps/desktop/tests/chat-snapshot-sync.test.ts';

function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', ...args], {
    cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

async function linkInstalledDependencies(candidate) {
  const destination = path.join(candidate, 'node_modules');
  await fs.mkdir(destination);
  for (const name of await fs.readdir(path.join(repository, 'node_modules'))) {
    if (name === '@cc-desk' || name === 'claude-workbench') continue;
    await fs.symlink(path.join(repository, 'node_modules', name), path.join(destination, name), 'junction');
  }
  await fs.mkdir(path.join(destination, '@cc-desk'));
  for (const name of ['contracts', 'engine-claude', 'agent-core', 'agent-node']) {
    await fs.symlink(path.join(candidate, 'packages', name), path.join(destination, '@cc-desk', name), 'junction');
  }
  await fs.symlink(path.join(candidate, 'apps/desktop'), path.join(destination, 'claude-workbench'), 'junction');
}

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'native-engineering-integration-'));
  const candidate = path.join(parent, 'candidate'), batch = path.join(parent, 'operator-batch');
  let registered = false;
  t.after(async () => {
    try { if (registered) git(repository, ['worktree', 'remove', '--force', candidate]); }
    finally { await fs.rm(parent, { recursive: true, force: true }); }
  });
  git(repository, ['worktree', 'add', '--detach', candidate, baseline]);
  registered = true;
  await linkInstalledDependencies(candidate);
  await fs.copyFile(path.join(suite, '01-snapshot-refresh/TASK.md'), path.join(candidate, 'TASK.md'));
  git(candidate, ['apply', path.join(suite, '01-snapshot-refresh/injection.patch')]);
  git(candidate, ['apply', path.join(suite, '01-snapshot-refresh/reference.patch')]);
  const greenSource = await fs.readFile(path.join(candidate, sourcePath), 'utf8');
  const newTest = await fs.readFile(path.join(candidate, newTestPath), 'utf8');
  const protectedTest = await fs.readFile(path.join(candidate, protectedPath), 'utf8');
  git(candidate, ['apply', path.join(suite, '01-snapshot-refresh/injection.patch')]);
  return { parent, candidate, batch, greenSource, newTest, protectedTest };
}

// The operator's immutable verifier and the candidate run in different processes.
// These are local process/integrity checks, not real-model or Electron acceptance.
test('engineering verification preserves failed and successful attempts and refuses false completion', { timeout: 180_000 }, async t => {
  const context = await fixture(t);
  await initializeEngineeringBatch(context.batch, git(repository, ['rev-parse', 'HEAD']));
  const statuses = [], directories = new Set();
  const verify = async timeoutMs => {
    const attempt = await verifyEngineeringRun({ batchDirectory: context.batch, runId, candidateDirectory: context.candidate, timeoutMs });
    assert.equal(directories.has(attempt.attemptDirectory), false, 'each retry needs a new durable attempt');
    directories.add(attempt.attemptDirectory);
    statuses.push(attempt.result.verification.status);
    return attempt;
  };

  await t.test('the injected regression is red even when the requested new test exists', async () => {
    const attempt = await verify(60_000);
    assert.equal(attempt.result.verification.status, 'fail');
  });

  await t.test('the reference fix passes the immutable oracle and selected original/new tests', async () => {
    await fs.writeFile(path.join(context.candidate, sourcePath), context.greenSource);
    const attempt = await verify(60_000);
    assert.equal(attempt.result.verification.status, 'pass', JSON.stringify(attempt.result));
  });

  await t.test('a new test modifying an already executed protected test cannot pass', async () => {
    await fs.appendFile(path.join(context.candidate, newTestPath),
      `\ntest('candidate test side effect', async () => { await (await import('node:fs/promises')).appendFile(${JSON.stringify(path.join(context.candidate, protectedPath))}, '\\n// modified during candidate tests\\n'); });\n`);
    try {
      const attempt = await verify(60_000);
      assert.equal(attempt.result.verification.status, 'fail', JSON.stringify(attempt.result));
      assert.ok(await fs.readFile(path.join(context.candidate, protectedPath), 'utf8') !== context.protectedTest,
        'the fixture must reach the mutation before rejection: ' + JSON.stringify(attempt.result));
    } finally {
      await fs.writeFile(path.join(context.candidate, newTestPath), context.newTest);
      await fs.writeFile(path.join(context.candidate, protectedPath), context.protectedTest);
    }
  });

  await t.test('exit zero with pass-looking stdout but no completed verifier receipt is an error', async () => {
    await fs.writeFile(path.join(context.candidate, sourcePath),
      `console.log(JSON.stringify({task:'01-snapshot-refresh',functionalStatus:'pass',realQualityStatus:'pending'})); process.exit(0);\n${context.greenSource}`);
    const attempt = await verify(10_000);
    assert.equal(attempt.result.verification.status, 'error', JSON.stringify(attempt.result));
  });

  await t.test('a looping oracle is stopped by the outer deadline and recorded as timeout', async () => {
    await fs.writeFile(path.join(context.candidate, sourcePath), `while (true) {}\n${context.greenSource}`);
    const started = Date.now();
    const attempt = await verify(1_000);
    assert.equal(attempt.result.verification.status, 'timeout', JSON.stringify(attempt.result));
    assert.ok(Date.now() - started < 15_000, 'the child verifier must be stopped within the outer test deadline');
  });

  await t.test('a pre-cancelled verification preserves an explicit cancelled attempt', async () => {
    const controller = new AbortController(); controller.abort();
    const attempt = await verifyEngineeringRun({ batchDirectory: context.batch, runId, candidateDirectory: context.candidate,
      timeoutMs: 10_000, signal: controller.signal });
    assert.equal(attempt.result.verification.status, 'cancelled', JSON.stringify(attempt.result));
    assert.equal(directories.has(attempt.attemptDirectory), false);
    directories.add(attempt.attemptDirectory); statuses.push('cancelled');
  });

  await t.test('the report retains every attempt and all planned slots without upgrading acceptance', async () => {
    const report = await generateEngineeringReport(context.batch, path.join(context.parent, 'report.json'));
    assert.equal(report.slots.length, 12);
    assert.equal(report.summary.slotCount, 12);
    assert.equal(report.summary.attemptCount, statuses.length);
    assert.equal(report.summary.unattemptedSlots, 11);
    const attempts = report.slots.find(slot => slot.runId === runId).attempts;
    assert.equal(attempts.length, statuses.length);
    assert.deepEqual(attempts.map(attempt => attempt.status).sort(), [...statuses].sort());
    for (const status of new Set(statuses)) {
      assert.equal(report.summary.verificationStatuses[status], statuses.filter(item => item === status).length);
    }
    assert.equal(report.realQualityStatus, 'pending');
    assert.equal(report.graphicalAcceptance, 'pending');
    assert.equal(report.platformAcceptance, 'pending');
    assert.equal(report.verdict, 'manual-review-required');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(context.parent, 'report.json'), 'utf8')), report);
  });
});

test('engineering CLI rejects trailing arguments before creating a report or batch', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-engineering-cli-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const batch = path.join(directory, 'must-not-be-created');
  const result = spawnSync(process.execPath, [path.join(repository, 'scripts/native-eval.mjs'), 'engineering-init', batch,
    git(repository, ['rev-parse', 'HEAD']), '--unknown'], { cwd: repository, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 2, result.stderr);
  await assert.rejects(fs.stat(batch), { code: 'ENOENT' });
});
