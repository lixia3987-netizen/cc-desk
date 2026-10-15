import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { suiteRoot, ENGINEERING_SUITE, assertEngineeringSuiteDigest } from '../native-eval-engineering-common.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function materialEntries() {
  const files = [];
  const visit = async (relative = '') => {
    for (const name of (await fs.readdir(path.join(suiteRoot, relative))).sort()) {
      const next = path.posix.join(relative, name);
      if (next === 'validation.json') continue;
      const absolute = path.join(suiteRoot, next), stat = await fs.lstat(absolute);
      assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) await visit(next);
      else files.push([next, sha(await fs.readFile(absolute))]);
    }
  };
  await visit();
  return files;
}

test('historical v1 has the original frozen byte identity and retains its original validation evidence', async () => {
  const files = await materialEntries();
  assert.equal(files.length, 16);
  assert.equal(assertEngineeringSuiteDigest(files), ENGINEERING_SUITE.digest);
  assert.equal(files.find(([name]) => name === 'acceptance/common.mjs')[1], '14c40516c1cc3373bec3a631c7b26cf99b8ba6d6606cc767d23ed9938328ab89');
  assert.equal(files.find(([name]) => name === 'self-check.mjs')[1], '7b3a9515bf0eb6a4eb5f1aa5bb4d769ee5466f6cbc58a284e16e5070d401cfcc');
  const validation = await fs.readFile(path.join(suiteRoot, 'validation.json'));
  assert.equal(sha(validation), '348fee6eafd63893044bd4115c796ab2b9901de6788244b7134eefafba8eea6a');
  assert.equal(JSON.parse(validation).suiteDigest, ENGINEERING_SUITE.digest);
});

test('translating only the three frozen comments reproduces the rejected digest without changing files', async () => {
  const files = await materialEntries();
  const translations = {
    'acceptance/common.mjs': [
      ['Bundles candidate TypeScript using evaluator-owned tooling; never runs npm hooks.', '使用评估器自身的工具打包候选 TypeScript；不会运行 npm 钩子。'],
      ['Selected original regressions plus required new tests; not a full repository gate.', '执行选定的原有回归测试及要求新增的测试；不代表完整仓库验证。'],
    ],
    'self-check.mjs': [
      ['Operator-only fixture QA. No model/service credentials or evaluation CLI integration.', '仅供操作者执行测试夹具质量检查；不接入模型或服务凭据，也不集成评估 CLI。'],
    ],
  };
  const changed = new Map();
  for (const [name, replacements] of Object.entries(translations)) {
    const original = await fs.readFile(path.join(suiteRoot, name), 'utf8');
    let translated = original;
    for (const [before, after] of replacements) { assert.equal(translated.split(before).length, 2); translated = translated.replace(before, after); }
    changed.set(name, sha(translated));
    assert.equal(await fs.readFile(path.join(suiteRoot, name), 'utf8'), original);
  }
  const dirty = files.map(([name, digest]) => [name, changed.get(name) ?? digest]);
  assert.equal(sha(JSON.stringify(dirty)), '58ec2e1356c5701df023572e98db5072490e4081f5e2a00a83cbf1f3470e71ea');
  assert.throws(() => assertEngineeringSuiteDigest(dirty), /digest mismatch/);
  assert.equal(assertEngineeringSuiteDigest(await materialEntries()), ENGINEERING_SUITE.digest);
});

test('derived validation content is excluded from material identity without deleting or rewriting history', async () => {
  const files = await materialEntries(), file = path.join(suiteRoot, 'validation.json');
  const original = await fs.readFile(file);
  for (const derived of [{ status: 'not_run' }, { status: 'fail' }, { status: 'pass' }]) {
    assert.equal(assertEngineeringSuiteDigest([...files, ['validation.json', sha(JSON.stringify(derived))]]), ENGINEERING_SUITE.digest);
  }
  assert.throws(() => assertEngineeringSuiteDigest([...files, ['acceptance/validation.json', sha('{}')]]), /digest mismatch/);
  assert.deepEqual(await fs.readFile(file), original);
});
