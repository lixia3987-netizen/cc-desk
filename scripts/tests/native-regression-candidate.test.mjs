import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fingerprintRegressionBundleInputs, readRegressionCandidateBinding } from '../native-regression-candidate.mjs';

const head = 'a'.repeat(40), other = 'b'.repeat(40);

test('显式候选必须等于真实 Git HEAD，查询不修改 Git 配置', async () => {
  const calls = [], git = async (...args) => { calls.push(args); return { stdout: args[1][0] === 'status' ? '' : `${head}\n` }; };
  const binding = await readRegressionCandidateBinding('/fixture', head, git);
  assert.equal(binding.verified, true);
  assert.equal(binding.reason, 'candidate_verified');
  assert.equal(binding.actualHead, head);
  assert.equal(binding.sourceStatusKnown, true);
  assert.equal(binding.workingTreeClean, true);
  assert.deepEqual(calls[0].slice(0, 2), ['git', ['rev-parse', '--verify', 'HEAD']]);
  assert.equal(calls[0][2].cwd, '/fixture');
  assert.equal(calls[0][2].env.GIT_OPTIONAL_LOCKS, '0');
  assert.deepEqual(calls[1][1], ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  const mismatch = await readRegressionCandidateBinding('/fixture', other, git);
  assert.equal(mismatch.verified, false);
  assert.equal(mismatch.reason, 'candidate_revision_mismatch');
  const implicit = await readRegressionCandidateBinding('/fixture', undefined, git);
  assert.equal(implicit.actualHead, head);
  assert.equal(implicit.verified, false);
  assert.equal(implicit.reason, 'candidate_revision_unspecified');
});

test('HEAD 相等但工作树有改动或 status 无法确认时不能归为候选通过', async () => {
  const dirty = await readRegressionCandidateBinding('/fixture', head, async (_command, args) => ({ stdout: args[0] === 'status' ? ' M private-fixture-name\0' : head }));
  assert.equal(dirty.actualHead, head);
  assert.equal(dirty.sourceStatusKnown, true);
  assert.equal(dirty.workingTreeClean, false);
  assert.equal(dirty.verified, false);
  assert.equal(dirty.reason, 'candidate_worktree_dirty');
  assert.equal(JSON.stringify(dirty).includes('private-fixture-name'), false);
  const unknown = await readRegressionCandidateBinding('/fixture', head, async (_command, args) => {
    if (args[0] === 'status') throw new Error('private-fixture-error');
    return { stdout: head };
  });
  assert.equal(unknown.sourceStatusKnown, false);
  assert.equal(unknown.workingTreeClean, false);
  assert.equal(unknown.verified, false);
  assert.equal(unknown.reason, 'candidate_source_status_unavailable');
  assert.equal(JSON.stringify(unknown).includes('private-fixture-error'), false);
});

test('无 Git、非法候选或异常输出均不能确认候选且不转存原始错误', async () => {
  const unavailable = await readRegressionCandidateBinding('/fixture', head, async () => { throw new Error('private fixture config'); });
  assert.equal(unavailable.reason, 'candidate_git_unavailable');
  assert.equal(unavailable.verified, false);
  assert.equal(JSON.stringify(unavailable).includes('private fixture'), false);
  for (const stdout of ['', `${head}\nprivate fixture`, 'c'.repeat(64)]) {
    assert.equal((await readRegressionCandidateBinding('/fixture', head, async () => ({ stdout }))).verified, false);
  }
  const invalid = await readRegressionCandidateBinding('/fixture', `${head}\nprivate fixture`, async () => ({ stdout: head }));
  assert.equal(invalid.requestedCandidate, null);
  assert.equal(invalid.verified, false);
});

test('实际 esbuild 输入包括已编译包，内容变化改变对应摘要且报告没有文件名或正文', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-candidate-test-'));
  try {
    const runtimeName = 'node_modules/@cc-desk/agent-core/dist/index.js', sourceName = 'entry.js';
    await mkdir(path.dirname(path.join(root, runtimeName)), { recursive: true });
    await writeFile(path.join(root, runtimeName), 'compiled fixture one');
    await writeFile(path.join(root, sourceName), 'entry fixture');
    const metafiles = [{ inputs: { [sourceName]: { bytes: 13 }, [runtimeName]: { bytes: 20 } } }, { inputs: { [runtimeName]: { bytes: 20 } } }];
    const first = await fingerprintRegressionBundleInputs(root, metafiles);
    const reordered = await fingerprintRegressionBundleInputs(root, [{ inputs: { [runtimeName]: {}, [sourceName]: {} } }]);
    assert.deepEqual(first, reordered);
    assert.equal(first.bundleInputCount, 2);
    assert.equal(first.packageRuntimeInputCount, 1);
    assert.match(first.bundleInputsDigest, /^[a-f\d]{64}$/u);
    assert.match(first.packageRuntimeDigest, /^[a-f\d]{64}$/u);
    assert.equal(JSON.stringify(first).includes('entry.js'), false);
    assert.equal(JSON.stringify(first).includes('compiled fixture'), false);
    await writeFile(path.join(root, runtimeName), 'compiled fixture two');
    const changedRuntime = await fingerprintRegressionBundleInputs(root, metafiles);
    assert.notEqual(changedRuntime.bundleInputsDigest, first.bundleInputsDigest);
    assert.notEqual(changedRuntime.packageRuntimeDigest, first.packageRuntimeDigest);
    await writeFile(path.join(root, sourceName), 'changed entry fixture');
    const changedEntry = await fingerprintRegressionBundleInputs(root, metafiles);
    assert.notEqual(changedEntry.bundleInputsDigest, changedRuntime.bundleInputsDigest);
    assert.equal(changedEntry.packageRuntimeDigest, changedRuntime.packageRuntimeDigest);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('缺失、虚拟或没有 package dist 的输入不会被标成已测 package runtime', async () => {
  await assert.rejects(fingerprintRegressionBundleInputs('/fixture', [{ inputs: {} }]), /bundle_inputs_missing/u);
  await assert.rejects(fingerprintRegressionBundleInputs('/fixture', [{ inputs: { '<stdin>': {} } }]), /bundle_input_unmeasurable/u);
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-candidate-test-'));
  try {
    await writeFile(path.join(root, 'source.js'), 'fixture');
    const result = await fingerprintRegressionBundleInputs(root, [{ inputs: { 'source.js': {} } }]);
    assert.equal(result.packageRuntimeDigest, null);
    assert.equal(result.packageRuntimeInputCount, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
