import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { ProcessSupervisor, commandEnvironment } from '../dist/process-supervisor.js';

function fixture({ failedSpawn = false, osUserProfile } = {}) {
  const originalSpawn = childProcess.spawn;
  const originalUserInfo = os.userInfo;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const messages = [];
  const helpers = [];
  const makeChild = pid => {
    const child = new EventEmitter();
    child.pid = pid; child.connected = true; child.kills = 0;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.kills++; return true; };
    child.send = (message, callback) => { messages.push(message); callback?.(null); };
    child.finish = () => {
      child.connected = false;
      child.emit('exit', 1, null);
      child.stdout.end(); child.stderr.end(); child.stdin.end();
      child.emit('close', 1, null);
    };
    return child;
  };
  const guardian = makeChild(failedSpawn ? undefined : 321);
  if (osUserProfile !== undefined) os.userInfo = () => ({ uid: -1, gid: -1, username: 'fixture', shell: null,
    homedir: typeof osUserProfile === 'function' ? osUserProfile() : osUserProfile });
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  childProcess.spawn = (_executable, argv) => {
    if (!helpers.length) {
      helpers.push(guardian);
      queueMicrotask(() => failedSpawn ? guardian.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' })) : guardian.emit('spawn'));
      return guardian;
    }
    const helper = makeChild(322);
    helper.nonce = argv.at(-1).match(/::Run\(321,'([a-f0-9]{64})'/)?.[1];
    assert.ok(helper.nonce);
    helpers.push(helper);
    return helper;
  };
  syncBuiltinESMExports();
  return {
    guardian, helpers, messages,
    restore() {
      os.userInfo = originalUserInfo;
      childProcess.spawn = originalSpawn; syncBuiltinESMExports();
      Object.defineProperty(process, 'platform', originalPlatform);
      for (const helper of helpers) {
        helper.stdin.destroy(); helper.stdout.destroy(); helper.stderr.destroy();
      }
    },
  };
}

test('Windows environment deduplicates names and explicitly masks every libuv host fallback', () => {
  const profile = 'C:\\OS-test-profile';
  const f = fixture({ osUserProfile: profile });
  try {
    const environment = commandEnvironment({ Path: 'credential-sentinel', PATH: 'unrelated-path', SystemRoot: 'C:\\Windows', USERNAME: 'private-identity' }, ['credential-sentinel']);
    assert.equal(environment.PATH, '', 'a filtered duplicate cannot restore executable lookup');
    assert.equal(environment.SYSTEMROOT, 'C:\\Windows');
    assert.equal(environment.Path, undefined);
    assert.equal(environment.SystemRoot, undefined);
    assert.equal(environment.USERPROFILE, profile, 'the sole required directory comes from OS user records');
    for (const key of ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'TEMP', 'USERDOMAIN', 'USERNAME', 'WINDIR']) assert.equal(environment[key], '', key);
    assert.equal(environment.NODE_V8_COVERAGE, '');
    assert.equal(JSON.stringify(environment).includes('credential-sentinel'), false);
    assert.equal(JSON.stringify(environment).includes('private-identity'), false);
  } finally { f.restore(); }
});

test('Windows missing, empty or filtered USERPROFILE uses only the OS directory and preserves the other guards', () => {
  const profile = 'D:\\OS-accounts\\safe-user';
  const f = fixture({ osUserProfile: profile });
  try {
    for (const supplied of [undefined, '', 'private-credential-profile']) {
      const environment = commandEnvironment({ SystemRoot: 'C:\\Windows', ...(supplied === undefined ? {} : { USERPROFILE: supplied }), PSModulePath: 'private-module', NODE_OPTIONS: 'private-loader' }, ['private-credential']);
      assert.equal(environment.USERPROFILE, profile);
      assert.equal(environment.PSMODULEPATH, undefined);
      assert.equal(environment.NODE_OPTIONS, undefined);
      assert.equal(environment.USERNAME, '');
      assert.equal(environment.USERDOMAIN, '');
      assert.equal(environment.HOMEPATH, '');
      assert.equal(environment.HOMEDRIVE, '');
      assert.equal(environment.WINDIR, '');
      assert.equal(JSON.stringify(environment).includes('private-credential'), false);
    }
    const explicit = commandEnvironment({ SystemRoot: 'C:\\Windows', USERPROFILE: 'E:\\explicit-profile' });
    assert.equal(explicit.USERPROFILE, 'E:\\explicit-profile');
  } finally { f.restore(); }
});

