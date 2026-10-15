import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { prepareWindowsNodePty } from './prepare-node-pty-windows.mjs';

const require = createRequire(import.meta.url);
const root = path.dirname(require.resolve('node-pty/package.json'));

if (process.platform === 'win32') await prepareWindowsNodePty(root);

// node-pty 1.1.0 发布的 Darwin spawn-helper 文件缺少可执行权限位。
// macOS 通过 posix_spawnp 调用此辅助程序，因此仅完成 npm install
// 仍不够。应在依赖安装完成后、测试与打包开始前运行此脚本。
if (process.platform !== 'win32') {
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
