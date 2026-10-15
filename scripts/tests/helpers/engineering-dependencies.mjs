import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const workspaceNames = ['contracts', 'engine-claude', 'agent-core', 'agent-node'];
const sha = value => createHash('sha256').update(value).digest('hex');
const json = async filename => JSON.parse(await fs.readFile(filename, 'utf8'));

// 普通文件副本适用于没有创建链接权限的 Windows，也避免将候选包误指向评估器的构建结果。
async function copyOrdinaryTree(source, destination) {
  const stat = await fs.lstat(source);
  assert.equal(stat.isSymbolicLink(), false, `Dependency copies require ordinary entries: ${source}`);
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    for (const name of await fs.readdir(source)) {
      if (name !== 'node_modules') await copyOrdinaryTree(path.join(source, name), path.join(destination, name));
    }
    return;
  }
  assert.equal(stat.isFile(), true, `Dependency copies require ordinary files: ${source}`);
  const before = await fs.readFile(source);
  await fs.copyFile(source, destination);
  await fs.chmod(destination, stat.mode);
  assert.equal(sha(await fs.readFile(destination)), sha(before), `Dependency copy differs: ${source}`);
  assert.equal(sha(await fs.readFile(source)), sha(before), `Dependency changed while copying: ${source}`);
}

/** 仅准备本集成场景的真实候选依赖，不运行 npm 钩子，也不替换评估器工具或校验逻辑。 */
export async function prepareEngineeringDependencies(repository, candidate) {
  const installedRoot = path.join(repository, 'node_modules');
  const candidateModules = path.join(candidate, 'node_modules');
  const installedLock = await json(path.join(repository, 'package-lock.json'));
  const candidateLock = await json(path.join(candidate, 'package-lock.json'));
  await fs.mkdir(candidateModules);
  const copied = new Set();

  const copyPackage = async (name, fromModules = installedRoot, intoModules = candidateModules) => {
    assert.match(name, /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i);
    const source = path.join(fromModules, name);
    const destination = path.join(intoModules, name);
    if (copied.has(destination)) return;
    const manifest = await json(path.join(source, 'package.json'));
    const lockPath = path.relative(repository, source).split(path.sep).join('/');
    const installed = installedLock.packages[lockPath];
    const expected = candidateLock.packages[lockPath];
    assert.ok(installed && expected && installed.integrity && expected.integrity,
      `Dependency must be present in both lockfiles: ${lockPath}`);
    assert.equal(manifest.name, name);
    assert.equal(manifest.version, expected.version, `Candidate dependency version differs: ${name}`);
    assert.equal(installed.version, expected.version, `Installed dependency version differs: ${name}`);
    assert.equal(installed.integrity, expected.integrity, `Installed dependency integrity differs: ${name}`);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await copyOrdinaryTree(source, destination);
    copied.add(destination);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      const nestedModules = path.join(source, 'node_modules');
      const nested = await fs.stat(path.join(nestedModules, dependency, 'package.json')).then(() => true,
        error => { if (error.code === 'ENOENT') return false; throw error; });
      await copyPackage(dependency, nested ? nestedModules : installedRoot,
        nested ? path.join(destination, 'node_modules') : candidateModules);
    }
  };

  for (const name of workspaceNames) {
    const manifest = await json(path.join(candidate, 'packages', name, 'package.json'));
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
      if (!dependency.startsWith('@cc-desk/')) await copyPackage(dependency);
    }
  }

  // 四个候选包在本场景中受固定基线保护。先构建并复制真实产物，让后续包通过正常解析找到前置包。
  // 固定评估器仍会独立重建它们；源码、清单和原有断言完全由评估器检查。
  const tsc = path.join(installedRoot, 'typescript', 'bin', 'tsc');
  for (const name of workspaceNames) {
    const result = spawnSync(process.execPath, [tsc, '-p', `packages/${name}/tsconfig.json`], {
      cwd: candidate, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr || result.error?.message);
    const source = path.join(candidate, 'packages', name);
    const destination = path.join(candidateModules, '@cc-desk', name);
    await fs.mkdir(destination, { recursive: true });
    await copyOrdinaryTree(path.join(source, 'package.json'), path.join(destination, 'package.json'));
    await copyOrdinaryTree(path.join(source, 'dist'), path.join(destination, 'dist'));
  }
}
