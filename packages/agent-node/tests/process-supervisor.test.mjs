import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProcessSupervisor, commandEnvironment, linuxLiveProcesses } from '../dist/process-supervisor.js';

async function fixture(t, options = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'native-command-中文 '));
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 25, ...options });
  t.after(async () => { await supervisor.dispose(); await rm(cwd, { recursive: true, force: true }); });
  return { cwd, supervisor, command: code => ({ executable: process.execPath, argv: ['-e', code], cwd }) };
}

async function isLive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      return (await linuxLiveProcesses({ pid })).some(item => item.pid === pid);
    }
    return true;
  } catch (error) {
    if (['ESRCH', 'ENOENT'].includes(error.code)) return false;
    throw error;
  }
}

async function eventually(read, predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('Condition did not become true within the deadline.');
}

test('executes explicit argv and cwd without a shell and reports the actual exit code', async t => {
  const { supervisor, cwd, command } = await fixture(t);
  const request = command('console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(1) })); console.error("err"); process.exitCode = 7;');
  request.argv.push('a b', '$(echo unsafe)', 'x; echo unsafe', '"quoted"');
  const result = await supervisor.run('run:1', request);
  assert.equal(result.exitCode, 7);
  assert.deepEqual(JSON.parse(result.stdout), { cwd, args: request.argv.slice(2) });
  assert.equal(result.stderr, 'err\n');
  assert.equal(result.cleanup, 'released');
  assert.equal(result.cancelled, false);
  assert.equal(supervisor.activeCount, 0);
});

test('copies only the operational environment allowlist, never secrets or startup hooks', async t => {
  const environment = {
    ...process.env, OPENAI_API_KEY: 'provider-secret-sentinel', ANTHROPIC_API_KEY: 'other-secret',
    NATIVE_TEST_KEY: 'arbitrary-secret', NODE_OPTIONS: '--require=/missing-private-startup-hook',
    BASH_ENV: '/private/startup', npm_config_token: 'npm-private-token',
  };
  assert.equal(commandEnvironment(environment).OPENAI_API_KEY, undefined);
  const { supervisor, command } = await fixture(t, { environment });
  const result = await supervisor.run('env', command('console.log(JSON.stringify(process.env))'));
  assert.equal(result.exitCode, 0);
  const actual = JSON.parse(result.stdout);
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NATIVE_TEST_KEY', 'NODE_OPTIONS', 'BASH_ENV', 'npm_config_token', 'ELECTRON_RUN_AS_NODE']) {
    assert.equal(actual[key], undefined, key);
  }
  assert.ok(actual.PATH || actual.Path);
});

