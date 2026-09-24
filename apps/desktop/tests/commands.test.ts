import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { cliInvocation, detectCLI, execFileAsync, findExecutable, resolveNpmLauncher } from '../src/main/commands';
import { settingsSchema } from '../src/shared/schema';
import type { Capabilities, Session } from '../src/shared/types';
import { ClaudeTerminalLauncher } from '../src/main/engines/claude/terminal-launcher';

function fixture(local = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-commands-'));
  const prefix = path.join(root, 'custom npm 空格 & tools');
  const shimDirectory = local ? path.join(prefix, 'node_modules', '.bin') : prefix;
  const packageDirectory = path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code');
  const shim = path.join(shimDirectory, 'claude.cmd');
  const marker = path.join(root, 'batch-was-executed');
  const write = (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };
  write(shim, `@echo off\r\necho unsafe>"${marker}"\r\nexit /b 99\r\n`);
  return {
    root, prefix, shimDirectory, packageDirectory, shim, marker, write,
    manifest(bin: unknown, name = '@anthropic-ai/claude-code') {
      write(path.join(packageDirectory, 'package.json'), { name, version: '2.1.278', bin });
    },
    target(relative: string) { return write(path.join(packageDirectory, relative), 'fixture'); },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function posixFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-posix-cli-'));
  const prefix = path.join(root, 'nvm 空格 & tools', 'versions', 'node', 'fixture');
  const bin = path.join(prefix, 'bin');
  const script = path.join(prefix, 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  const cli = path.join(bin, 'claude'); const node = path.join(bin, 'node');
  const record = path.join(root, 'invocations.jsonl');
  const flags = ['--session-id', '--permission-mode', '--model', '--print', '--input-format', '--output-format', '--verbose', '--permission-prompt-tool', '--include-partial-messages'];
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.symlinkSync(process.execPath, node);
  fs.symlinkSync(path.relative(bin, script), cli);
  fs.writeFileSync(script, `#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
// A CLI tool needs the same selected Node in PATH, not just a working entry point.
const child = spawnSync('node', ['-e', 'process.stdout.write(process.execPath)'], { encoding: 'utf8' });
if (child.status !== 0) throw new Error('child Node unavailable');
const proof = { args, path: process.env.PATH, child: child.stdout };
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(proof) + '\\n');
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
if (args[0] === '--version') process.stdout.write('2.1.278 (POSIX fixture)');
else if (args[0] === '--help') process.stdout.write(${JSON.stringify(flags.join('\n'))});
else if (args.includes('--print')) {
  const session = args[args.indexOf('--session-id') + 1];
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    if (message.type === 'control_request') emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
    else if (message.type === 'user') {
      emit({ type: 'system', subtype: 'init', session_id: session, model: 'fixture', permissionMode: 'default' });
      emit({ type: 'result', subtype: 'success', result: 'POSIX chat complete', session_id: session });
    }
  });
} else if (args.includes('--session-id')) process.stdout.write('POSIX PTY complete\\n');
else emit(proof);
`, { mode: 0o755 });
  const settings = settingsSchema.parse({ claudePath: cli, shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 5000 });
  return { root, bin, cli, node, script, record, settings, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('POSIX explicit npm/nvm symlinks use their sibling Node and pass literal arguments with a stripped PATH', { skip: process.platform === 'win32' }, async () => {
  const f = posixFixture();
  try {
    const env = { PATH: '', KEEP_VALUE: 'untouched' };
    const invocation = cliInvocation(f.settings, env);
    assert.deepEqual(invocation, { file: f.node, prefix: [f.cli] });
    assert.equal(env.PATH, f.bin); assert.equal(env.KEEP_VALUE, 'untouched');
    const literal = 'name with spaces; $(touch forbidden) & | "quotes"';
    const result = await execFileAsync(invocation.file, [...invocation.prefix, literal], { env, timeout: 10000 });
    const proof = JSON.parse(result.stdout);
    assert.deepEqual(proof.args, [literal]); assert.equal(proof.path, f.bin);
    assert.equal(proof.child, fs.realpathSync(process.execPath));
    cliInvocation(f.settings, env); assert.equal(env.PATH, f.bin, 'resolution is idempotent');

    const other = path.join(f.root, 'other'); fs.mkdirSync(other);
    fs.symlinkSync(process.execPath, path.join(other, 'node'));
    const mixed = { PATH: `${other}:${f.bin}` };
    assert.equal(cliInvocation(f.settings, mixed).file, f.node, 'selected CLI keeps its matching Node');
    assert.equal(mixed.PATH, `${f.bin}:${other}`);
    fs.unlinkSync(f.node);
    assert.equal(cliInvocation(f.settings, { PATH: other }).file, path.join(other, 'node'), 'PATH remains a supported fallback');
    assert.throws(() => cliInvocation(f.settings, { PATH: '' }), /Node\.js/);
  } finally { f.cleanup(); }
});

test('POSIX launcher recognition leaves native binaries and unrelated shell scripts unchanged', { skip: process.platform === 'win32' }, () => {
  const f = posixFixture();
  try {
    const env = { PATH: '' };
    assert.deepEqual(cliInvocation({ ...f.settings, claudePath: process.execPath }, env), { file: process.execPath, prefix: [] });
    for (const shebang of ['#!/bin/sh', '#!/usr/bin/env bash', '#!/usr/bin/env node-not-node']) {
      fs.writeFileSync(f.script, `${shebang}\nexit 0\n`);
      assert.deepEqual(cliInvocation(f.settings, env), { file: f.cli, prefix: [] });
      assert.equal(env.PATH, '');
    }
    fs.writeFileSync(f.script, '#! /usr/bin/env\tnode\r\nprocess.exit(0);\n');
    assert.equal(cliInvocation(f.settings, env).file, f.node);
  } finally { f.cleanup(); }
});

test('POSIX detection, PTY and structured chat share the explicit npm Node environment without shell startup', { skip: process.platform === 'win32', timeout: 20000 }, async () => {
  const [{ Runtime }, { ChatRuntime }, { StateStore }] = await Promise.all([
    import('../src/main/runtime'), import('../src/main/chat-runtime'), import('../src/main/store'),
  ]);
  const f = posixFixture();
  const inherited = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, BASH_ENV: process.env.BASH_ENV, ENV: process.env.ENV };
  const marker = path.join(f.root, 'shell-startup-ran');
  const startup = path.join(f.root, 'shell-startup.sh');
  fs.writeFileSync(startup, `printf unexpected > '${marker}'\n`);
  process.env.PATH = '';
  process.env.CLAUDE_CONFIG_DIR = path.join(f.root, 'isolated-config');
  process.env.BASH_ENV = startup; process.env.ENV = startup;
  const store = new StateStore(path.join(f.root, 'data'));
  const createSession = (adapter: Session['execution']['mode']): Session => ({ execution: { providerId: 'claude', mode: adapter, conversationId: randomUUID() },
    id: randomUUID(), projectId: randomUUID(), title: 'POSIX fixture', kind: 'agent',  cwd: f.root,
     started: false, model: '', effort: 'default', permissionMode: 'default', status: 'idle', archived: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const terminal = createSession('terminal'); const structured = createSession('structured');
  store.change(state => { state.settings = f.settings; state.sessions = [terminal, structured]; });
  let output = '';
  let launchCapabilities: Capabilities;
  const runtime = new Runtime(store, () => {}, chunk => { output += chunk.data; }, new ClaudeTerminalLauncher(store, () => launchCapabilities));
  const chat = new ChatRuntime(store, () => {}, () => {}, { initializationTimeoutMs: 3000, transcriptExists: async () => false });
  try {
    const capabilities = await detectCLI(f.settings);
    assert.equal(capabilities.available, true, capabilities.error);
    assert.equal(capabilities.version, '2.1.278 (POSIX fixture)');
    launchCapabilities = capabilities;
    await runtime.start(terminal.id);
    const deadline = Date.now() + 5000;
    while (runtime.activeCount || !output.includes('POSIX PTY complete')) {
      assert.ok(Date.now() < deadline, `PTY fixture did not finish: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(store.state.sessions.find(session => session.id === terminal.id)?.exitCode, 0);
    const result = await chat.send(structured.id, 'fixture only', capabilities);
    assert.equal(result.success, true, result.error); assert.equal(result.summary, 'POSIX chat complete');
    const probes = fs.readFileSync(f.record, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(probes.length, 4, 'only version/help probes and the two fixture sessions run');
    for (const probe of probes) {
      assert.equal(probe.path.split(path.delimiter)[0], f.bin);
      assert.equal(probe.child, fs.realpathSync(process.execPath));
    }
    assert.equal(fs.existsSync(marker), false);
    assert.equal(process.env.PATH, '', 'resolving a CLI never mutates the parent environment');
  } finally {
    await chat.shutdown(); await runtime.shutdown();
    for (const [key, value] of Object.entries(inherited)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    f.cleanup();
  }
});

test('Windows npm native bin is resolved from metadata without Node or executing the batch file', () => {
  const f = fixture();
  try {
    f.manifest({ claude: 'bin/claude.exe' });
    const executable = f.target('bin/claude.exe');
    assert.deepEqual(resolveNpmLauncher(f.shim, { Path: '' }, 'win32'), { file: executable, prefix: [] });
    assert.equal(fs.existsSync(f.marker), false);
  } finally { f.cleanup(); }
});

test('legacy npm JavaScript bins use an adjacent node.exe before any PATH Node', () => {
  const f = fixture();
  try {
    f.manifest({ claude: 'cli.js' });
    const script = f.target('cli.js');
    const adjacentNode = f.write(path.join(f.shimDirectory, 'node.exe'), 'local Node');
    const pathNodeDirectory = path.join(f.root, 'other node');
    f.write(path.join(pathNodeDirectory, 'node.exe'), 'PATH Node');
    assert.deepEqual(resolveNpmLauncher(f.shim, { Path: pathNodeDirectory }, 'win32'), { file: adjacentNode, prefix: [script] });
  } finally { f.cleanup(); }
});

test('npm string bins and JavaScript extensions use a native PATH Node, skipping node.cmd', () => {
  const f = fixture();
  try {
    const batchDirectory = path.join(f.root, 'batch node');
    const nodeDirectory = path.join(f.root, 'native node');
    f.write(path.join(batchDirectory, 'node.cmd'), '@echo should not run');
    const node = f.write(path.join(nodeDirectory, 'node.exe'), 'native Node');
    for (const entry of ['cli.js', 'dist/cli.cjs', 'dist/cli.mjs']) {
      f.manifest(entry);
      const script = f.target(entry);
      assert.deepEqual(resolveNpmLauncher(f.shim, { pAtH: `${batchDirectory};"${nodeDirectory}"` }, 'win32'), { file: node, prefix: [script] });
    }
  } finally { f.cleanup(); }
});

test('project node_modules/.bin launchers resolve the adjacent scoped package', () => {
  const f = fixture(true);
  try {
    f.manifest({ claude: 'bin/claude.exe' });
    const executable = f.target('bin/claude.exe');
    assert.deepEqual(resolveNpmLauncher(f.shim, { Path: '' }, 'win32'), { file: executable, prefix: [] });
  } finally { f.cleanup(); }
});

test('Windows executable search accepts case-insensitive PATH keys and quoted paths', () => {
  const f = fixture();
  try {
    const executable = f.write(path.join(f.prefix, 'claude.exe'), 'native CLI');
    assert.equal(findExecutable('claude', { pAtH: `"${f.prefix}"` }, 'win32'), executable);
    assert.equal(findExecutable(`"${executable}"`, { Path: '' }, 'win32'), executable);
    assert.equal(findExecutable('claude.cmd', { Path: `"${f.prefix}"` }, 'win32'), f.shim);
    const alternateDirectory = path.join(f.root, 'other PATH entry');
    f.write(path.join(alternateDirectory, 'claude.exe'), 'other native CLI');
    assert.equal(findExecutable('claude', { Path: alternateDirectory, PATH: f.prefix }, 'win32'), executable,
      'duplicate casing follows the first sorted key, matching the Windows subprocess environment');
  } finally { f.cleanup(); }
});

test('missing npm metadata and missing bin targets report installation failures', () => {
  const f = fixture();
  try {
    assert.throws(() => resolveNpmLauncher(f.shim, { Path: '' }, 'win32'), /npm|package|安装|启动器/i);
    f.manifest({ claude: 'bin/claude.exe' });
    assert.throws(() => resolveNpmLauncher(f.shim, { Path: '' }, 'win32'), /bin|文件|安装|入口/i);
    f.write(path.join(f.packageDirectory, 'package.json'), '{broken');
    assert.throws(() => resolveNpmLauncher(f.shim, { Path: '' }, 'win32'), /npm|package|安装|启动器/i);
  } finally { f.cleanup(); }
});

test('a legacy JavaScript package with only a batch Node reports a Node installation failure', () => {
  const f = fixture();
  try {
    f.manifest({ claude: 'cli.js' });
    f.target('cli.js');
    f.write(path.join(f.prefix, 'node.cmd'), '@echo no native Node');
    assert.throws(() => resolveNpmLauncher(f.shim, { Path: f.prefix }, 'win32'), /node/i);
  } finally { f.cleanup(); }
});

test('detection retains safe installation guidance when an npm launcher cannot be resolved', async () => {
  const f = fixture();
  try {
    fs.chmodSync(f.shim, 0o755);
    const settings = settingsSchema.parse({ claudePath: f.shim, shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 5000 });
    const result = await detectCLI(settings);
    assert.equal(result.available, false);
    assert.match(result.error ?? '', /npm/);
    assert.equal(result.error?.includes(f.root), false);
    assert.equal(fs.existsSync(f.marker), false);
  } finally { f.cleanup(); }
});

test('npm metadata cannot select an unrelated package, escaping path, or shell launcher', () => {
  const f = fixture();
  try {
    f.target('cli.js');
    f.write(path.join(f.shimDirectory, 'node.exe'), 'Node');
    f.manifest({ claude: 'cli.js' }, 'unrelated-package');
    assert.throws(() => resolveNpmLauncher(f.shim, { Path: '' }, 'win32'));
    f.write(path.join(f.packageDirectory, '..', 'escape.exe'), 'outside package');
    const absolute = f.write(path.join(f.root, 'absolute.exe'), 'absolute target');
    for (const entry of ['bin/cli.cmd', 'bin/cli.bat', 'bin/cli.ps1']) f.target(entry);
    for (const entry of ['../escape.exe', '..\\escape.exe', absolute, 'C:\\outside\\claude.exe', '\\\\server\\share\\claude.exe', 'bin/cli.cmd', 'bin/cli.bat', 'bin/cli.ps1']) {
      f.manifest({ claude: entry });
      assert.throws(() => resolveNpmLauncher(f.shim, { Path: '' }, 'win32'), entry);
    }
    f.manifest({ other: 'cli.js' });
    assert.throws(() => resolveNpmLauncher(f.shim, { Path: '' }, 'win32'));
  } finally { f.cleanup(); }
});

test('Windows native and legacy invocations preserve literal arguments and detection only runs probes', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture();
  try {
    const executable = path.join(f.packageDirectory, 'bin', 'claude.exe');
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.copyFileSync(process.execPath, executable);
    f.manifest({ claude: 'bin/claude.exe' });
    const settings = settingsSchema.parse({ claudePath: `"${f.shim}"`, shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 5000 });
    const literal = `literal & echo SHOULD_NOT_RUN>"${f.marker}" | %PATH% !value! ^ ( )`;
    const native = cliInvocation(settings);
    assert.deepEqual(native, { file: executable, prefix: [] });
    const nativeOutput = await execFileAsync(native.file, ['-e', 'process.stdout.write(JSON.stringify(process.argv[1]))', literal], { windowsHide: true, timeout: 10000 });
    assert.equal(JSON.parse(nativeOutput.stdout), literal);

    const node = path.join(f.shimDirectory, 'node.exe');
    fs.copyFileSync(process.execPath, node);
    f.manifest({ claude: 'cli.js' });
    f.write(path.join(f.packageDirectory, 'cli.js'), `
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') process.stdout.write('2.1.278 (fixture)');
else if (args.length === 1 && args[0] === '--help') process.stdout.write('--session-id UUID\\n--permission-mode default\\n--model ID');
else process.stdout.write(JSON.stringify(args));
`);
    const legacy = cliInvocation(settings);
    assert.equal(legacy.file, node);
    const legacyOutput = await execFileAsync(legacy.file, [...legacy.prefix, literal], { windowsHide: true, timeout: 10000 });
    assert.deepEqual(JSON.parse(legacyOutput.stdout), [literal]);
    const capabilities = await detectCLI(settings);
    assert.equal(capabilities.available, true);
    assert.equal(capabilities.version, '2.1.278 (fixture)');
    assert.ok(capabilities.flags.includes('--session-id'));
    assert.equal(fs.existsSync(f.marker), false, 'neither the batch body nor argument metacharacters were evaluated');
  } finally { f.cleanup(); }
});
