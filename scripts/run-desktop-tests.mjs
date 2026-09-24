import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const args = [require.resolve('@playwright/test/cli'), 'test', ...process.argv.slice(2)];
const needsDisplay = process.platform === 'linux' && !process.env.DISPLAY?.trim();
// Electron's ordinary BrowserWindow needs X11; Ozone headless is not a substitute.
const command = needsDisplay ? 'xvfb-run' : process.execPath;
const commandArgs = needsDisplay
  ? ['-a', '-s', '-screen 0 1920x1080x24 -nolisten tcp', process.execPath, ...args]
  : args;
const ownProcessGroup = process.platform !== 'win32';
const child = spawn(command, commandArgs, { cwd: root, env: process.env, stdio: 'inherit', detached: ownProcessGroup });
let launchFailed = false;
const forwardSignal = signal => {
  if (!ownProcessGroup) { child.kill(signal); return; }
  // A dedicated group includes xvfb-run and Playwright descendants, without
  // signalling this runner or any other process in the caller's terminal group.
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
};
const interrupt = () => forwardSignal('SIGINT');
const terminate = () => forwardSignal('SIGTERM');
process.once('SIGINT', interrupt);
process.once('SIGTERM', terminate);
child.once('error', error => {
  launchFailed = true;
  if (needsDisplay && error.code === 'ENOENT') {
    console.error('Linux 桌面测试需要 Xvfb。未找到 xvfb-run，请安装 xvfb 和 xauth（Ubuntu/Debian：sudo apt-get install xvfb xauth），或提供可用的 DISPLAY。');
  } else console.error(`无法启动桌面测试：${error.message}`);
  process.exitCode = 1;
});
child.once('close', (code, signal) => {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', terminate);
  if (!launchFailed) process.exitCode = code ?? (signal ? 128 + constants.signals[signal] : 1);
});