test('Windows OS profile fallback still rejects secrets, invalid directories and failed OS queries', () => {
  for (const profile of ['C:\\private-credential-user', 'relative-profile', '\\\\server\\profile', 'C:relative', 'C:\\profile\n', () => { throw new Error('OS user query failed'); }]) {
    const f = fixture({ osUserProfile: profile });
    try {
      const environment = commandEnvironment({ SystemRoot: 'C:\\Windows', USERPROFILE: 'private-credential-supplied' }, ['private-credential']);
      assert.equal(environment.USERPROFILE, '');
      assert.equal(JSON.stringify(environment).includes('private-credential'), false);
    } finally { f.restore(); }
  }
});

test('Windows profile initialization cannot restore an unapproved ambient home directory', () => {
  const profile = 'C:\\OS-accounts\\safe-user';
  const originalHomedir = os.homedir;
  const f = fixture({ osUserProfile: profile });
  os.homedir = () => 'C:\\private-credential-ambient';
  syncBuiltinESMExports();
  try {
    const environment = commandEnvironment({ SystemRoot: 'C:\\Windows' }, ['private-credential']);
    assert.equal(environment.USERPROFILE, profile);
    assert.equal(JSON.stringify(environment).includes('private-credential'), false);
  } finally { os.homedir = originalHomedir; f.restore(); }
});

test('a guardian spawn error with no PID still waits for Node close without requiring an exit event', async () => {
  const f = fixture({ failedSpawn: true });
  const supervisor = new ProcessSupervisor({ environment: { SystemRoot: 'C:\\Windows' }, cleanupTimeoutMs: 200, terminationGraceMs: 1 });
  try {
    const running = supervisor.run('spawn-error', { executable: process.execPath, argv: [], cwd: process.cwd() });
    let settled = false;
    void running.then(() => { settled = true; });
    await tick();
    assert.equal(settled, false);
    assert.equal(supervisor.has('spawn-error'), true);
    assert.equal(f.helpers.length, 1, 'no containment helper is started for a failed guardian spawn');
    assert.equal(f.guardian.kills, 0);
    f.guardian.stdout.end(); f.guardian.stderr.end();
    f.guardian.emit('close', -2, null);
    const result = await running;
    assert.equal(result.cleanup, 'released', result.error);
    assert.match(result.error, /Unable to start/);
    assert.equal(supervisor.activeCount, 0);
  } finally {
    for (const helper of f.helpers) helper.finish();
    await supervisor.dispose();
    f.restore();
  }
});

test('cancelling Windows Job preparation never launches and waits for both physical close barriers', async () => {
  const f = fixture();
  const supervisor = new ProcessSupervisor({ environment: { SystemRoot: 'C:\\Windows' }, cleanupTimeoutMs: 200, terminationGraceMs: 1 });
  const controller = new AbortController();
  try {
    const running = supervisor.run('preparing', { executable: process.execPath, argv: [], cwd: process.cwd() }, controller.signal);
    let settled = false;
    void running.then(() => { settled = true; });
    await tick();
    const helper = f.helpers[1];
    helper.stdout.write(JSON.stringify({ type: 'held', nonce: helper.nonce }) + '\n');
    await tick();
    assert.equal(f.messages[0].type, 'challenge');
    controller.abort();
    await tick();
    assert.ok(helper.kills > 0);
    assert.ok(f.guardian.kills > 0);
    // 取消前缓冲的响应不能授权延迟到达的启动操作。
    f.guardian.emit('message', { type: 'challenge-response', nonce: helper.nonce });
    helper.stdout.write('{"type":"ready"}\n');
    await tick();
    assert.equal(f.messages.some(message => message.type === 'launch'), false);
    assert.equal(settled, false);
    f.guardian.finish();
    await tick();
    assert.equal(settled, false, 'guardian close cannot replace helper close');
    helper.finish();
    const result = await running;
    assert.equal(result.cancelled, true);
    assert.equal(result.cleanup, 'released', result.error);
    assert.equal(supervisor.activeCount, 0);
  } finally {
    for (const helper of f.helpers) helper.finish();
    await supervisor.dispose();
    f.restore();
  }
});

