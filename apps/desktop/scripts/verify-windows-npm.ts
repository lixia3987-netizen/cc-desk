import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cliInvocation, detectCLI, environment, execFileAsync } from '../src/main/commands';
import type { Settings } from '../src/shared/types';

const expectedVersion = '2.1.278';
let stage = 'validate integration environment';

function settings(claudePath: string): Settings {
  return { claudePath, shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 5000 };
}

async function main() {
  assert.equal(process.platform, 'win32', 'This integration check requires Windows.');
  const shimArgument = process.argv[2];
  assert.ok(shimArgument && path.isAbsolute(shimArgument), 'Pass the isolated npm claude.cmd path.');
  const shim = path.resolve(shimArgument);
  assert.equal(path.basename(shim).toLowerCase(), 'claude.cmd');
  assert.ok(fs.statSync(shim).isFile());
  const prefix = path.dirname(shim);
  const packageRoot = path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code');
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(metadata.name, '@anthropic-ai/claude-code');
  assert.equal(metadata.version, expectedVersion);
  assert.equal(metadata.bin.claude, 'bin/claude.exe');
  const expectedExecutable = fs.realpathSync(path.join(packageRoot, 'bin', 'claude.exe'));

  function assertNativeInvocation(invocation: ReturnType<typeof cliInvocation>) {
    assert.equal(fs.realpathSync(invocation.file).toLowerCase(), expectedExecutable.toLowerCase());
    assert.deepEqual(invocation.prefix, [], 'The npm native binary must run without Node.');
  }

  stage = 'resolve configured npm launcher without Node on PATH';
  const explicit = settings(shim);
  assertNativeInvocation(cliInvocation(explicit, { PATH: '' }));

  stage = 'discover npm launcher without Node on PATH';
  assertNativeInvocation(cliInvocation(settings(''), { PATH: prefix }));

  // PATH 修改仅限于此短暂运行的验证程序；即使失败也会恢复。
  const pathKeys = Object.keys(process.env).filter(key => key.toLowerCase() === 'path');
  const originalPaths = pathKeys.map(key => [key, process.env[key]] as const);
  try {
    for (const key of pathKeys) delete process.env[key];
    process.env.PATH = prefix;

    stage = 'resolve configured and discovered launchers in the app environment';
    const invocation = cliInvocation(explicit, environment());
    assertNativeInvocation(invocation);
    assertNativeInvocation(cliInvocation(settings(''), environment()));

    stage = 'execute native version and help probes';
    const options = { env: environment(), timeout: 12000, maxBuffer: 2 * 1024 * 1024, windowsHide: true };
    const [version, help] = await Promise.all([
      execFileAsync(invocation.file, ['--version'], options),
      execFileAsync(invocation.file, ['--help'], options),
    ]);
    assert.match(version.stdout, /^2\.1\.278(?:\s|$)/);
    assert.ok(help.stdout.includes('--help'));

    stage = 'detect capabilities using configured and discovered launchers';
    const [configuredCapabilities, discoveredCapabilities] = await Promise.all([
      detectCLI(explicit),
      detectCLI(settings('')),
    ]);
    for (const capabilities of [configuredCapabilities, discoveredCapabilities]) {
      assert.equal(capabilities.available, true);
      assertNativeInvocation({ file: capabilities.executable, prefix: [] });
      assert.match(capabilities.version, /^2\.1\.278(?:\s|$)/);
      assert.ok(capabilities.flags.includes('--help'));
    }

    // CI 日志仅记录已知的版本与标志数量；子进程的 stdout/stderr 不对外输出。
    console.log(`Windows npm launcher verified: Claude Code ${expectedVersion}; configured flags=${configuredCapabilities.flags.length}, discovered flags=${discoveredCapabilities.flags.length}.`);
  } finally {
    for (const key of Object.keys(process.env)) if (key.toLowerCase() === 'path') delete process.env[key];
    for (const [key, value] of originalPaths) process.env[key] = value;
  }
}

main().catch(() => {
  // execFile 错误可能包含子进程的完整输出，因此不打印异常内容。
  console.error(`Windows npm launcher verification failed: ${stage}.`);
  process.exitCode = 1;
});
