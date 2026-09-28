import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const suiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const trustedRoot = path.resolve(suiteRoot, '../../..');
export const baseline = 'b45bd0623d2a44a2878c46d4701fa4b388c7d9be';
export const requireTrusted = createRequire(path.join(trustedRoot, 'package.json'));
const { build } = requireTrusted('esbuild');
export const sha = value => createHash('sha256').update(value).digest('hex');
export function git(root, args, encoding = 'utf8') {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', ...args], {
    cwd: root, encoding, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
  });
  if (result.status !== 0 || result.error) throw new Error(`git ${args[0]} failed: ${result.stderr || result.error?.message}`);
  return result.stdout;
}
export async function source(root, file) {
  const absolute = path.resolve(root, file), relative = path.relative(root, absolute);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  const stat = await fs.lstat(absolute); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2 * 1024 * 1024, 'ordinary bounded source file');
  return fs.readFile(absolute, 'utf8');
}
/** Bundles candidate TypeScript using evaluator-owned tooling; never runs npm hooks. */
export async function load(root, file, { electron = false } = {}) {
  const result = await build({ entryPoints: [path.join(root, file)], bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node22', packages: 'external',
    nodePaths: [path.join(trustedRoot, 'node_modules')], logLevel: 'silent',
    alias: { '@cc-desk/agent-core': path.join(root, 'packages/agent-core/src/index.ts'), '@cc-desk/contracts/native-task': path.join(root, 'packages/contracts/src/native-task.ts') },
    plugins: electron ? [{ name: 'isolated-electron-fixture', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'e0' }));
      builder.onLoad({ filter: /.*/, namespace: 'e0' }, () => ({ contents: 'export const contextBridge=globalThis.__e0Electron.contextBridge;export const ipcRenderer=globalThis.__e0Electron.ipcRenderer;export const webUtils=globalThis.__e0Electron.webUtils;', loader: 'js' }));
    } }] : [],
  });
  const compiled = new Module(path.join(trustedRoot, '.e0-evaluator.cjs'));
  compiled.filename = path.join(trustedRoot, '.e0-evaluator.cjs');
  compiled.paths = Module._nodeModulePaths(trustedRoot);
  compiled._compile(result.outputFiles[0].text, compiled.filename);
  return compiled.exports;
}
export async function assertIntegrity(root, task) {
  assert.equal(git(root, ['rev-parse', `${baseline}^{commit}`]).trim(), baseline);
  const files = git(trustedRoot, ['ls-tree', '-r', '--name-only', baseline]).trim().split('\n');
  const protectedFiles = files.filter(file => /(?:^|\/)(AGENTS|CLAUDE)\.md$|(?:^|\/)(?:tests?|e2e)\/|(?:^|\/)package(?:-lock)?\.json$|(?:^|\/)tsconfig[^/]*\.json$|^\.github\//.test(file));
  for (const file of protectedFiles) assert.equal(sha(await fs.readFile(path.join(root, file))), sha(git(trustedRoot, ['show', `${baseline}:${file}`], null)), `Original instructions/tests/config must remain unchanged: ${file}`);
  const manifest = JSON.parse(await fs.readFile(path.join(suiteRoot, 'manifest.json'), 'utf8'));
  const entry = manifest.tasks.find(item => item.id === task); assert.ok(entry);
  assert.equal(await source(root, 'TASK.md'), await fs.readFile(path.join(suiteRoot, task, 'TASK.md'), 'utf8'), 'Task instructions must remain unchanged');
  const changed = [...new Set([...git(root, ['diff', '--name-only', baseline]).trim().split('\n'), ...git(root, ['ls-files', '--others', '--exclude-standard']).trim().split('\n')].filter(Boolean))];
  for (const file of changed) assert.ok(file === 'TASK.md' || entry.allowedPaths.some(pattern => pattern.endsWith('/') ? file.startsWith(pattern) : file === pattern), `Out-of-scope change: ${file}`);
  for (const file of entry.requiredNewTests) {
    const text = await source(root, file); assert.ok(text.trim().length > 80, `Add meaningful regression tests: ${file}`);
  }
  return { protectedFiles: protectedFiles.length, changed };
}

/** Selected original regressions plus required new tests; not a full repository gate. */
export function runSelectedTests(root, task) {
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LANG|LC_ALL)$/i.test(key)));
  const results = [];
  const run = (args, label) => {
    const started = Date.now();
    const result = spawnSync(process.execPath, args, { cwd: root, env: childEnv, encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    results.push({ label, executable: 'node', argv: args.map(arg => arg.replaceAll(trustedRoot, '<evaluator>').replaceAll(root, '<candidate>')),
      exitCode: result.status, signal: result.signal, durationMs: Date.now() - started, output: output.slice(-12000), truncated: output.length > 12000 });
    assert.ok(result.status === 0 && !result.error, `${label} failed: ${output.slice(-6000)}${result.error?.message ?? ''}`);
  };
  const tsc = requireTrusted.resolve('typescript/bin/tsc');
  for (const name of ['contracts', 'engine-claude', 'agent-core', 'agent-node']) run([tsc, '-p', `packages/${name}/tsconfig.json`], `compile ${name}`);
  const selected = {
    '01-snapshot-refresh': ['apps/desktop/tests/chat-snapshot-sync.test.ts', 'apps/desktop/tests/e0-snapshot-regression.test.ts'],
    '02-session-info': ['apps/desktop/tests/session-service.test.ts', 'apps/desktop/tests/e0-session-info.test.ts'],
    '03-canonical-json': ['packages/agent-core/tests/core.test.mjs', 'packages/agent-core/tests/public-exports.test.mjs', 'packages/agent-core/tests/e0-canonical-json.test.mjs', 'packages/agent-node/tests/tools-port.test.mjs', 'packages/agent-node/tests/mcp-tools.test.mjs', 'packages/agent-node/tests/e0-tool-digests.test.mjs'],
  };
  run(['--import', requireTrusted.resolve('tsx'), '--test', '--test-concurrency=1', ...selected[task]], 'selected original and new regression tests');
  return results;
}
