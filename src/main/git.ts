import path from 'node:path';
import fs from 'node:fs/promises';
import { environment, execFileAsync } from './commands';
import type { GitInfo } from '../shared/types';
async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, env: environment(), windowsHide: true, timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  return result.stdout;
}
export async function createWorktree(cwd: string, root: string, id: string): Promise<string> {
  await git(cwd, ['rev-parse', '--verify', 'HEAD']);
  const destination = path.join(root, 'worktrees', id.slice(0,8));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await git(cwd, ['worktree', 'add', '-b', `workbench/${id.slice(0,8)}`, destination, 'HEAD']);
  return destination;
}
export async function gitInfo(cwd: string): Promise<GitInfo> {
  try {
    const [branch, status, unstaged, staged] = await Promise.all([
      git(cwd, ['branch','--show-current']), git(cwd, ['status','--short']),
      git(cwd, ['diff','--no-ext-diff','--no-textconv','--stat']), git(cwd, ['diff','--cached','--no-ext-diff','--no-textconv','--stat'])
    ]);
    return { branch: branch.trim() || 'detached HEAD', status: status.slice(0,30000), diff: [unstaged, staged ? `已暂存：\n${staged}` : ''].filter(Boolean).join('\n').slice(0,30000) };
  } catch (error) { return { branch: '', status: '', diff: '', error: String((error as Error).message).slice(0,300) }; }
}