test('failed Windows preparation retains occupancy until the outstanding helper actually closes', async () => {
  const f = fixture();
  const supervisor = new ProcessSupervisor({ environment: { SystemRoot: 'C:\\Windows' }, cleanupTimeoutMs: 40, terminationGraceMs: 1 });
  const controller = new AbortController();
  try {
    const running = supervisor.run('preparing', { executable: process.execPath, argv: [], cwd: process.cwd() }, controller.signal);
    await tick();
    controller.abort();
    f.guardian.finish();
    const result = await running;
    assert.equal(result.cleanup, 'cleanup_failed');
    assert.equal(result.cleanupDiagnostic.phase, 'windows_helper_release');
    assert.equal(supervisor.has('preparing'), true);
    assert.equal(f.messages.some(message => message.type === 'launch'), false);
    f.helpers[1].finish();
    await supervisor.stopOwner('preparing');
    assert.equal(supervisor.activeCount, 0);
  } finally {
    for (const helper of f.helpers) helper.finish();
    await supervisor.dispose();
    f.restore();
  }
});

test('a command handle stopped during Windows preparation settles startup only after physical cleanup', async () => {
  const f = fixture();
  const supervisor = new ProcessSupervisor({ environment: { SystemRoot: 'C:\\Windows' }, cleanupTimeoutMs: 200, terminationGraceMs: 1 });
  try {
    const handle = supervisor.start('handle-preparing', { executable: process.execPath, argv: [], cwd: process.cwd() });
    let startedSettled = false;
    void handle.started.then(() => { startedSettled = true; });
    await tick();
    const helper = f.helpers[1];
    const stopped = handle.stop();
    await tick();
    assert.equal(handle.snapshot().started, false);
    assert.equal(handle.snapshot().stopping, true);
    assert.equal(handle.snapshot().settled, false);
    assert.equal(startedSettled, false);
    assert.equal(f.messages.some(message => message.type === 'launch'), false);
    f.guardian.finish();
    await tick();
    assert.equal(startedSettled, false, 'guardian close cannot replace helper close');
    helper.finish();
    assert.equal((await stopped).cleanup, 'released');
    assert.equal(await handle.started, false);
    assert.equal((await handle.closed).cancelled, true);
    assert.equal(supervisor.has('handle-preparing'), false);
  } finally {
    for (const helper of f.helpers) helper.finish();
    await supervisor.dispose();
    f.restore();
  }
});

for (const loss of ['invalid output', 'failed result', 'helper exit']) {
  test(`Windows Job readiness followed by ${loss} before the await resumes never authorizes launch`, async () => {
    const f = fixture();
    const supervisor = new ProcessSupervisor({ environment: { SystemRoot: 'C:\\Windows' }, cleanupTimeoutMs: 200, terminationGraceMs: 1 });
    try {
      const running = supervisor.run('lost-ready', { executable: process.execPath, argv: [], cwd: process.cwd() });
      await tick();
      const helper = f.helpers[1];
      helper.stdout.write(JSON.stringify({ type: 'held', nonce: helper.nonce }) + '\n');
      await tick();
      f.guardian.emit('message', { type: 'challenge-response', nonce: helper.nonce });
      await tick();
      assert.equal(f.messages.some(message => message.type === 'launch'), false);
      if (loss === 'invalid output') {
        // 单次数据回调先完成 ready，再使同一 Job 失效，发生在监督器的
        // await 续接有机会发送启动消息之前。
        helper.stdout.write('{"type":"ready"}\ninvalid-json\n');
      } else if (loss === 'failed result') {
        helper.stdout.write('{"type":"ready"}\n' + JSON.stringify({
          type: 'result', released: false, stage: 'query', code: 'query_failed', nativeCode: 5, activeProcesses: 1,
        }) + '\n');
      } else {
        helper.stdout.write('{"type":"ready"}\n');
        helper.emit('exit', 1, null);
      }
      await tick();
      assert.equal(f.messages.some(message => message.type === 'launch'), false);
      assert.ok(f.guardian.kills > 0, 'the still-empty guardian is stopped through its owned handle');
      f.guardian.finish(); helper.finish();
      const result = await running;
      assert.equal(result.cleanup, 'cleanup_failed', 'lost Job evidence cannot authorize release');
      assert.equal(result.timedOut, false, 'the command execution timer never started');
      assert.equal(supervisor.has('lost-ready'), true);
    } finally {
      for (const helper of f.helpers) helper.finish();
      // 模拟的操作系统句柄已关闭，但有意设置为失败的 Job 仍须
      // 占用其逻辑所有者，不能凭空生成释放证据。
      await supervisor.dispose().catch(() => {});
      f.restore();
    }
  });
}
