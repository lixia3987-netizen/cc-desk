import * as pty from 'node-pty';
import { loadNativeModule } from 'node-pty/lib/utils';
import type { TerminalLaunchSpec } from './terminal-launch';

export function assertPatchedWindowsPty(nativeModule: { ccDeskConptyFix?: unknown } = loadNativeModule('conpty').module) {
  if (nativeModule.ccDeskConptyFix !== 2) {
    throw new Error('Windows 终端组件未正确安装，请重新安装应用；源码运行需先完成依赖构建。');
  }
}

/** Validate before node-pty allocates native pipes or forwarding workers. */
export function spawnTerminal(launch: TerminalLaunchSpec, cwd: string,
  platform: NodeJS.Platform = process.platform, spawn: typeof pty.spawn = pty.spawn) {
  // node-pty 1.1.0 serializes {} as one NUL, not a valid empty Windows env block.
  // Never silently inherit process.env: providers explicitly own their environment.
  if (platform === 'win32' && Object.keys(launch.env).length === 0) {
    throw new Error('Windows 终端启动环境不能为空，请由执行器明确提供环境变量。');
  }
  if (platform === 'win32' && spawn === pty.spawn) assertPatchedWindowsPty();
  return spawn(launch.file, launch.args, { name: 'xterm-256color', cwd, env: launch.env, cols: 100, rows: 30 });
}
