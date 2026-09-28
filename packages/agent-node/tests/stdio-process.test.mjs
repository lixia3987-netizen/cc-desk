import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProcessSupervisor, assertStdioEnvironmentName, validateStdioEnvironment, linuxLiveProcesses } from '../dist/process-supervisor.js';

async function fixture(t, options = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'native-stdio-中文 '));
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 25, ...options });
  t.after(async () => {
    await supervisor.dispose();
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return {
    cwd, supervisor,
    request: (code, onStdout = () => {}) => ({ executable: process.execPath, argv: ['-e', code], cwd, onStdout }),
  };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function collector() {
  let output = '';
  const waiters = [];
  return {
    onStdout(data) {
      output += data.toString('utf8');
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].predicate(output)) waiters.splice(i, 1)[0].resolve(output);
    },
    get text() { return output; },
    until(predicate) {
      if (predicate(output)) return Promise.resolve(output);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Fixture output was not received.')), 10_000);
        waiters.push({ predicate, resolve: value => { clearTimeout(timer); resolve(value); } });
      });
    },
  };
}

test('stdio mappings share strict target checks and bounded explicit values', () => {
  for (const name of ['TOKEN', 'CUSTOM_URL', '_PRIVATE_KEY', 'someApiKey']) assert.doesNotThrow(() => assertStdioEnvironmentName(name));
  for (const name of ['PATH', 'Path', 'HOME', 'LANG', 'TEMP', 'NODE_OPTIONS', 'node_options', 'NODE_V8_COVERAGE',
    'BASH_ENV', 'ENV', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'RUBYOPT', 'PERL5OPT', 'NPM_CONFIG_PREFIX',
    'DOTNET_STARTUP_HOOKS', 'COMPLUS_VERSION', 'ELECTRON_RUN_AS_NODE', 'PSModulePath', 'JAVA_TOOL_OPTIONS',
    '__proto__', 'constructor', 'prototype', 'INVALID-KEY', '', 'A'.repeat(129)]) {
    assert.throws(() => assertStdioEnvironmentName(name), /invalid or reserved/, name);
  }
  assert.deepEqual(validateStdioEnvironment({ TOKEN: 'value', EMPTY: '' }), { TOKEN: 'value', EMPTY: '' });
  assert.throws(() => validateStdioEnvironment({ Token: 'a', TOKEN: 'b' }), /Duplicate/);
  assert.throws(() => validateStdioEnvironment({ TOKEN: 'a\0b' }), /value/);
  assert.throws(() => validateStdioEnvironment({ TOKEN: 'x'.repeat(8193) }), /value/);
  assert.throws(() => validateStdioEnvironment({ A: 'x'.repeat(8192), B: 'x'.repeat(8192), C: 'x'.repeat(8192), D: 'x'.repeat(8192) }), /size limit/);
  assert.throws(() => validateStdioEnvironment(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`K${i}`, 'v']))), /mapping/);
  assert.throws(() => validateStdioEnvironment(Object.create({ TOKEN: 'inherited' })), /mapping/);
});

test('stdio stays alive across command timeouts and exchanges direct pipe input', async t => {
  const { supervisor, request } = await fixture(t, { defaultTimeoutMs: 50 });
  const output = collector();
  const handle = await supervisor.openStdio('roundtrip', request(String.raw`
    process.stdin.on('data', data => process.stdout.write(data));
    process.stdin.on('end', () => process.exit(0));
  `, output.onStdout));
  await wait(100);
  assert.equal(supervisor.has('roundtrip'), true);
  await handle.write('first 中文\n');
  await output.until(value => value.endsWith('first 中文\n'));
  await handle.write(Buffer.from('second\n'));
  await output.until(value => value.endsWith('second\n'));
  await handle.endInput();
  const result = await handle.closed;
  assert.equal(result.exitCode, 0);
  assert.equal(result.cleanup, 'released', result.error);
  assert.equal(supervisor.activeCount, 0);
  assert.deepEqual(Object.keys(result).sort(), ['cancelled', 'cleanup', 'exitCode', 'signal']);
});

