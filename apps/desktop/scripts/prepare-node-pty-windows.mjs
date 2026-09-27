import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
export const nodePtyPatch = Object.freeze({
  version: '1.1.0', nodeGypVersion: '12.4.0',
  files: Object.freeze({
    'src/win/conpty.cc': Object.freeze({ before: '52c893b689ab3210c0961e2a6aa805a82350003767b21069b164926b5becd4e2', after: 'ba5e9dc31012b4539ee14267b2582de434523848200adf25dcb71fb11acf4f56' }),
    'lib/windowsPtyAgent.js': Object.freeze({ before: '8636d16b38266112204061a22b135734177c242837982fd3a4055be726efa64a', after: '2c24fe608aa036af41836f8314c50cc5ad3a252dde5b36452aeceebf127981a9' }),
    'lib/windowsTerminal.js': Object.freeze({ before: 'c3a65716f53fed0135a8a633373d5f9c2ab092544d651f27ef0a67096dd3bcd9', after: '3fcca67eda34ec8ea44dc1949135c88f8fef392cab5f86fb13706ca78393b28b' }),
  }),
});
const patchUrl = new URL('../../../patches/node-pty-1.1.0-conpty.patch', import.meta.url);
export const sha256 = value => createHash('sha256').update(value).digest('hex');

// Apply only exact unified-diff hunks. No fuzz, path discovery or external git /
// patch executable is involved; the complete input and output are hash checked.
export function applyExactPatch(source, patch) {
  const input = source.split('\n'), lines = patch.replace(/\r\n/g, '\n').split('\n');
  const output = [];
  let cursor = 0, hunks = 0;
  for (let i = 0; i < lines.length; i++) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
    if (!header) continue;
    const start = Number(header[1]) - 1, oldCount = Number(header[2] ?? 1), newCount = Number(header[4] ?? 1);
    if (start < cursor || start > input.length) throw new Error('Invalid node-pty patch position.');
    output.push(...input.slice(cursor, start)); cursor = start;
    if (output.length !== Number(header[3]) - 1) throw new Error('Invalid node-pty patch output position.');
    let removed = 0, added = 0;
    while (removed < oldCount || added < newCount) {
      const line = lines[++i], kind = line?.[0], value = line?.slice(1);
      if (kind !== ' ' && kind !== '-' && kind !== '+') throw new Error('Invalid node-pty patch hunk.');
      if (kind !== '+') {
        if (input[cursor++] !== value) throw new Error('node-pty patch context does not match.');
        removed++;
      }
      if (kind !== '-') { output.push(value); added++; }
      if (removed > oldCount || added > newCount) throw new Error('Invalid node-pty patch hunk size.');
    }
    hunks++;
  }
  if (!hunks) throw new Error('node-pty patch has no hunks.');
  return [...output, ...input.slice(cursor)].join('\n');
}

export async function applyPinnedNodePtyPatch(root) {
  const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (metadata.name !== 'node-pty' || metadata.version !== nodePtyPatch.version) {
    throw new Error(`Expected node-pty ${nodePtyPatch.version}; refusing to patch an unknown dependency.`);
  }
  const patch = (await fs.readFile(patchUrl, 'utf8')).replace(/\r\n/g, '\n');
  const sections = new Map();
  for (const section of patch.split(/(?=^--- a\/)/m).filter(value => value.trim())) {
    const header = /^--- a\/(\S+)\n\+\+\+ b\/(\S+)\n/.exec(section);
    if (!header || header[1] !== header[2] || !Object.hasOwn(nodePtyPatch.files, header[1]) || sections.has(header[1])) {
      throw new Error('Unexpected file in the pinned node-pty patch.');
    }
    sections.set(header[1], section);
  }
  if (sections.size !== Object.keys(nodePtyPatch.files).length) throw new Error('The node-pty patch is incomplete.');
  const writes = [];
  for (const [relative, hashes] of Object.entries(nodePtyPatch.files)) {
    const file = path.join(root, relative), original = await fs.readFile(file), digest = sha256(original);
    if (digest === hashes.after) continue;
    if (digest !== hashes.before) throw new Error(`Unknown node-pty ${relative} SHA-256: ${digest}`);
    const patched = applyExactPatch(original.toString('utf8'), sections.get(relative));
    if (sha256(patched) !== hashes.after) throw new Error(`node-pty ${relative} patch output SHA-256 does not match the pinned fix.`);
    writes.push([file, patched]);
  }
  // Validate every source first, so an unknown second file cannot leave the
  // first modified. An interrupted write is rejected by the next hash check.
  for (const [file, patched] of writes) await fs.writeFile(file, patched);
  return writes.length > 0;
}

