import path from 'node:path';
import fs from 'node:fs/promises';
import { environment, execFileAsync } from './commands';
import type { GitInfo } from '../shared/types';
import { readProjectFile, resolveProjectFile } from './files';
import type { GitChange, GitChanges, GitDiff, WorktreeInfo, WorktreeActionResult } from '../shared/git';

const MAX_DIFF = 256 * 1024;
const OWNER_FILE = 'workbench-owner.json';
interface Ownership { version: 1; sessionId: string; basePath: string; branch: string; baseBranch: string }

async function git(cwd: string, args: string[], maxBuffer = 2 * 1024 * 1024): Promise<string> {
  const result = await execFileAsync('git', ['--literal-pathspecs', ...args], { cwd, env: environment(), windowsHide: true, timeout: 20000, maxBuffer });
  return result.stdout;
}
async function gitDirectory(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--absolute-git-dir'])).trim();
}
export async function gitWorktreeRoot(cwd: string): Promise<string> {
  return fs.realpath((await git(cwd, ['rev-parse', '--show-toplevel'])).trim());
}
function errorMessage(error: unknown): string { return String((error as Error).message).slice(0, 1000); }

const mutations = new Set<string>();
async function withGitMutation<T>(cwd: string, action: () => Promise<T>): Promise<T> {
  // Serialize shared refs/registration across all linked worktrees, while allowing
  // ordinary sessions in independent worktrees to continue using their files.
  const common = await fs.realpath((await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  const key = process.platform === 'win32' ? common.toLowerCase() : common;
  if (mutations.has(key)) throw new Error('此项目正在执行另一个 Git 操作。');
  mutations.add(key);
  try { return await action(); } finally { mutations.delete(key); }
}

export async function createWorktree(cwd: string, root: string, id: string): Promise<string> {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('无效的会话标识。');
  return withGitMutation(cwd, async () => {
  await git(cwd, ['rev-parse', '--verify', 'HEAD']);
  const basePath = await fs.realpath(cwd);
  const baseBranch = (await git(cwd, ['branch', '--show-current'])).trim();
  if (!baseBranch) throw new Error('请先切换到一个分支，再创建隔离工作区。');
  const branch = `workbench/${id.slice(0, 8)}`;
  const destination = path.join(root, 'worktrees', id.slice(0,8));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await git(cwd, ['worktree', 'add', '-b', branch, destination, 'HEAD']);
  const owner: Ownership = { version: 1, sessionId: id, basePath, branch, baseBranch };
  try { await fs.writeFile(path.join(await gitDirectory(destination), OWNER_FILE), JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    await git(cwd, ['worktree', 'remove', '--', destination]).catch(() => undefined);
    throw error;
  }
  return destination;
  });
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

export async function gitChanges(cwd: string): Promise<GitChanges> {
  try {
    const [branch, repoRoot, raw] = await Promise.all([
      git(cwd, ['branch', '--show-current']), git(cwd, ['rev-parse', '--show-toplevel']),
      git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'])
    ]);
    const root = await fs.realpath(repoRoot.trim());
    const current = await fs.realpath(cwd);
    const records = raw.split('\0');
    const changes: GitChange[] = [];
    let truncated = false;
    for (let i = 0; i < records.length; i++) {
      const record = records[i]; if (record.length < 4) continue;
      const status = record.slice(0, 2);
      const file = path.relative(current, path.join(root, record.slice(3))).split(path.sep).join('/');
      const old = /[RC]/.test(status) ? records[++i] : undefined;
      if (file === '..' || file.startsWith('../') || path.isAbsolute(file)) continue;
      const untracked = status === '??';
      changes.push({ path: file, originalPath: old ? path.relative(current, path.join(root, old)).split(path.sep).join('/') : undefined,
        indexStatus: status[0], worktreeStatus: status[1], staged: !untracked && status[0] !== ' ',
        unstaged: untracked || status[1] !== ' ', untracked, conflicted: ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(status) });
      if (changes.length >= 4000) { truncated = records.slice(i + 1).some(Boolean); break; }
    }
    return { available: true, branch: branch.trim() || 'detached HEAD', changes, truncated };
  } catch (error) { return { available: false, changes: [], truncated: false, error: errorMessage(error) }; }
}

export async function gitDiff(cwd: string, relative: string, staged = false): Promise<GitDiff> {
  await resolveProjectFile(cwd, relative, true);
  const changes = await gitChanges(cwd);
  if (!changes.available) throw new Error(changes.error || '无法读取 Git 状态。');
  const change = changes.changes.find(item => item.path === relative);
  if (change?.untracked && !staged) {
    const file = await readProjectFile(cwd, relative);
    const text = file.binary ? '二进制新文件（不显示内容）' : `diff --git a/${relative} b/${relative}\nnew file\n--- /dev/null\n+++ b/${relative}\n${file.content.split('\n').map(line => `+${line}`).join('\n')}`;
    return { path: relative, staged, text: text.slice(0, MAX_DIFF), binary: file.binary, truncated: file.truncated || text.length > MAX_DIFF };
  }
  const paths = [relative];
  // Both sides are required for rename detection. Never trust an old path merely
  // because it came from Git: a session can be scoped to a repository subdirectory.
  if (staged && change?.originalPath && /[RC]/.test(change.indexStatus)) {
    await resolveProjectFile(cwd, change.originalPath, true);
    paths.push(change.originalPath);
  }
  let text: string; let truncated = false;
  try { text = await git(cwd, ['diff', ...(staged ? ['--cached'] : []), '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--', ...paths], MAX_DIFF); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw error;
    text = String((error as { stdout?: string }).stdout ?? ''); truncated = true;
  }
  return { path: relative, staged, text: text.slice(0, MAX_DIFF), binary: /(?:Binary files .* differ|GIT binary patch)/.test(text), truncated: truncated || text.length > MAX_DIFF };
}

async function ownership(basePath: string, worktreePath: string, sessionId: string): Promise<Ownership | undefined> {
  try {
    const [base, child, commonBase, commonChild, directory] = await Promise.all([
      fs.realpath(basePath), fs.realpath(worktreePath), git(basePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      git(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']), gitDirectory(worktreePath)
    ]);
    if (base === child || await fs.realpath(commonBase.trim()) !== await fs.realpath(commonChild.trim())) return;
    if (await fs.realpath(directory) === await fs.realpath(commonBase.trim())) return;
    const owner = JSON.parse(await fs.readFile(path.join(directory, OWNER_FILE), 'utf8')) as Ownership;
    const branch = (await git(worktreePath, ['branch', '--show-current'])).trim();
    if (owner.version !== 1 || owner.sessionId !== sessionId || owner.basePath !== base || owner.branch !== branch || branch !== `workbench/${sessionId.slice(0, 8)}` || !owner.baseBranch) return;
    const registered = await git(basePath, ['worktree', 'list', '--porcelain', '-z']);
    const registeredPaths = await Promise.all(registered.split('\0').filter(record => record.startsWith('worktree ')).map(record => fs.realpath(record.slice(9)).catch(() => '')));
    if (!registeredPaths.includes(child)) return;
    return owner;
  } catch { return; }
}

export async function worktreeInfo(basePath: string, worktreePath: string, sessionId: string, running = false): Promise<WorktreeInfo> {
  const result: WorktreeInfo = { owned: false, path: worktreePath, basePath, clean: false, baseClean: false, merged: false, canMerge: false, canCleanup: false, reasons: [] };
  const owner = await ownership(basePath, worktreePath, sessionId);
  if (!owner) { result.reasons.push('此工作区缺少匹配的应用所有权记录，不能自动合并或清理。'); return result; }
  result.owned = true; result.branch = owner.branch; result.baseBranch = owner.baseBranch;
  try {
    const [status, baseStatus, baseBranch, ignored] = await Promise.all([
      git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']), git(basePath, ['status', '--porcelain=v1', '--untracked-files=all']),
      git(basePath, ['branch', '--show-current']), git(worktreePath, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])
    ]);
    result.clean = !status.trim(); result.baseClean = !baseStatus.trim();
    const targetMatches = baseBranch.trim() === owner.baseBranch;
    result.merged = await git(basePath, ['merge-base', '--is-ancestor', owner.branch, `refs/heads/${owner.baseBranch}`]).then(() => true, () => false);
    const forward = await git(basePath, ['merge-base', '--is-ancestor', `refs/heads/${owner.baseBranch}`, owner.branch]).then(() => true, () => false);
    if (running) result.reasons.push('请先停止使用此工作区的所有会话。');
    if (!result.clean) result.reasons.push('工作区存在未提交或未跟踪文件，请先处理。');
    if (!result.baseClean) result.reasons.push('主项目存在未提交更改，不能自动合并。');
    if (!targetMatches) result.reasons.push(`主项目已切换分支；请切回 ${owner.baseBranch} 后操作。`);
    if (!result.merged && !forward) result.reasons.push('分支已经分叉，请手动合并并解决冲突；自动合并仅允许快进。');
    if (ignored) result.reasons.push('工作区含被 Git 忽略的文件，清理前请移走或自行删除。');
    result.canMerge = !running && result.clean && result.baseClean && targetMatches && (forward || result.merged);
    result.canCleanup = !running && result.clean && result.merged && !ignored;
  } catch (error) { result.reasons.push(errorMessage(error)); }
  return result;
}

async function mutate(basePath: string, action: () => Promise<WorktreeActionResult>): Promise<WorktreeActionResult> {
  try { return await withGitMutation(basePath, action); }
  catch (error) { return { ok: false, status: 'blocked', message: errorMessage(error) }; }
}

export async function mergeWorktree(basePath: string, worktreePath: string, sessionId: string, running = false): Promise<WorktreeActionResult> {
  return mutate(basePath, async () => {
    const info = await worktreeInfo(basePath, worktreePath, sessionId, running);
    if (!info.canMerge || !info.branch) return { ok: false, status: 'blocked', message: info.reasons.join('\n') };
    try {
      await git(basePath, ['merge', '--ff-only', '--no-edit', '--', info.branch]);
      return { ok: true, status: 'merged', message: '已将工作区提交快进合并到主项目；工作区和分支仍保留。' };
    } catch (error) { return { ok: false, status: 'blocked', message: `合并未完成，已保留所有文件和分支。${errorMessage(error)}` }; }
  });
}

export async function cleanupWorktree(basePath: string, worktreePath: string, sessionId: string, running = false): Promise<WorktreeActionResult> {
  return mutate(basePath, async () => {
    const info = await worktreeInfo(basePath, worktreePath, sessionId, running);
    if (!info.canCleanup) return { ok: false, status: 'blocked', message: info.reasons.join('\n') || '工作区提交尚未合并，不能清理。' };
    try {
      await git(basePath, ['worktree', 'remove', '--', worktreePath]);
      return { ok: true, status: 'removed', message: '已移除干净且已合并的工作区；分支保留，可手动删除。' };
    } catch (error) { return { ok: false, status: 'blocked', message: `工作区未被强制删除。${errorMessage(error)}` }; }
  });
}