test('stdio explicit argv uses no shell, and only the server receives mapped secrets', async t => {
  const secret = 'explicit-server-secret';
  const ambient = 'ambient-provider-secret';
  const { supervisor, cwd, request } = await fixture(t, {
    environment: { ...process.env, HOME: secret, OPENAI_API_KEY: ambient, NODE_OPTIONS: '--require=/missing-hook' },
  });
  const output = collector();
  const command = request(String.raw`
    process.stdout.write(JSON.stringify({ args:process.argv.slice(1), env:process.env, cwd:process.cwd() })+'\n');
    process.stdin.resume();
  `, output.onStdout);
  command.argv.push('$(echo unsafe)', 'x; echo unsafe', 'quoted " arg');
  command.environment = { MCP_TOKEN: secret, someApiKey: 'another-explicit-value' };
  const handle = await supervisor.openStdio('environment', command, undefined, [ambient]);
  const actual = JSON.parse(await output.until(value => value.endsWith('\n')));
  assert.deepEqual(actual.args, command.argv.slice(2));
  assert.equal(await realpath(actual.cwd), await realpath(cwd));
  assert.equal(actual.env.MCP_TOKEN, secret);
  assert.equal(actual.env.someApiKey, 'another-explicit-value');
  assert.equal(actual.env.OPENAI_API_KEY, undefined);
  assert.equal(actual.env.NODE_OPTIONS, undefined);
  assert.equal(actual.env.HOME, undefined);
  assert.equal(actual.env.NODE_V8_COVERAGE, '');
  const record = [...supervisor.records][0];
  assert.equal(Object.values(record.environment).some(value => typeof value === 'string' && value.includes(secret)), false);
  assert.equal(record.environment.MCP_TOKEN, undefined, 'Windows helper and guardian baseline never receive explicit mappings');
  assert.equal((await handle.close()).cleanup, 'released');
});

test('normal close gives the server time to handle stdin EOF before termination', async t => {
  const { supervisor, request, cwd } = await fixture(t);
  const marker = path.join(cwd, 'eof-observed');
  const output = collector();
  const handle = await supervisor.openStdio('eof', request(String.raw`
    process.stdin.resume();
    process.stdin.on('end', () => {
      require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'EOF');
      process.exit(0);
    });
    process.stdout.write('ready');
  `, output.onStdout));
  await output.until(value => value === 'ready');
  const result = await handle.close();
  assert.equal(await readFile(marker, 'utf8'), 'EOF');
  assert.equal(result.exitCode, 0);
  assert.equal(result.cleanup, 'released');
});

test('stdio bounds input before queueing and rejects writes after release', async t => {
  const { supervisor, request } = await fixture(t);
  const output = collector();
  const handle = await supervisor.openStdio('input', { ...request('process.stdin.on("data", data => process.stdout.write(data))', output.onStdout), maxInputBytes: 4 });
  await assert.rejects(handle.write('12345'), /byte limit/);
  const first = handle.write('1234');
  await assert.rejects(handle.write('x'), /byte limit/);
  await first;
  await output.until(value => value === '1234');
  const closing = handle.close();
  assert.equal(handle.close(), closing);
  assert.equal((await closing).cleanup, 'released');
  await assert.rejects(handle.write('x'), /closed/);
});

test('stderr is drained without retention or exposure during a long lived session', async t => {
  const { supervisor, request } = await fixture(t);
  const output = collector();
  const handle = await supervisor.openStdio('stderr', request(String.raw`
    process.stderr.write('private-stderr-'.repeat(100000), () => process.stdout.write('drained\n'));
    process.stdin.resume();
  `, output.onStdout));
  await output.until(value => value === 'drained\n');
  const record = [...supervisor.records][0];
  assert.equal(record.stderr.length, 0);
  assert.equal(record.stdout.length, 0);
  assert.equal(record.capturedBytes, 0);
  const result = await handle.close();
  assert.equal(result.cleanup, 'released');
  assert.equal(JSON.stringify(result).includes('private-stderr'), false);
  assert.equal('stderr' in result, false);
});

test('consumer failure closes the tree and exposes only a fixed error', async t => {
  const { supervisor, request } = await fixture(t);
  const handle = await supervisor.openStdio('consumer', request(String.raw`setTimeout(() => process.stdout.write('payload'), 30); setInterval(() => {},1000)`, () => {
    throw new Error('private-consumer-path');
  }));
  const result = await handle.closed;
  assert.equal(result.cleanup, 'released');
  assert.match(result.error, /output could not be consumed/);
  assert.equal(JSON.stringify(result).includes('private-consumer-path'), false);
  assert.equal(supervisor.has('consumer'), false);
});

