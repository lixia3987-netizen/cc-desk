import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { ideInvocation, openIde } from '../src/main/ide';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-ide-'));
  const cwd = path.join(root, "项目 空格; $(touch forbidden) & 'worktree'");
  const application = path.join(root, 'Custom IDE with spaces');
  fs.mkdirSync(cwd);
  fs.writeFileSync(application, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { root, cwd, application, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function fakeLauncher(run: (child: ChildProcess) => void) {
  let unrefCount = 0;
  let invocation: { file: string; args: string[]; options: SpawnOptions } | undefined;
  let child: ChildProcess;
  const launch = (file: string, args: string[], options: SpawnOptions) => {
    invocation = { file, args, options };
    child = new EventEmitter() as ChildProcess;
    child.unref = () => { unrefCount++; };
    queueMicrotask(() => run(child));
    return child;
  };
  return { launch, get invocation() { return invocation!; }, get child() { return child!; }, get unrefCount() { return unrefCount; } };
}

test('IDE paths remain literal arguments for customized Windows executables and macOS applications', () => {
  const winApp = 'C:\\自定义 IDE & tools\\Code - Insiders.exe';
  const winProject = 'D:\\项目 空格 & %PATH%\\worktree';
  const win = ideInvocation(`  "${winApp}"  `, winProject, 'win32');
  assert.equal(win.file, winApp);
  assert.deepEqual(win.args, [winProject]);
  assert.equal(win.appBundle, false);
  const webstorm = ideInvocation('C:\\JetBrains\\WebStorm\\bin\\webstorm64.EXE', winProject, 'win32');
  assert.deepEqual(webstorm.args, [winProject]);
  const app = "/Applications/Custom 'VS Code' & tools.app";
  const mac = ideInvocation(`'${app}'`, '/Users/test/project; $(touch no)', 'darwin');
  assert.equal(mac.file, '/usr/bin/open');
  assert.deepEqual(mac.args, ['-a', app, '/Users/test/project; $(touch no)']);
  assert.equal(mac.appBundle, true);
});

test('IDE configuration rejects command strings, relative paths and Windows command wrappers', () => {
  assert.throws(() => ideInvocation('', '/project', 'linux'), /设置.*IDE/);
  for (const value of ['code', './code', 'code --new-window', '/apps/code\n--args', '/apps/code\0']) {
    assert.throws(() => ideInvocation(value, '/project', 'linux'), /绝对路径/);
  }
  for (const value of ['C:\\IDE\\code.cmd', 'C:\\IDE\\webstorm.bat', 'C:\\IDE\\custom.lnk']) {
    assert.throws(() => ideInvocation(value, 'D:\\project', 'win32'), /\.exe.*CMD、BAT/);
  }
  for (const value of ['C:Code.exe', '\\Code.exe', 'C:\\Code.exe --new-window']) {
    assert.throws(() => ideInvocation(value, 'D:\\project', 'win32'), /绝对路径|\.exe/);
  }
  assert.throws(() => ideInvocation('/usr/bin/code', 'relative-project', 'linux'), /项目目录无效/);
});

test('IDE launch explains missing applications, deleted worktrees and non-file selections before spawning', { skip: process.platform === 'win32' }, async () => {
  const f = fixture();
  const neverLaunch = () => { assert.fail('invalid input must not spawn a process'); };
  try {
    await assert.rejects(openIde(path.join(f.root, 'missing-app'), f.cwd, { spawn: neverLaunch }), /找不到 IDE 应用.*重新选择/);
    await assert.rejects(openIde(f.application, path.join(f.root, 'removed-worktree'), { spawn: neverLaunch }), /找不到项目目录.*工作树/);
    await assert.rejects(openIde(f.application, f.application, { spawn: neverLaunch }), /项目路径不是文件夹/);
    await assert.rejects(openIde(f.root, f.cwd, { spawn: neverLaunch }), /可执行文件/);
    const dangling = path.join(f.root, 'dangling');
    fs.symlinkSync(path.join(f.root, 'removed-app'), dangling);
    await assert.rejects(openIde(dangling, f.cwd, { spawn: neverLaunch }), /找不到 IDE 应用/);
    fs.chmodSync(f.application, 0o644);
    await assert.rejects(openIde(f.application, f.cwd, { spawn: neverLaunch }), /执行 IDE 应用的权限/);
  } finally { f.cleanup(); }
});

test('macOS app requests wait only for the open helper and surface failed handoff', { skip: process.platform === 'win32' }, async () => {
  const f = fixture();
  const app = path.join(f.root, 'Custom WebStorm.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<?xml version="1.0"?><plist/>');
  try {
    const success = fakeLauncher(child => { child.emit('spawn'); setTimeout(() => child.emit('exit', 0, null), 10); });
    await openIde(app, f.cwd, { platform: 'darwin', spawn: success.launch });
    assert.equal(success.invocation.file, '/usr/bin/open');
    assert.deepEqual(success.invocation.args, ['-a', app, f.cwd]);
    assert.equal(success.invocation.options.shell, false);
    assert.equal(success.invocation.options.cwd, f.cwd);
    assert.equal(success.unrefCount, 1);
    const failure = fakeLauncher(child => { child.emit('spawn'); child.emit('exit', 1, null); });
    await assert.rejects(openIde(app, f.cwd, { platform: 'darwin', spawn: failure.launch }), /IDE 启动失败.*退出码 1/);
    fs.unlinkSync(path.join(app, 'Contents', 'Info.plist'));
    await assert.rejects(openIde(app, f.cwd, { platform: 'darwin', spawn: success.launch }), /\.app 缺少应用文件/);
  } finally { f.cleanup(); }
});

test('IDE startup errors and early nonzero exits are reported without leaking process listeners', { skip: process.platform === 'win32' }, async () => {
  const f = fixture();
  try {
    for (const [code, message] of [['ENOENT', /解释器不存在/], ['EACCES', /系统拒绝/], ['EPERM', /系统拒绝/], ['ENOEXEC', /文件无法执行/]] as const) {
      const fake = fakeLauncher(child => child.emit('error', Object.assign(new Error('private launch details'), { code })));
      await assert.rejects(openIde(f.application, f.cwd, { spawn: fake.launch }), message);
      assert.equal(fake.unrefCount, 1);
      assert.equal(fake.child.listenerCount('spawn'), 0);
      assert.equal(fake.child.listenerCount('exit'), 0);
      assert.doesNotThrow(() => fake.child.emit('error', new Error('late process event')));
    }
    const failure = fakeLauncher(child => { child.emit('spawn'); child.emit('exit', 23, null); });
    await assert.rejects(openIde(f.application, f.cwd, { spawn: failure.launch }), /退出码 23/);
    const signal = fakeLauncher(child => { child.emit('spawn'); child.emit('exit', null, 'SIGKILL'); });
    await assert.rejects(openIde(f.application, f.cwd, { spawn: signal.launch }), /SIGKILL/);
    await assert.rejects(openIde(f.application, f.cwd, { spawn: () => { throw Object.assign(new Error(), { code: 'EACCES' }); } }), /系统拒绝/);
  } finally { f.cleanup(); }
});

test('an actual executable launcher receives the exact worktree and detaches while its GUI process stays alive', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  const f = fixture();
  const record = path.join(f.root, 'invocation.json');
  fs.writeFileSync(f.application, `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),keep:process.env.KEEP_VALUE,electron:process.env.ELECTRON_RUN_AS_NODE,testMode:process.env.WORKBENCH_TEST_MODE}));
setInterval(() => {}, 1000);
`);
  let child: ChildProcess | undefined;
  let launchOptions: SpawnOptions | undefined;
  const env = { PATH: process.env.PATH ?? '', KEEP_VALUE: 'preserved', ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1', WORKBENCH_TEST_MODE: '1' };
  try {
    const started = Date.now();
    await openIde(f.application, f.cwd, { env, spawn: (file, args, options) => { launchOptions = options; child = spawn(file, args, options); return child; } });
    assert.ok(Date.now() - started < 3000, 'opening completes without waiting for the GUI lifetime');
    assert.ok(child);
    assert.equal(child.exitCode, null, 'the launched editor remains running after handoff');
    assert.equal(launchOptions?.shell, false);
    assert.equal(launchOptions?.detached, true);
    assert.equal(launchOptions?.stdio, 'ignore');
    assert.equal(launchOptions?.windowsHide, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(record, 'utf8')), { args: [f.cwd], cwd: f.cwd, keep: 'preserved' });
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1', 'the parent environment is not mutated');
    assert.equal(fs.existsSync(path.join(f.cwd, 'forbidden')), false, 'shell syntax in a directory name is never evaluated');
  } finally {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    f.cleanup();
  }
});
