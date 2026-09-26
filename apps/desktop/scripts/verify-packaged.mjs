import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const desktopRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const { version, name, productName } = JSON.parse(await fs.readFile(path.join(desktopRoot, 'package.json'), 'utf8'));
const expectedArch = process.platform === 'darwin' ? 'arm64' : 'x64';
if (process.arch !== expectedArch) throw new Error(`Package verification requires native ${expectedArch}; runner is ${process.arch}.`);
const release = path.join(repoRoot, 'release');
const prefix = `cc-desk-${version}-`;
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-release-'));
const targets = [];
const run = (file, args, options = {}) => execFileSync(file, args, { stdio: 'inherit', timeout: 180_000, ...options });
const artifact = async filename => {
  const file = path.join(release, filename);
  if ((await fs.stat(file)).size < 1024 * 1024) throw new Error(`Missing or suspiciously small package: ${file}`);
  return file;
};
const add = async (format, archive, executable) => {
  if (!(await fs.stat(executable)).isFile()) throw new Error(`Packaged executable not found: ${executable}`);
  const hash = createHash('sha256');
  for await (const data of createReadStream(archive)) hash.update(data);
  targets.push({ format, artifact: path.basename(archive), sha256: hash.digest('hex'), executable, arch: expectedArch });
};
const findExecutable = async (base, filename, depth = 0) => {
  const entries = await fs.readdir(base, { withFileTypes: true });
  const direct = entries.find(entry => entry.isFile() && entry.name === filename);
  if (direct) return path.join(base, direct.name);
  if (depth < 3) for (const entry of entries) if (entry.isDirectory()) {
    const found = await findExecutable(path.join(base, entry.name), filename, depth + 1);
    if (found) return found;
  }
  return undefined;
};
let mounted;
let uninstaller;
try {
  if (process.platform === 'win32') {
    const zip = await artifact(`${prefix}windows-x64-portable.zip`);
    const zipDirectory = path.join(directory, 'zip');
    // Environment arguments avoid interpolating filesystem paths into PowerShell source.
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:WORKBENCH_ARCHIVE -DestinationPath $env:WORKBENCH_EXTRACT -Force'], {
      env: { ...process.env, WORKBENCH_ARCHIVE: zip, WORKBENCH_EXTRACT: zipDirectory },
    });
    await add('windows-zip', zip, path.join(zipDirectory, `${productName}.exe`));

    if (process.env.GITHUB_ACTIONS !== 'true' && !process.argv.includes('--allow-install')) {
      throw new Error('NSIS verification installs and uninstalls the application. Use an expendable Windows machine and pass --allow-install.');
    }
    const setup = await artifact(`${prefix}windows-x64-setup.exe`);
    const installDirectory = path.join(directory, 'installed');
    // NSIS requires /D= last and unquoted, including destinations containing spaces.
    run(setup, ['/S', `/D=${installDirectory}`], { windowsVerbatimArguments: true });
    uninstaller = path.join(installDirectory, `Uninstall ${productName}.exe`);
    await add('windows-nsis-installed', setup, path.join(installDirectory, `${productName}.exe`));
    // The self-extracting portable launcher is shipped but not confused with ZIP/NSIS coverage.
    await artifact(`${prefix}windows-x64-portable.exe`);
  } else if (process.platform === 'darwin') {
    const zip = await artifact(`${prefix}macos-arm64-portable.zip`);
    const zipDirectory = path.join(directory, 'zip');
    run('ditto', ['-x', '-k', zip, zipDirectory]);
    await add('macos-zip', zip, path.join(zipDirectory, `${productName}.app`, 'Contents', 'MacOS', productName));
    const dmg = await artifact(`${prefix}macos-arm64-setup.dmg`);
    mounted = path.join(directory, 'volume');
    await fs.mkdir(mounted);
    run('hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-mountpoint', mounted]);
    const installedApp = path.join(directory, 'installed', `${productName}.app`);
    await fs.mkdir(path.dirname(installedApp));
    run('ditto', [path.join(mounted, `${productName}.app`), installedApp]);
    run('hdiutil', ['detach', mounted]);
    mounted = undefined;
    await add('macos-dmg-copied', dmg, path.join(installedApp, 'Contents', 'MacOS', productName));
  } else if (process.platform === 'linux') {
    const archive = await artifact(`${prefix}linux-x64-portable.tar.gz`);
    const tarDirectory = path.join(directory, 'tar');
    await fs.mkdir(tarDirectory);
    run('tar', ['-xzf', archive, '-C', tarDirectory]);
    const executable = await findExecutable(tarDirectory, name);
    if (!executable) throw new Error('Linux archive does not contain the expected executable.');
    await add('linux-tar', archive, executable);
    const appImage = await artifact(`${prefix}linux-x86_64-portable.AppImage`);
    const appImageDirectory = path.join(directory, 'appimage');
    await fs.mkdir(appImageDirectory);
    await fs.chmod(appImage, 0o755);
    // Extraction exercises the release AppImage without depending on FUSE on hosted runners.
    run(appImage, ['--appimage-extract'], { cwd: appImageDirectory, stdio: 'ignore' });
    await add('linux-appimage-extracted', appImage, path.join(appImageDirectory, 'squashfs-root', name));
  } else {
    throw new Error(`Unsupported package platform: ${process.platform}`);
  }
  const manifest = path.join(directory, 'targets.json');
  await fs.writeFile(manifest, JSON.stringify(targets, null, 2));
  const report = path.join(repoRoot, 'test-results', 'packaged-manifest.json');
  await fs.mkdir(path.dirname(report), { recursive: true });
  const reportData = {
    platform: process.platform, arch: expectedArch, version,
    sourceCommit: process.env.GITHUB_SHA ?? null, verified: false, targets,
    limitations: ['No signing, notarization, SmartScreen or Gatekeeper acceptance check.',
      'Windows self-extracting portable launcher and Linux FUSE mounting are not exercised.',
      ...(process.platform === 'darwin' ? ['macOS test launches use --use-mock-keychain; real OS Keychain storage and prompts are not exercised.'] : [])],
  };
  await fs.writeFile(report, JSON.stringify(reportData, null, 2));
  run(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--config', path.join(desktopRoot, 'playwright.packaged.config.ts')], {
    cwd: desktopRoot, timeout: 600_000, env: { ...process.env, WORKBENCH_PACKAGED_TARGETS: manifest },
  });
  reportData.verified = true;
  await fs.writeFile(report, JSON.stringify(reportData, null, 2));
} finally {
  if (mounted) run('hdiutil', ['detach', mounted]);
  if (uninstaller) {
    // NSIS self-copies unless _?= is used; direct execution lets the test await removal.
    run(uninstaller, ['/S', `_?=${path.dirname(uninstaller)}`], { windowsVerbatimArguments: true });
  }
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