test('owner revocation closes active stdio and prevents reusing the released owner', async t => {
  const { supervisor, request } = await fixture(t);
  const handle = await supervisor.openStdio('revoked', request('process.stdin.resume()'));
  await supervisor.stopOwner('revoked');
  const result = await handle.closed;
  assert.equal(result.cleanup, 'released');
  assert.equal(result.cancelled, true);
  assert.equal(supervisor.activeCount, 0);
  await assert.rejects(supervisor.openStdio('revoked', request('process.stdin.resume()')), /released/);
});

test('pre-abort never launches and live abort waits for tree release', async t => {
  const { supervisor, request, cwd } = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  const marker = path.join(cwd, 'forbidden-marker');
  await assert.rejects(supervisor.openStdio('preabort', request(String.raw`require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`), controller.signal), /cancelled/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  assert.equal(supervisor.activeCount, 0);
  const active = new AbortController();
  const handle = await supervisor.openStdio('abort', request('process.stdin.resume()'), active.signal);
  active.abort();
  const result = await handle.closed;
  assert.equal(result.cancelled, true);
  assert.equal(result.cleanup, 'released');
  assert.equal(supervisor.activeCount, 0);
});

test('stdio startup errors release pipes before rejection and do not expose path or argv', async t => {
  const { supervisor, request, cwd } = await fixture(t);
  await assert.rejects(supervisor.openStdio('missing', { ...request(''), executable: path.join(cwd, 'private-missing-path'), argv: ['private-arg'] }), error => {
    assert.match(error.message, /Unable to start/);
    assert.equal(error.message.includes('private'), false);
    assert.equal(error.cleanupUnconfirmed, undefined);
    return true;
  });
  assert.equal(supervisor.activeCount, 0);
  for (const executable of ['node', path.join(cwd, 'script.cmd'), path.join(cwd, 'script.BAT')]) {
    await assert.rejects(supervisor.openStdio('invalid', { ...request(''), executable }), /absolute executable/);
  }
  await assert.rejects(supervisor.openStdio('invalid', { ...request(''), argv: Array(129).fill('x') }), /bounded/);
  await assert.rejects(supervisor.openStdio('invalid', { ...request(''), environment: { NODE_OPTIONS: 'x' } }), /reserved/);
  assert.equal(supervisor.activeCount, 0);
});

test('stdio cleanup failure retains owner occupancy and close can retry the physical barrier', async t => {
  const { supervisor, request } = await fixture(t);
  const handle = await supervisor.openStdio('retained', request('process.stdin.resume()'));
  const releaseTree = supervisor.releaseTree;
  supervisor.releaseTree = async () => false;
  try {
    const result = await handle.close();
    assert.equal(result.cleanup, 'cleanup_failed');
    assert.equal(supervisor.has('retained'), true);
    assert.equal(supervisor.activeCount, 1);
    await assert.rejects(handle.write('x'), /closed/);
  } finally {
    supervisor.releaseTree = releaseTree;
  }
  assert.equal((await handle.close()).cleanup, 'released');
  assert.equal(supervisor.activeCount, 0);
});

test('startup rejection reports unconfirmed cleanup and a later owner cleanup can recover', async t => {
  const { supervisor, request, cwd } = await fixture(t);
  const releaseTree = supervisor.releaseTree;
  supervisor.releaseTree = async () => false;
  try {
    await assert.rejects(supervisor.openStdio('failed-start', { ...request(''), executable: path.join(cwd, 'missing') }), error => error.cleanupUnconfirmed === true);
    assert.equal(supervisor.has('failed-start'), true);
  } finally {
    supervisor.releaseTree = releaseTree;
  }
  await supervisor.stopOwner('failed-start');
  assert.equal(supervisor.activeCount, 0);
});

test('natural server exit does not release an inherited descendant until the tree is gone', { skip: process.platform !== 'linux' }, async t => {
  const { supervisor, request, cwd } = await fixture(t);
  const ready = path.join(cwd, 'child-ready');
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)`;
  const output = collector();
  const handle = await supervisor.openStdio('descendant', request(String.raw`
    const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});
    child.unref();
    const timer=setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(ready)})){clearInterval(timer);process.stdout.write(String(child.pid)+'\n');}},10);
  `, output.onStdout));
  const pid = Number(await output.until(value => value.endsWith('\n')));
  const result = await handle.closed;
  assert.equal(result.exitCode, 0);
  assert.equal(result.cleanup, 'released', result.error);
  assert.equal((await linuxLiveProcesses({ pid })).length, 0);
  assert.equal(supervisor.has('descendant'), false);
});
