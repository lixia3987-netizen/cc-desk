import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { electronLaunchArgs } from './helpers/electron-launch';

const root = fileURLToPath(new URL('../', import.meta.url));
const runner = path.join(root, 'scripts', 'run-desktop-tests.mjs');
const require = createRequire(import.meta.url);

test('desktop launch requires X11 on Linux and preserves application arguments on every platform', () => {
  const args = ['--user-data-dir=/tmp/profile with spaces'];
  assert.throws(() => electronLaunchArgs(args, 'linux', ''), /npm run test:e2e/);
  assert.throws(() => electronLaunchArgs(args, 'linux', '  '), /X11 DISPLAY/);
  assert.deepEqual(electronLaunchArgs(args, 'linux', ':123'), [...args, '--no-sandbox', '--ozone-platform=x11', '--disable-gpu']);
  for (const platform of ['win32', 'darwin'] as const) assert.deepEqual(electronLaunchArgs(args, platform, ''), args);
  assert.deepEqual(args, ['--user-data-dir=/tmp/profile with spaces']);
});

test('desktop runner preserves filter arguments, repository cwd and Xvfb child exit status', { skip: process.platform !== 'linux' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-desk-display-'));
  try {
    const log = path.join(directory, 'args.json');
    fs.writeFileSync(path.join(directory, 'xvfb-run'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));process.exit(23);\n`, { mode: 0o755 });
    const filters = ['tests/context-commands.spec.ts', '--grep', 'report with spaces.*[x]', '--workers=1'];
    const result = spawnSync(process.execPath, [runner, ...filters], {
      cwd: directory, env: { ...process.env, PATH: directory, DISPLAY: '' }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 23, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8')), {
      cwd: root.replace(/[\\/]$/, ''),
      args: ['-a', '-s', '-screen 0 1920x1080x24 -nolisten tcp', process.execPath, require.resolve('@playwright/test/cli'), 'test', ...filters],
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('desktop runner reports missing Xvfb with actionable installation instructions', { skip: process.platform !== 'linux' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-desk-display-'));
  try {
    const result = spawnSync(process.execPath, [runner, '--list'], {
      env: { ...process.env, PATH: directory, DISPLAY: '' }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /xvfb-run/);
    assert.match(result.stderr, /apt-get install xvfb xauth/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('desktop runner forwards Playwright list selection directly when DISPLAY is supplied', () => {
  const result = spawnSync(process.execPath, [runner, 'tests/context-commands.spec.ts', '--list'], {
    env: { ...process.env, DISPLAY: ':fixture-no-window-needed' }, encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Total: 4 tests in 1 file/);
  assert.doesNotMatch(result.stdout, /desktop\.spec\.ts:/);
});

test('desktop runner signals its isolated wrapper and descendant without signalling unrelated processes', { skip: process.platform !== 'linux', timeout: 15_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-desk-signal-'));
  const identities = path.join(directory, 'children.json'), ready = path.join(directory, 'ready');
  const signals = path.join(directory, 'signals'), siblingReady = path.join(directory, 'sibling-ready');
  const siblingSignal = path.join(directory, 'sibling-signal');
  const descendant = `
    const fs = require('node:fs');
    process.on('SIGTERM', () => { fs.appendFileSync(${JSON.stringify(signals)}, 'descendant\\n'); process.exit(0); });
    fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
    setInterval(() => {}, 1000);
  `;
  fs.writeFileSync(path.join(directory, 'xvfb-run'), `#!${process.execPath}\n
    const fs = require('node:fs'), { spawn } = require('node:child_process');
    let terminating = false;
    process.on('SIGTERM', () => { terminating = true; fs.appendFileSync(${JSON.stringify(signals)}, 'wrapper\\n'); });
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' });
    fs.writeFileSync(${JSON.stringify(identities)}, JSON.stringify({ wrapper: process.pid, descendant: child.pid }));
    child.on('close', () => process.exit(terminating ? 143 : 1));
  `, { mode: 0o755 });
  const sibling = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(siblingSignal)}, 'unexpected signal'));
    fs.writeFileSync(${JSON.stringify(siblingReady)}, 'ready');
    setInterval(() => {}, 1000);
  `], { stdio: 'ignore' });
  // Isolate the fixture runner too, so a regression cannot signal the test host.
  const running = spawn(process.execPath, [runner, '--list'], {
    env: { ...process.env, PATH: directory, DISPLAY: '' }, stdio: 'ignore', detached: true,
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    running.once('error', reject);
    running.once('close', (code, signal) => resolve({ code, signal }));
  });
  let childIds: { wrapper: number; descendant: number } | undefined;
  let timeout: NodeJS.Timeout | undefined;
  const killOwned = (pid: number | undefined) => {
    if (!pid) return;
    try { process.kill(pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  try {
    const deadline = Date.now() + 5000;
    while (![identities, ready, siblingReady].every(file => fs.existsSync(file))) {
      if (Date.now() > deadline) throw new Error('Signal fixtures did not become ready');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    childIds = JSON.parse(fs.readFileSync(identities, 'utf8'));
    assert.ok(childIds!.wrapper !== process.pid && childIds!.wrapper !== running.pid);
    assert.doesNotThrow(() => process.kill(-childIds!.wrapper, 0), 'The wrapper must own a separate process group');
    running.kill('SIGTERM');
    const outcome = await Promise.race([exited, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Wrapper or descendant did not receive SIGTERM')), 5000);
    })]);
    assert.deepEqual(outcome, { code: 143, signal: null });
    assert.deepEqual(fs.readFileSync(signals, 'utf8').trim().split('\n').sort(), ['descendant', 'wrapper']);
    assert.equal(fs.existsSync(siblingSignal), false);
    assert.equal(sibling.exitCode, null);
    assert.doesNotThrow(() => process.kill(sibling.pid!, 0));
  } finally {
    if (timeout) clearTimeout(timeout);
    if (!childIds && fs.existsSync(identities)) childIds = JSON.parse(fs.readFileSync(identities, 'utf8'));
    // Only fixture-owned IDs are eligible for cleanup, including the pre-fix failure path.
    killOwned(childIds?.descendant); killOwned(childIds?.wrapper);
    if (running.exitCode === null && running.signalCode === null) killOwned(running.pid);
    killOwned(sibling.pid);
    await exited.catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