export function conptyVerificationSource(root) {
  return `
    const path = require('node:path');
    const root = ${JSON.stringify(root)};
    const expected = path.join(root, 'build', 'Release', 'conpty.node');
    const direct = require(expected);
    const loaded = require(path.join(root, 'lib', 'utils.js')).loadNativeModule('conpty');
    const selected = path.resolve(root, 'lib', loaded.dir, 'conpty.node');
    if (selected !== expected || direct.ccDeskConptyFix !== 2 || loaded.module.ccDeskConptyFix !== 2) {
      throw new Error('node-pty must load the compiled cc-desk ConPTY fix from build/Release; prebuild fallback is forbidden.');
    }
    console.log('CC_DESK_CONPTY_FIX=2');
  `;
}

export function verifyBuiltConpty(root, executable = process.execPath, electron = false) {
  const result = spawnSync(executable, ['-e', conptyVerificationSource(root)], {
    encoding: 'utf8', timeout: 30_000, windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: '', NODE_V8_COVERAGE: '', ...(electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
  });
  if (result.error || result.status !== 0 || !result.stdout?.includes('CC_DESK_CONPTY_FIX=2')) {
    throw new Error(`Compiled ConPTY verification failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  }
}

export async function prepareWindowsNodePty(root) {
  if (process.platform !== 'win32') throw new Error('The Windows node-pty build must run on Windows.');
  if (!['x64', 'arm64'].includes(process.arch)) throw new Error(`Unsupported Windows node-pty build architecture: ${process.arch}`);
  const gyp = require.resolve('node-gyp/bin/node-gyp.js');
  const gypMetadata = JSON.parse(await fs.readFile(require.resolve('node-gyp/package.json'), 'utf8'));
  if (gypMetadata.version !== nodePtyPatch.nodeGypVersion) throw new Error('The pinned node-gyp version is required. Run npm ci.');
  await applyPinnedNodePtyPatch(root);
  console.log(`Building node-pty ${nodePtyPatch.version} with the cc-desk ConPTY fix (node-gyp ${gypMetadata.version}).`);
  // node-pty uses N-API: this build is loaded by both Node tests and Electron.
  // Always rebuild so a leftover prebuilt or partially built binary cannot pass.
  const result = spawnSync(process.execPath, [gyp, 'rebuild', '--release', `--arch=${process.arch}`, `--target=${process.versions.node}`, '--dist-url=https://nodejs.org/download/release'], {
    cwd: root, stdio: 'inherit', windowsHide: true, timeout: 300_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error('Patched node-pty build failed. Install Python 3 and Visual Studio 2022 C++ Build Tools with the Windows SDK and Spectre-mitigated libraries.', { cause: result.error });
  }
  // node-gyp removes build/; restore upstream's ConPTY DLL payload afterwards.
  const resources = spawnSync(process.execPath, [path.join(root, 'scripts', 'post-install.js')], {
    cwd: root, stdio: 'inherit', windowsHide: true, timeout: 30_000,
  });
  if (resources.error || resources.status !== 0) throw new Error('node-pty native resource preparation failed.', { cause: resources.error });
  verifyBuiltConpty(root);
  console.log(`Verified compiled ConPTY fix: ${sha256(await fs.readFile(path.join(root, 'build', 'Release', 'conpty.node')))}`);
}
