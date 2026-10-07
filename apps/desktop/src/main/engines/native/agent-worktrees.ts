import { execFile, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { containsPath, ensureWorktreeParent } from '../../worktree-paths';

const execute = promisify(execFile);
const MAX_GIT_BYTES = 16 * 1024 * 1024;
const MAX_UNTRACKED_BYTES = 64 * 1024 * 1024;

export interface NativeAgentBaseline {
  repositoryRoot: string;
  /** Preserve a parent session rooted in a repository subdirectory. */
  relativeCwd: string;
  parentHead: string;
  mode: 'head' | 'snapshot';
  dirty: boolean;
  fingerprint: string;
}
export interface NativeAgentWorktree {
  path: string;
  cwd: string;
  branch: string;
  baseCommit: string;
  parentHead: string;
  baseline: 'head' | 'snapshot';
}
export interface NativeAgentWorkspaceEvidence {
  head: string;
  baseCommit: string;
  changedFiles: Array<{ path: string; status: string }>;
  /** Includes tracked, deleted and non-ignored new files without changing the index. */
  patch: Buffer;
}

export class NativeAgentWorktreeError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'NativeAgentWorktreeError'; }
}

/** Git operations receive argv directly. No shell, hooks, prompts or inherited index override. */
async function gitBytes(cwd: string, args: string[], signal?: AbortSignal, extraEnv: NodeJS.ProcessEnv = {}, input?: Buffer): Promise<Buffer> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
  const pending = execute('git', ['-c', 'core.hooksPath=', '-c', 'core.quotePath=false', '-C', cwd, ...args], {
    encoding: 'buffer', maxBuffer: MAX_GIT_BYTES, timeout: 30000, windowsHide: true, signal, env: { ...env, ...extraEnv },
  });
  // The promisified execFile exposes its ChildProcess; stdin is a literal byte stream.
  // This preserves NUL-separated Git index entries without shell quoting or temp scripts.
  if (input) (pending as typeof pending & { child: ChildProcess }).child.stdin!.end(input);
  const result = await pending;
  return result.stdout;
}
async function git(cwd: string, args: string[], signal?: AbortSignal, extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  return (await gitBytes(cwd, args, signal, extraEnv)).toString('utf8');
}

async function workspaceFingerprint(root: string, signal?: AbortSignal): Promise<{ head: string; fingerprint: string; dirty: boolean }> {
  const head = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)).trim();
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal);
  const diff = await gitBytes(root, ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], signal);
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'], signal)).split('\0').filter(Boolean);
  const hash = createHash('sha256').update(head).update('\0').update(status).update('\0').update(diff);
  let bytes = 0;
  for (const entry of untracked.sort()) {
    if (signal?.aborted) throw new NativeAgentWorktreeError('cancelled', '子工作区快照已取消。');
    const target = path.resolve(root, entry);
    if (!containsPath(root, target) || target === root) throw new NativeAgentWorktreeError('invalid_path', 'Git 返回了无效的项目路径。');
    const stat = await fs.lstat(target);
    hash.update('\0').update(entry).update('\0');
    if (stat.isSymbolicLink()) hash.update(await fs.readlink(target));
    else {
      if (!stat.isFile() || (bytes += stat.size) > MAX_UNTRACKED_BYTES) throw new NativeAgentWorktreeError('snapshot_too_large', '未跟踪文件快照超出限制，请先明确整理项目基线。');
      hash.update(await fs.readFile(target));
    }
  }
  // A changed HEAD or status is evidence that this observation crossed a mutation.
  if ((await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)).trim() !== head ||
      await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal) !== status) {
    throw new NativeAgentWorktreeError('baseline_changed', '父工作区正在变化，请重新确认委派基线。');
  }
  return { head, fingerprint: hash.digest('hex'), dirty: status.length > 0 };
}

/** Observe only; no stash, commit, index change or checkout of the parent workspace. */
export async function prepareAgentBaseline(cwd: string, mode: 'head' | 'snapshot', signal?: AbortSignal): Promise<NativeAgentBaseline> {
  let root: string;
  try { root = await fs.realpath((await git(cwd, ['rev-parse', '--show-toplevel'], signal)).trim()); }
  catch { throw new NativeAgentWorktreeError('git_repository_required', '隔离实现需要具有已提交 HEAD 的 Git 项目。'); }
  const canonicalCwd = await fs.realpath(cwd);
  if (!containsPath(root, canonicalCwd)) throw new NativeAgentWorktreeError('invalid_cwd', '父会话目录不属于该 Git 项目。');
  const observed = await workspaceFingerprint(root, signal);
  if (observed.dirty && mode === 'head') throw new NativeAgentWorktreeError('dirty_head_baseline', '父工作区含未提交修改；请选择 snapshot 基线，不能隐式忽略这些修改。');
  if ((await git(root, ['ls-files', '--stage'], signal)).split('\n').some(line => line.startsWith('160000 '))) {
    throw new NativeAgentWorktreeError('submodule_baseline_unsupported', '含 Git 子模块的项目需要先明确子模块隔离基线。');
  }
  return { repositoryRoot: root, relativeCwd: path.relative(root, canonicalCwd), parentHead: observed.head,
    mode, dirty: observed.dirty, fingerprint: observed.fingerprint };
}

export async function verifyAgentBaseline(baseline: NativeAgentBaseline, signal?: AbortSignal): Promise<void> {
  const current = await workspaceFingerprint(baseline.repositoryRoot, signal);
  if (current.head !== baseline.parentHead || current.fingerprint !== baseline.fingerprint) {
    throw new NativeAgentWorktreeError('baseline_changed', '父工作区基线已改变，请重新委派。');
  }
}

