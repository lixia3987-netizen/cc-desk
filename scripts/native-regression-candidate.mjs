import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');
const commit = value => typeof value === 'string' && /^[a-f\d]{40}$/iu.test(value.trim()) ? value.trim().toLowerCase() : null;

/** 只读核对显式候选与真实 HEAD；缺 Git 的鉴权探测仍可运行，但不得成为发布证据。 */
export async function readRegressionCandidateBinding(directory, requestedCandidate, run = execute) {
  let actualHead = null;
  let sourceStatusKnown = false, workingTreeClean = false;
  const options = { cwd: directory, windowsHide: true, encoding: 'utf8', timeout: 10000,
    maxBuffer: 65536, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } };
  try {
    const result = await run('git', ['rev-parse', '--verify', 'HEAD'], options);
    actualHead = commit(result.stdout);
  } catch { /* 只保留固定状态，不记录 Git 错误中的路径或配置。 */ }
  if (actualHead) try {
    const result = await run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], options);
    sourceStatusKnown = typeof result.stdout === 'string'; workingTreeClean = sourceStatusKnown && result.stdout.length === 0;
  } catch { /* status 失败不能把源目录推断为干净；标准 ignore 规则仍由 Git 应用。 */ }
  const requested = commit(requestedCandidate), verified = actualHead !== null && requested !== null && requested === actualHead && sourceStatusKnown && workingTreeClean;
  return { requestedCandidate: requested, actualHead, gitAvailable: actualHead !== null, sourceStatusKnown, workingTreeClean, verified,
    reason: !actualHead ? 'candidate_git_unavailable' : !requested ? 'candidate_revision_unspecified' : requested !== actualHead ? 'candidate_revision_mismatch' :
      !sourceStatusKnown ? 'candidate_source_status_unavailable' : !workingTreeClean ? 'candidate_worktree_dirty' : 'candidate_verified' };
}

/** 仅报告真实 bundle 输入的摘要，不输出文件名、源码或 provider 配置。 */
export async function fingerprintRegressionBundleInputs(directory, metafiles) {
  const names = [...new Set(metafiles.flatMap(value => Object.keys(value.inputs ?? {})))].sort();
  if (!names.length) throw new Error('bundle_inputs_missing');
  const inputs = [], packages = [];
  for (const name of names) {
    // 本地 esbuild 入口没有虚拟输入；出现插件/虚拟输入时拒绝推定其内容。
    if (name.startsWith('<') || name.includes('\0')) throw new Error('bundle_input_unmeasurable');
    const absolute = path.resolve(directory, name), relative = path.relative(directory, absolute).replaceAll('\\', '/');
    const row = { inputDigest: digest(relative), contentDigest: digest(await readFile(absolute)) };
    inputs.push(row);
    if (/(?:^|\/)(?:node_modules\/@cc-desk\/[^/]+|packages\/[^/]+)\/dist\//u.test(relative)) packages.push(row);
  }
  return { source: 'esbuild_metafile_actual_inputs', inputHashTiming: 'after_bundle', bundleInputsDigest: digest(JSON.stringify(inputs)),
    packageRuntimeDigest: packages.length ? digest(JSON.stringify(packages)) : null, bundleInputCount: inputs.length, packageRuntimeInputCount: packages.length };
}
