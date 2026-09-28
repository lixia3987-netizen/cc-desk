import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { loadEngineeringBatch } from './native-eval-engineering-reports.mjs';
import { assertAttemptIntent, assertAttemptResult, assertVerifierOutput, MAX_ATTEMPTS } from './native-eval-engineering-schema.mjs';
import { ordinaryDirectory, createJson, hashJson, commandEnvironment, assertSeparate } from './native-eval-engineering-common.mjs';

const evaluatorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suiteRoot = path.join(evaluatorRoot, 'evals/native-engineering/v1');
const OUTPUT_LIMIT = 256 * 1024;
const RETAINED_OUTPUT = OUTPUT_LIMIT;
const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 300_000;
const sha = value => createHash('sha256').update(value).digest('hex');

/** The source, imports and entry point are evaluator-owned, never candidate supplied. */
const VERIFICATION_PROGRAM = `
import { verify } from ${JSON.stringify(pathToFileURL(path.join(suiteRoot, 'acceptance/verify.mjs')).href)};
import { assertIntegrity } from ${JSON.stringify(pathToFileURL(path.join(suiteRoot, 'acceptance/common.mjs')).href)};
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
process.env.GIT_TERMINAL_PROMPT = '0';
const [taskId, candidate] = process.argv.slice(1);
try {
  const verification = await verify(taskId, candidate);
  const postIntegrity = await assertIntegrity(candidate, taskId);
  process.stdout.write(JSON.stringify({ schemaVersion: 1, kind: 'native-engineering-verification', taskId, status: 'pass', functionalStatus: 'pass', verification, postIntegrity, error: null }));
} catch (error) {
  process.stdout.write(JSON.stringify({ schemaVersion: 1, kind: 'native-engineering-verification', taskId, status: 'fail', functionalStatus: 'fail', verification: null, postIntegrity: null, error: String(error?.message ?? error).slice(0, 16000) }));
  process.exitCode = 1;
}
`;

function clipped(buffer, limit = RETAINED_OUTPUT) {
  let end = Math.min(buffer.length, limit);
  // Never turn a split UTF-8 sequence into replacement bytes beyond the budget.
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
  return { text: buffer.subarray(0, end).toString('utf8'), truncated: buffer.length > end };
}

function appendError(verification, message) {
  const output = clipped(Buffer.from(`${verification.stderr}\n${message}`));
  verification.stderr = output.text;
  verification.stderrTruncated ||= output.truncated;
}

/** A complete receipt and matching process exit are required; stdout alone is not a verdict. */
export function parseEngineeringVerificationReceipt(stdout, exitCode, taskId) {
  let output;
  try { output = JSON.parse(stdout); } catch { throw new Error('Verifier did not produce one complete JSON receipt.'); }
  return assertVerifierOutput(output, exitCode, taskId);
}

/** Reuse the production supervisor and its platform-specific release checks. */
async function runVerifier(taskId, candidate, timeoutMs, signal) {
  let ProcessSupervisor;
  try { ({ ProcessSupervisor } = await import('@cc-desk/agent-node/process-supervisor')); }
  catch { throw new Error('Evaluator packages are not built. Run npm run build:packages in the evaluator before verification.'); }
  const supervisor = new ProcessSupervisor({ environment: commandEnvironment(), defaultTimeoutMs: timeoutMs,
    maxTimeoutMs: MAX_TIMEOUT, defaultMaxOutputBytes: OUTPUT_LIMIT, maxOutputBytes: OUTPUT_LIMIT, cleanupTimeoutMs: 10_000 });
  const owner = randomUUID();
  let result;
  try {
    result = await supervisor.run(owner, { executable: process.execPath,
      argv: ['--input-type=module', '-e', VERIFICATION_PROGRAM, taskId, candidate], cwd: evaluatorRoot, timeoutMs, maxOutputBytes: OUTPUT_LIMIT }, signal);
  } catch (error) {
    if (supervisor.has(owner)) Object.assign(error, { cleanupUnconfirmed: true });
    throw error;
  }
  return { exitCode: result.exitCode, signal: result.signal,
    reason: result.timedOut ? 'timeout' : result.cancelled ? 'cancelled' : result.truncated ? 'output_limit' : null,
    cleanupConfirmed: result.cleanup === 'released', stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr),
    stdoutOverflow: result.truncated, stderrOverflow: result.truncated, processError: result.error ?? null };
}