test('bounds combined stdout/stderr while continuing to drain large output', async t => {
  const { supervisor, command } = await fixture(t);
  const result = await supervisor.run('output', {
    ...command('process.stdout.write("o".repeat(256 * 1024)); process.stderr.write("e".repeat(256 * 1024));'),
    maxOutputBytes: 1_024,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.cleanup, 'released');
  assert.equal(result.stdout.length + result.stderr.length, 1_024);
  assert.equal(result.outputBytes, 512 * 1_024);
  assert.equal(result.truncated, true);
});

test('per-run resolved secrets are removed even from operational allowlisted variables', async t => {
  const secret = 'credential-value-sentinel';
  const { supervisor, command } = await fixture(t, { environment: { ...process.env, LANG: secret, HOME: secret, PATH: `prefix-${secret}` } });
  const result = await supervisor.run('credential-run', command('process.stdout.write(JSON.stringify(process.env))'), undefined, [secret]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.includes(secret), false);
  const variables = JSON.parse(result.stdout);
  for (const key of ['LANG', 'HOME', 'PATH']) assert.equal(variables[key], undefined);
  const missingPath = await supervisor.run('credential-path', { ...command(''), executable: 'node' }, undefined, [secret]);
  assert.match(missingPath.error, /absolute executable/);
  assert.equal(missingPath.cleanup, 'released');
  const independent = await supervisor.run('unrelated-run', command('process.stdout.write(process.env.LANG || "")'));
  assert.equal(independent.stdout, secret, 'scrubbing is bound to this run, not mutable global state');
});

test('bounds timeout and waits for the stopped process before returning', async t => {
  const { supervisor, command } = await fixture(t);
  const result = await supervisor.run('timeout', {
    ...command('setInterval(() => {}, 10_000)'), timeoutMs: 100,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.cleanup, 'released');
  assert.equal(supervisor.has('timeout'), false);
});

test('truncated multibyte and invalid output remain within the byte budget', async t => {
  const { supervisor, command } = await fixture(t);
  const unicode = await supervisor.run('unicode', {
    ...command('process.stdout.write("中文")'), maxOutputBytes: 4,
  });
  assert.equal(unicode.stdout, '中');
  assert.equal(unicode.truncated, true);
  const invalid = await supervisor.run('invalid-utf8', {
    ...command('process.stdout.write(Buffer.from([255,255,255,255,255]))'), maxOutputBytes: 4,
  });
  assert.ok(Buffer.byteLength(invalid.stdout) <= 4);
  assert.equal(invalid.truncated, true);
});

test('natural parent exit cleans a descendant with independent stdio', async t => {
  const { supervisor, cwd, command } = await fixture(t);
  const ready = path.join(cwd, 'descendant-ready');
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
  const result = await supervisor.run('natural', command(`
    const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' });
    child.unref();
    const wait = setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(ready)})) { clearInterval(wait); } }, 10);
  `));
  const pid = Number(await readFile(ready, 'utf8'));
  assert.equal(result.exitCode, 0);
  assert.equal(result.cleanup, 'released');
  assert.equal(await isLive(pid), false);
  assert.equal(supervisor.activeCount, 0);
});

test('worker owner release kills descendants, waits for pipes, and revokes further launches', async t => {
  const { supervisor, cwd, command } = await fixture(t);
  const ready = path.join(cwd, 'owner-descendant-ready');
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => process.stdout.write('alive'), 10);`;
  const run = supervisor.run('worker-generation-1', command(`
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 1, 2] });
    setInterval(() => {}, 1000);
  `));
  const pid = await eventually(async () => {
    try { return Number(await readFile(ready, 'utf8')); } catch { return null; }
  }, value => value !== null);
  assert.equal(await isLive(pid), true, 'the PID proof must identify the real live descendant');
  assert.equal(supervisor.has('worker-generation-1'), true);
  await supervisor.stopOwner('worker-generation-1');
  const result = await run;
  assert.equal(result.cancelled, true);
  assert.equal(result.cleanup, 'released');
  assert.equal(await isLive(pid), false);
  assert.equal(supervisor.activeCount, 0);
  await assert.rejects(supervisor.run('worker-generation-1', command('process.exit(0)')), /released/);
});

test('AbortSignal cancels and an already aborted signal never executes a command', async t => {
  const { supervisor, command } = await fixture(t);
  const controller = new AbortController();
  const run = supervisor.run('abort', command('setInterval(() => {}, 1000)'), controller.signal);
  controller.abort();
  const result = await run;
  assert.equal(result.cancelled, true);
  assert.equal(result.cleanup, 'released');
  const preCancelled = await supervisor.run('already-aborted', command('throw new Error("must not run")'), controller.signal);
  assert.equal(preCancelled.cancelled, true);
  assert.equal(preCancelled.stderr, '');
  assert.equal(supervisor.activeCount, 0);
});

test('invalid commands and excess budgets are rejected before launch; missing executable is explicit', async t => {
  const { supervisor, cwd, command } = await fixture(t);
  await assert.rejects(supervisor.run('bad', { executable: 'node', argv: [], cwd: '.' }), /absolute cwd/);
  await assert.rejects(supervisor.run('bad', { ...command(''), timeoutMs: 120_001 }), /timeoutMs/);
  await assert.rejects(supervisor.run('bad', { ...command(''), maxOutputBytes: 1_048_577 }), /maxOutputBytes/);
  const result = await supervisor.run('missing', { executable: path.join(cwd, 'missing-program'), argv: [], cwd });
  assert.match(result.error, /not found/);
  assert.equal(result.cleanup, 'released');
  assert.equal(result.exitCode, null);
});

test('cleanup failure retains owner occupancy and retry releases it', { skip: process.platform === 'win32' }, async t => {
  const { supervisor, command } = await fixture(t, { cleanupTimeoutMs: 150 });
  const originalKill = process.kill;
  const run = supervisor.run('failed-cleanup', command('setInterval(() => {}, 1000)'));
  process.kill = function (pid, signal) {
    if (pid < 0) throw Object.assign(new Error('Injected group permission failure'), { code: 'EPERM' });
    return originalKill.call(process, pid, signal);
  };
  try {
    await assert.rejects(supervisor.stopOwner('failed-cleanup'), /remains occupied/);
    const result = await run;
    assert.equal(result.cleanup, 'cleanup_failed');
    assert.equal(supervisor.has('failed-cleanup'), true);
    assert.equal(supervisor.activeCount, 1);
  } finally {
    process.kill = originalKill;
    await supervisor.stopOwner('failed-cleanup');
  }
  assert.equal(supervisor.activeCount, 0);
});
