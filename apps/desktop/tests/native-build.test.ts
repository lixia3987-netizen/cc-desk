import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
// @ts-expect-error 构建脚本是普通 ESM，没有 TypeScript 类型声明。
import { applyExactPatch, applyPinnedNodePtyPatch, conptyVerificationSource, nodePtyPatch, sha256, windowsNodePtyBuildArguments, windowsNodePtyBuildEnvironment, verifyConptyResources } from '../scripts/prepare-node-pty-windows.mjs';

const require = createRequire(import.meta.url);
const installedRoot = path.dirname(require.resolve('node-pty/package.json'));
const files = Object.keys(nodePtyPatch.files);

test('Windows rebuild cleans stale binaries and builds both ConPTY modules without legacy winpty', () => {
  const gyp = require('node-gyp/lib/node-gyp.js')();
  const args = windowsNodePtyBuildArguments('node-gyp.js', 'arm64', '22.12.0');
  gyp.parseArgv([process.execPath, ...args]);
  assert.deepEqual(gyp.todo, [
    { name: 'clean', args: [] },
    { name: 'configure', args: [] },
    { name: 'build', args: ['conpty', 'conpty_console_list'] },
  ]);
  assert.equal(gyp.opts.arch, 'arm64');
  assert.equal(gyp.opts.target, '22.12.0');
  assert.equal(gyp.opts.debug, false);
  assert.equal(gyp.opts['dist-url'], 'https://nodejs.org/download/release');
});

test('Windows native build and bundled resources use the same architecture despite inherited npm configuration', () => {
  const inherited = { npm_config_arch: 'arm64', NPM_CONFIG_ARCH: 'ia32', Path: 'preserved', npm_config_python: 'python.exe' };
  const environment = windowsNodePtyBuildEnvironment(inherited, 'x64');
  assert.deepEqual(environment, { Path: 'preserved', npm_config_python: 'python.exe', npm_config_arch: 'x64' });
  assert.equal(inherited.npm_config_arch, 'arm64', 'the parent environment remains unchanged');
  assert.equal(inherited.NPM_CONFIG_ARCH, 'ia32');
  assert.throws(() => windowsNodePtyBuildEnvironment(inherited, 'ia32'), /Unsupported Windows/);
});

test('resource preparation verifies the actual upstream copy and rejects resources for another architecture', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-desk-conpty-resources-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const source = path.join(installedRoot, 'third_party', 'conpty');
  const versions = await fs.readdir(source);
  assert.equal(versions.length, 1);
  for (const arch of ['x64', 'arm64']) {
    const directory = path.join('third_party', 'conpty', versions[0], `win10-${arch}`);
    await fs.mkdir(path.join(root, directory), { recursive: true });
    for (const name of ['conpty.dll', 'OpenConsole.exe']) {
      await fs.copyFile(path.join(installedRoot, directory, name), path.join(root, directory, name));
    }
  }
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.copyFile(path.join(installedRoot, 'scripts', 'post-install.js'), path.join(root, 'scripts', 'post-install.js'));
  // 执行依赖随包提供的真实资源复制脚本；不创建或加载替代原生模块。
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'post-install.js')], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
    env: windowsNodePtyBuildEnvironment({ ...process.env, npm_config_arch: 'arm64', NPM_CONFIG_ARCH: 'ia32' }, 'x64'),
  });
  assert.equal(result.status, 0, result.stderr);
  await verifyConptyResources(root, 'x64');
  await assert.rejects(verifyConptyResources(root, 'arm64'), /does not match the bundled arm64 resource/);
  await fs.copyFile(path.join(source, versions[0], 'win10-arm64', 'OpenConsole.exe'), path.join(root, 'build', 'Release', 'conpty', 'OpenConsole.exe'));
  await assert.rejects(verifyConptyResources(root, 'x64'), /OpenConsole.exe does not match/);
  await fs.unlink(path.join(root, 'build', 'Release', 'conpty', 'conpty.dll'));
  await assert.rejects(verifyConptyResources(root, 'x64'), { code: 'ENOENT' });
});

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-desk-native-build-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.1.0' }));
  const patch = (await fs.readFile(new URL('../../../patches/node-pty-1.1.0-conpty.patch', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  for (const relative of files) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    let source = await fs.readFile(path.join(installedRoot, relative), 'utf8');
    if (sha256(source) === nodePtyPatch.files[relative].after) {
      const section = patch.split(/(?=^--- a\/)/m).find(value => value.startsWith(`--- a/${relative}\n`));
      assert.ok(section, `missing pinned patch section: ${relative}`);
      const reverse = section.replace(/^@@ -(\d+)(,\d+)? \+(\d+)(,\d+)? @@/gm, '@@ -$3$4 +$1$2 @@')
        .split('\n').map(line => line[0] === '+' ? `-${line.slice(1)}` : line[0] === '-' ? `+${line.slice(1)}` : line).join('\n');
      source = applyExactPatch(source, reverse);
    }
    // 即使 postinstall 已修补安装的依赖，也要使用全新的上游输入进行测试；
    // 否则重复运行可能跳过所有补丁块。
    assert.equal(sha256(source), nodePtyPatch.files[relative].before, relative);
    await fs.writeFile(path.join(root, relative), source);
  }
  return root;
}

test('the pinned ConPTY patch accepts only known source and is repeatable', async t => {
  const root = await fixture(t);
  await applyPinnedNodePtyPatch(root);
  for (const relative of files) {
    assert.equal(sha256(await fs.readFile(path.join(root, relative))), nodePtyPatch.files[relative].after, relative);
  }
  assert.equal(await applyPinnedNodePtyPatch(root), false, 'already patched source remains unchanged');
});

test('unknown ConPTY source or dependency version fails before changing another file', async t => {
  const root = await fixture(t), first = path.join(root, files[0]), second = path.join(root, files[1]);
  const original = await fs.readFile(first);
  await fs.appendFile(second, '\n// unexpected local edit\n');
  await assert.rejects(applyPinnedNodePtyPatch(root), /Unknown node-pty .* SHA-256/);
  assert.deepEqual(await fs.readFile(first), original);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.2.0' }));
  await assert.rejects(applyPinnedNodePtyPatch(root), /unknown dependency/);
});

test('native verification rejects a stale binary or loader fallback even when the other module is patched', async t => {
  const root = await fixture(t);
  const release = path.join(root, 'build', 'Release', 'conpty.node');
  const prebuild = path.join(root, 'prebuilds', 'win32-x64', 'conpty.node');
  for (const file of [release, prebuild]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'exports.ccDeskConptyFix = 2;');
  }
  const loader = path.join(root, 'lib', 'utils.js');
  const select = async (directory: string) => fs.writeFile(loader,
    `exports.loadNativeModule = () => ({dir: ${JSON.stringify(directory)}, module: require(${JSON.stringify(directory + '/conpty.node')})});`);
  const verify = () => spawnSync(process.execPath, ['-e',
    // 使用原生导出的独立 JS 替代实现，验证真实校验器。
    `require.extensions['.node'] = require.extensions['.js'];\n${conptyVerificationSource(root)}`,
  ], { encoding: 'utf8', timeout: 10_000 });
  await select('../build/Release');
  let result = verify();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CC_DESK_CONPTY_FIX=2/);
  await select('../prebuilds/win32-x64');
  result = verify();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /prebuild fallback is forbidden/);
  await select('../build/Release');
  await fs.writeFile(release, 'exports.ccDeskConptyFix = 1;');
  result = verify();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /prebuild fallback is forbidden/);
});
