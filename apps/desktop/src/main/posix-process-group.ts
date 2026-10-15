import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { linuxLiveProcesses } from '@cc-desk/agent-node/process-supervisor';

const execFileAsync = promisify(execFile);
interface Operations {
  signal(pid: number, signal: NodeJS.Signals): unknown;
  list(): Promise<string>;
  isLive?(pid: number): Promise<boolean>;
}
const nativeOperations: Operations = {
  signal: (pid, signal) => process.kill(pid, signal),
  list: async () => (await execFileAsync('/bin/ps', ['-eo', 'pgid=,stat='], { timeout: 1500, maxBuffer: 2 * 1024 * 1024 })).stdout,
  ...(process.platform === 'linux' ? { isLive: async (pid: number) => (await linuxLiveProcesses({ group: pid })).length > 0 } : {}),
};

/** 向持有的进程组发送信号；仅已证实不存在或仅含僵尸进程的组视为已停止。 */
export async function signalPosixGroup(pid: number, signal: NodeJS.Signals, operations: Operations = nativeOperations): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('无法确认会话进程组身份。');
  try { operations.signal(-pid, signal); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return;
    if (code === 'EPERM') {
      // Darwin killpg 会过滤僵尸进程，在没有符合条件的成员
      // 时返回 EPERM。真实权限失败仍须阻止 CLI 更新。
      try {
        if (operations.isLive) {
          if (!await operations.isLive(pid)) return;
          throw error;
        }
        const rows = (await operations.list()).trim().split('\n').map(line => line.match(/^\s*(\d+)\s+([A-Z]\S*)\s*$/));
        if (rows.every(row => row !== null) && !rows.some(row => Number(row![1]) === pid && !row![2].startsWith('Z'))) return;
      } catch { /* 无法检查进程组不能证明它已停止。 */ }
    }
    throw error;
  }
}
