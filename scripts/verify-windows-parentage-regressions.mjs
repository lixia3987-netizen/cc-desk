import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

// Compare the same real-process fixtures with the last failing implementation.
// Only generated dist files are swapped; sources and the installed dependency
// tree are unchanged, and restoration runs before any fixed-code test.
if (process.platform !== 'win32') throw new Error('This regression requires real Windows process handles.');
const baseline = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(baseline ?? '')) throw new Error('Pass the full baseline commit SHA.');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'test-results', 'windows-parentage');
await fs.mkdir(output, { recursive: true });
const cases = [
  { name: 'claude', source: 'packages/engine-claude/src/connection.ts',
    built: 'packages/engine-claude/dist/connection.js', test: 'packages/engine-claude/tests/connection-windows.test.mjs',
    evidence: /CLAUDE_TREE_CLEANUP_FAILED:creation_before_spawn/,
    failures: [/not ok \d+ - root\b/, /not ok \d+ - descendant\b/] },
  { name: 'terminal', source: 'packages/agent-node/src/windows-process-tree.ts',
    built: 'packages/agent-node/dist/windows-process-tree.js', test: 'packages/agent-node/tests/process-windows-tree.test.mjs',
    evidence: /WINDOWS_STALE_PARENT_REJECTED:identity_changed/,
    failures: [/not ok \d+ - .*stale parent.*root\b/, /not ok \d+ - .*stale parent.*intermediate\b/] },
];
const originals = new Map();
for (const item of cases) originals.set(item.built, await fs.readFile(path.join(root, item.built)));
async function run(item, stage) {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=stale parent', item.test], {
    cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  const log = (result.stdout ?? '') + (result.stderr ?? '');
  await fs.writeFile(path.join(output, `${item.name}-${stage}.tap`), log);
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `${item.name} must finish without a signal`);
  return { status: result.status, log };
}
try {
  for (const item of cases) {
    const result = spawnSync('git', ['show', `${baseline}:${item.source}`], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, `Cannot read ${baseline}:${item.source}`);
    const built = ts.transpileModule(result.stdout, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
    await fs.writeFile(path.join(root, item.built), built.outputText);
  }
  for (const item of cases) {
    const result = await run(item, 'baseline');
    assert.equal(result.status, 1, `${item.name}: the old implementation must fail these fixtures`);
    assert.match(result.log, item.evidence, `${item.name}: baseline must exercise the intended identity failure`);
    assert.match(result.log, /# fail [1-9]\d*/, `${item.name}: baseline must execute a failing test`);
    for (const failure of item.failures) assert.match(result.log, failure, `${item.name}: both parent generations must expose the old defect`);
    console.log(`${item.name}: baseline ${baseline} reproduced the stale-parent failure`);
  }
} finally {
  for (const [file, data] of originals) await fs.writeFile(path.join(root, file), data);
}
for (const item of cases) {
  assert.deepEqual(await fs.readFile(path.join(root, item.built)), originals.get(item.built));
  const result = await run(item, 'fixed');
  assert.equal(result.status, 0, `${item.name}: the fixed implementation must pass; see ${item.name}-fixed.tap`);
  assert.match(result.log, /# pass [1-9]\d*/);
  assert.match(result.log, /# fail 0/);
  const executed = result.log.match(/^ok \d+ - .*stale parent.*$/m)?.[0] ?? '';
  assert.ok(executed && !executed.includes('# SKIP'), `${item.name}: Windows regression must actually run`);
  console.log(`${item.name}: fixed code passed the same real-process fixtures`);
}
