import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
// @ts-expect-error Build scripts are plain ESM and have no TypeScript declarations.
import { applyPinnedNodePtyPatch, conptyVerificationSource, nodePtyPatch, sha256 } from '../scripts/prepare-node-pty-windows.mjs';

const require = createRequire(import.meta.url);
const installedRoot = path.dirname(require.resolve('node-pty/package.json'));
const files = Object.keys(nodePtyPatch.files);

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-desk-native-build-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.1.0' }));
  for (const relative of files) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.copyFile(path.join(installedRoot, relative), path.join(root, relative));
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
    // Exercise the actual verifier with isolated JS stand-ins for native exports.
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
