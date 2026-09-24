import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
interface Operations {
  signal(pid: number, signal: NodeJS.Signals): unknown;
  list(): Promise<string>;
}
const nativeOperations: Operations = {
  signal: (pid, signal) => process.kill(pid, signal),
  list: async () => (await execFileAsync('ps', ['-eo', 'pgid=,stat='], { timeout: 1500, maxBuffer: 2 * 1024 * 1024 })).stdout,
};

/** Signal an owned process group; only proven absent or zombie-only groups count as stopped. */
export async function signalPosixGroup(pid: number, signal: NodeJS.Signals, operations: Operations = nativeOperations): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('无法确认会话进程组身份。');
  try { operations.signal(-pid, signal); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return;
    if (code === 'EPERM') {
      // Darwin killpg filters zombies, then returns EPERM when no eligible member
      // remains. A real permission failure must still prevent a CLI update.
      try {
        const rows = (await operations.list()).trim().split('\n').map(line => line.match(/^\s*(\d+)\s+([A-Z]\S*)\s*$/));
        if (rows.every(row => row !== null) && !rows.some(row => Number(row![1]) === pid && !row![2].startsWith('Z'))) return;
      } catch { /* Failure to inspect the group cannot establish that it stopped. */ }
    }
    throw error;
  }
}
