import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

// node-pty 1.1.0 ships Darwin spawn-helper files without executable mode bits.
// macOS uses posix_spawnp on this helper, so a successful npm install alone is
// insufficient. Run after dependency installation, before tests and packaging.
if (process.platform !== 'win32') {
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve('node-pty/package.json'));
  const directories = ['prebuilds/darwin-arm64', 'prebuilds/darwin-x64', 'build/Release', 'build/Debug'];
  let prepared = 0;
  for (const directory of directories) {
    const helper = path.join(root, directory, 'spawn-helper');
    let stat;
    try { stat = await fs.lstat(helper); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile()) throw new Error(`Expected a regular node-pty spawn helper: ${helper}`);
    await fs.chmod(helper, (stat.mode & 0o777) | 0o111);
    prepared++;
  }
  if (process.platform === 'darwin' && prepared === 0) throw new Error('node-pty spawn-helper is missing. Reinstall dependencies before building.');
  console.log(`Prepared ${prepared} node-pty spawn helper(s).`);
}
