import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { nodePtyPatch, sha256, verifyBuiltConpty } from './prepare-node-pty-windows.mjs';

const require = createRequire(import.meta.url);

export default async function verifyNativePackage(context) {
  if (context.electronPlatformName !== 'win32') return;
  const installedRoot = path.dirname(require.resolve('node-pty/package.json'));
  const resources = path.join(context.appOutDir, 'resources');
  const packagedRoot = path.join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty');
  const relativeBinary = path.join('build', 'Release', 'conpty.node');
  const [built, packaged] = await Promise.all([
    fs.readFile(path.join(installedRoot, relativeBinary)),
    fs.readFile(path.join(packagedRoot, relativeBinary)),
  ]);
  if (sha256(built) !== sha256(packaged)) throw new Error('Packaged ConPTY binary does not match the verified source build.');
  for (const [relative, hashes] of Object.entries(nodePtyPatch.files)) {
    if (relative.endsWith('.js') && sha256(await fs.readFile(path.join(packagedRoot, relative))) !== hashes.after) {
      throw new Error(`Packaged node-pty ${relative} does not include the pinned lifecycle fix.`);
    }
  }
  const executable = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  // Run the actual packaged Electron executable and its ASAR loader. A source
  // check alone cannot prove builder copied the patched native module.
  verifyBuiltConpty(path.join(resources, 'app.asar', 'node_modules', 'node-pty'), executable, true);
  console.log(`Verified packaged ConPTY fix: ${sha256(packaged)}`);
}