async function independentRoot(root: string, repositoryRoot: string): Promise<string> {
  const resolved = path.resolve(root);
  if (containsPath(repositoryRoot, resolved)) throw new NativeAgentWorktreeError('nested_worktree_root', '子 Agent 工作区必须位于父项目之外。');
  const created: string[] = [];
  await ensureWorktreeParent(resolved, created);
  const canonical = await fs.realpath(resolved);
  if (containsPath(repositoryRoot, canonical)) throw new NativeAgentWorktreeError('nested_worktree_root', '子 Agent 工作区不能通过链接指向父项目。');
  return canonical;
}

async function treeFromWorkspace(root: string, indicesRoot: string, signal?: AbortSignal): Promise<string> {
  const index = path.join(indicesRoot, `index-${randomUUID()}`), env = { GIT_INDEX_FILE: index };
  try {
    await git(root, ['read-tree', '--empty'], signal, env);
    // Include deliberately tracked ignored files and current staged entries.
    // Copy entries through Git rather than copying an index with split-index/FSMN
    // extensions whose dependencies may live next to the real index.
    const actualIndex = await gitBytes(root, ['ls-files', '--stage', '-z'], signal);
    await gitBytes(root, ['update-index', '-z', '--index-info'], signal, env, actualIndex);
    await git(root, ['add', '--all', '--', '.'], signal, env);
    return (await git(root, ['write-tree'], signal, env)).trim();
  } finally {
    // These exact files were allocated inside our verified directory, never a user index.
    await fs.rm(index, { force: true });
    await fs.rm(`${index}.lock`, { force: true });
  }
}

/** Materialize one snapshot for a batch. Git objects are added without moving parent refs. */
export async function materializeAgentBaseline(baseline: NativeAgentBaseline, root: string, signal?: AbortSignal): Promise<string> {
  const canonical = await independentRoot(root, baseline.repositoryRoot), indices = path.join(canonical, '.indices');
  await fs.mkdir(indices, { recursive: true });
  await verifyAgentBaseline(baseline, signal);
  if (!baseline.dirty) return baseline.parentHead;
  const tree = await treeFromWorkspace(baseline.repositoryRoot, indices, signal);
  await verifyAgentBaseline(baseline, signal);
  const commit = (await git(baseline.repositoryRoot, ['commit-tree', tree, '-p', baseline.parentHead, '-m', 'Native agent delegation workspace snapshot'], signal,
    { GIT_AUTHOR_NAME: 'CC Desk Native Agent', GIT_AUTHOR_EMAIL: 'native-agent@localhost', GIT_COMMITTER_NAME: 'CC Desk Native Agent', GIT_COMMITTER_EMAIL: 'native-agent@localhost' })).trim();
  await verifyAgentBaseline(baseline, signal);
  return commit;
}

export async function createAgentWorktree(baseline: NativeAgentBaseline, root: string, baseCommit: string, childId: string, signal?: AbortSignal): Promise<NativeAgentWorktree> {
  if (!/^[0-9a-f-]{36}$/i.test(childId) || !/^[0-9a-f]{40,64}$/i.test(baseCommit)) throw new NativeAgentWorktreeError('invalid_worktree_identity', '无效的子 Agent 工作区标识。');
  const canonical = await independentRoot(root, baseline.repositoryRoot);
  const destination = path.join(canonical, childId), branch = `codex/native-agent-${childId}`;
  // A partial worktree add remains recoverable. Never delete an existing path or branch.
  await git(baseline.repositoryRoot, ['worktree', 'add', '--no-track', '-b', branch, destination, baseCommit], signal);
  const observedRoot = await fs.realpath((await git(destination, ['rev-parse', '--show-toplevel'], signal)).trim());
  if (observedRoot !== await fs.realpath(destination) || (await git(destination, ['rev-parse', 'HEAD'], signal)).trim() !== baseCommit ||
      (await git(destination, ['symbolic-ref', '--short', 'HEAD'], signal)).trim() !== branch) {
    throw new NativeAgentWorktreeError('worktree_verification_failed', '子 Agent 工作区创建后的 Git 归属无法确认，已保留现场。');
  }
  return { path: destination, cwd: path.join(destination, baseline.relativeCwd), branch, baseCommit,
    parentHead: baseline.parentHead, baseline: baseline.mode };
}

/** Keep every worktree and branch. Integration is an explicit review/cherry-pick/patch action. */
export async function collectAgentWorkspaceEvidence(worktree: NativeAgentWorktree, root: string): Promise<NativeAgentWorkspaceEvidence> {
  const canonical = await independentRoot(root, worktree.path), indices = path.join(canonical, '.indices');
  await fs.mkdir(indices, { recursive: true });
  const head = (await git(worktree.path, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  const tree = await treeFromWorkspace(worktree.path, indices);
  const patch = await gitBytes(worktree.path, ['diff', '--binary', '--no-ext-diff', '--no-textconv', worktree.baseCommit, tree, '--']);
  const entries = (await git(worktree.path, ['diff', '--name-status', '-z', '--no-renames', worktree.baseCommit, tree, '--'])).split('\0').filter(Boolean);
  const changedFiles: NativeAgentWorkspaceEvidence['changedFiles'] = [];
  for (let i = 0; i < entries.length; i += 2) changedFiles.push({ status: entries[i], path: entries[i + 1] });
  return { head, baseCommit: worktree.baseCommit, changedFiles, patch };
}