async function git(candidate, argv) {
  const { spawnSync } = await import('node:child_process');
  const response = spawnSync('git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', '-c', 'core.fsmonitor=false', ...argv], {
    cwd: candidate, env: { ...commandEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    timeout: 30_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', windowsHide: true,
  });
  if (response.error || response.status !== 0) throw new Error(`Candidate Git inspection failed: ${String(response.error?.message ?? response.stderr).slice(0, 2000)}`);
  return response.stdout;
}

async function snapshotCandidate(candidate, baseline) {
  const head = (await git(candidate, ['rev-parse', 'HEAD'])).trim();
  if (!/^[a-f0-9]{40}$/.test(head) || (await git(candidate, ['rev-parse', `${baseline}^{commit}`])).trim() !== baseline) throw new Error('Candidate does not contain the fixed task baseline.');
  const names = new Set([
    ...(await git(candidate, ['ls-tree', '-r', '--name-only', '-z', baseline])).split('\0'),
    ...(await git(candidate, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0'),
  ].filter(Boolean));
  if (names.size > 20_000) throw new Error('Candidate file count exceeds inspection limit.');
  const files = []; let bytes = 0;
  for (const name of [...names].sort()) {
    if (name.includes('\\') || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Candidate has an unsupported path.');
    const absolute = path.join(candidate, name);
    try {
      const stat = await fs.lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(absolute) !== absolute) throw new Error('Candidate source must use ordinary files and directories.');
      bytes += stat.size;
      if (stat.size > 2 * 1024 * 1024 || bytes > 64 * 1024 * 1024) throw new Error('Candidate source exceeds inspection limits.');
      const handle = await fs.open(absolute, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) throw new Error('Candidate changed while its snapshot was opened.');
        const data = Buffer.alloc(stat.size + 1); let length = 0;
        while (length < data.length) {
          const { bytesRead } = await handle.read(data, length, data.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        const after = await handle.stat();
        if (length !== stat.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || await fs.realpath(absolute) !== absolute) throw new Error('Candidate changed while its snapshot was read.');
        files.push([name, sha(data.subarray(0, length)), stat.mode & 0o111]);
      } finally { await handle.close(); }
    } catch (error) { if (error.code === 'ENOENT') files.push([name, null, null]); else throw error; }
  }
  return { head, digest: hashJson(files) };
}

/** Append an independently supervised verification attempt; never changes declared run outcomes. */
export async function verifyEngineeringRun({ batchDirectory, runId, candidateDirectory, timeoutMs = DEFAULT_TIMEOUT, signal } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT) throw new Error('Verification timeout must be an integer from 1 to 300000 ms.');
  if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function')) throw new Error('Invalid verification cancellation signal.');
  const initial = await loadEngineeringBatch(batchDirectory);
  const { root } = initial;
  if (!initial.records.has(runId)) throw new Error('Unknown engineering run ID.');
  const candidate = await ordinaryDirectory(candidateDirectory);
  assertSeparate(candidate, root, evaluatorRoot);
  const lockFile = path.join(root, 'verification-lock.json');
  await createJson(lockFile, { kind: 'native-engineering-verification-lock', schemaVersion: 1,
    owner: randomUUID(), runId, candidateDirectory: candidate, createdAt: new Date().toISOString() });
  let startedIntent = false, resultPublished = false, cleanupConfirmed = true;
  try {
    const { manifest, records, attemptCount, attempts } = await loadEngineeringBatch(root);
    const record = records.get(runId);
    if (attemptCount >= MAX_ATTEMPTS) throw new Error('Engineering batch has reached its verification attempt limit.');
    for (const previous of [...attempts.values()].flat()) {
      if (previous.intent.candidateDirectory !== candidate) continue;
      if (previous.intent.runId !== runId) throw new Error('Each engineering task, engine and round requires an independent candidate directory.');
      if (!previous.result || !previous.result.verification.cleanupConfirmed) throw new Error('Candidate has an unfinished verification attempt. Inspect its processes and use a new independent candidate.');
    }
    const attemptId = randomUUID();
    const intent = { kind: 'native-engineering-attempt', schemaVersion: 1, attemptId, runId, suite: structuredClone(manifest.suite), record: structuredClone(record), recordDigest: hashJson(record), candidateDirectory: candidate, startedAt: new Date().toISOString(), timeoutMs };
    assertAttemptIntent(intent);
    let attemptDirectory = root;
    for (const name of ['attempts', runId, attemptId]) {
      attemptDirectory = path.join(attemptDirectory, name);
      await fs.mkdir(attemptDirectory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      await ordinaryDirectory(attemptDirectory);
    }
    startedIntent = true;
    await createJson(path.join(attemptDirectory, 'intent.json'), intent);
    const started = Date.now();
    let before = null, after = null;
    const verification = { status: 'error', exitCode: null, signal: null, durationMs: 0, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, output: null, cleanupConfirmed: true };
    try {
      if (signal?.aborted) verification.status = 'cancelled';
      else {
        before = await snapshotCandidate(candidate, record.taskBaseline);
        if (signal?.aborted) verification.status = 'cancelled';
        else {
          const child = await runVerifier(record.taskId, candidate, timeoutMs, signal);
          const stdout = clipped(child.stdout), stderr = clipped(child.stderr);
          Object.assign(verification, { exitCode: child.exitCode, signal: child.signal, stdout: stdout.text, stderr: stderr.text, stdoutTruncated: stdout.truncated || child.stdoutOverflow, stderrTruncated: stderr.truncated || child.stderrOverflow, cleanupConfirmed: child.cleanupConfirmed });
          if (!child.cleanupConfirmed) verification.status = 'unknown';
          else if (child.reason === 'timeout' || child.reason === 'cancelled') verification.status = child.reason;
          else if (child.reason || child.processError) throw new Error(child.processError ?? `Verifier stopped: ${child.reason}.`);
          else {
            verification.output = parseEngineeringVerificationReceipt(child.stdout.toString('utf8'), child.exitCode, record.taskId);
            verification.status = verification.output.status;
          }
        }
      }
    } catch (error) {
      if (error?.cleanupUnconfirmed) verification.cleanupConfirmed = false;
      verification.status = verification.cleanupConfirmed ? 'error' : 'unknown';
      appendError(verification, String(error?.message ?? error));
    }
    if (before && verification.cleanupConfirmed) {
      try {
        after = await snapshotCandidate(candidate, record.taskBaseline);
        if ((after.digest !== before.digest || after.head !== before.head) && verification.status === 'pass') {
          verification.status = 'fail';
          appendError(verification, 'Candidate source or HEAD changed during verification.');
        }
      } catch (error) {
        verification.status = 'error';
        appendError(verification, `Post-verification inspection failed: ${error.message}`);
      }
    }
    verification.durationMs = Date.now() - started;
    const result = { kind: 'native-engineering-attempt-result', schemaVersion: 1, attemptId, runId, intentDigest: hashJson(intent), finishedAt: new Date().toISOString(), verification,
      candidate: { head: before?.head ?? null, beforeDigest: before?.digest ?? null, afterDigest: after?.digest ?? null, changedDuringVerification: before && after ? before.digest !== after.digest || before.head !== after.head : null }, realQualityStatus: 'pending' };
    assertAttemptResult(result);
    cleanupConfirmed = verification.cleanupConfirmed;
    await createJson(path.join(attemptDirectory, 'result.json'), result);
    resultPublished = true;
    return { attemptDirectory, intent, result };
  } finally {
    // A crash, uncertain cleanup or unpublished result keeps the lock for inspection.
    if (!startedIntent || resultPublished && cleanupConfirmed) await fs.unlink(lockFile);
  }
}
