import path from 'node:path';
import fs from 'node:fs/promises';
import { environment, execFileAsync } from './platform-commands';
import type { GitInfo } from '../shared/types';
import { readProjectFile, resolveProjectFile } from './files';
import type { GitChange, GitChanges, GitDiff, WorktreeInfo, WorktreeActionResult, WorktreeBranch } from '../shared/git';
import { ensureWorktreeParent, removeEmptyWorktreeParents, worktreeDestination, type WorktreePlacement } from './worktree-paths';

const MAX_DIFF = 256 * 1024;
const OWNER_FILE = 'workbench-owner.json';
interface Ownership {
  version: 1 | 2; sessionId: string; basePath: string; branch: string; baseBranch: string;
  sourceRef?: string; sourceCommit?: string;
}

function validOwnership(owner: Ownership): boolean {
  return owner?.version === 1 ? !!owner.baseBranch : owner?.version === 2 && typeof owner.baseBranch === 'string' &&
    typeof owner.sourceRef === 'string' && !!owner.sourceRef && /^[a-f0-9]{40,64}$/.test(owner.sourceCommit ?? '');
}

async function git(cwd: string, args: string[], maxBuffer = 2 * 1024 * 1024): Promise<string> {
  const result = await execFileAsync('git', ['--literal-pathspecs', ...args], { cwd, env: { ...environment(), GIT_TERMINAL_PROMPT: '0' }, windowsHide: true, timeout: 20000, maxBuffer });
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
  // 跨所有关联工作树串行处理共享引用和注册，同时允许
  // 独立工作树中的普通会话继续使用各自的文件。
  const common = await fs.realpath((await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  const key = process.platform === 'win32' ? common.toLowerCase() : common;
  if (mutations.has(key)) throw new Error('此项目正在执行另一个 Git 操作。');
  mutations.add(key);
  try { return await action(); } finally { mutations.delete(key); }
}

async function remotes(cwd: string): Promise<string[]> {
  return (await git(cwd, ['remote'])).split(/\r?\n/).filter(Boolean).sort((a, b) => b.length - a.length);
}

function remoteBranch(ref: string, names: string[]): { remote: string; name: string } | undefined {
  const prefix = 'refs/remotes/';
  if (!ref.startsWith(prefix)) return;
  const relative = ref.slice(prefix.length);
  const remote = names.find(name => relative.startsWith(`${name}/`));
  return remote ? { remote, name: relative.slice(remote.length + 1) } : undefined;
}

/** 显式 refspec 不更新本地分支，不受 remote.*.fetch 配置影响。 */
async function fetchBranches(cwd: string, remote: string, name = '*'): Promise<void> {
  // Git fetch 会解引用已有符号引用。拒绝异常别名，避免
  // 远程跟踪目标将 fetch 重定向到本地分支。
  const prefix = `refs/remotes/${remote}/`;
  const refs = await git(cwd, ['for-each-ref', '--format=%(refname)%00%(symref)', prefix]);
  for (const line of refs.split(/\r?\n/).filter(Boolean)) {
    const [ref, symbolic] = line.split('\0');
    if (symbolic && (ref !== `${prefix}HEAD` || !symbolic.startsWith(prefix))) {
      throw new Error('远程分支含异常符号引用，请先修复后再刷新或创建工作区。');
    }
  }
  await git(cwd, ['-c', 'credential.interactive=false', 'fetch', '--no-tags', '--no-recurse-submodules',
    '--no-auto-maintenance', '--no-write-fetch-head', '--no-prune-tags', '--refmap=', ...(name === '*' ? ['--prune'] : []),
    '--', remote, `+refs/heads/${name}:refs/remotes/${remote}/${name}`]);
}

/** 默认读取缓存引用。刷新可发现仅存在于远程的分支，无须切换检出状态。 */
export async function listWorktreeBranches(cwd: string, refresh = false): Promise<WorktreeBranch[]> {
  const names = await remotes(cwd);
  if (refresh) await withGitMutation(cwd, async () => {
    for (const remote of names) await fetchBranches(cwd, remote);
  });
  const raw = await git(cwd, ['for-each-ref', '--sort=refname', '--format=%(refname)%00%(symref)%00%(HEAD)', 'refs/heads/', 'refs/remotes/']);
  return raw.split(/\r?\n/).filter(Boolean).flatMap(line => {
    const [ref, symbolic, head] = line.split('\0');
    if (symbolic) return []; // origin/HEAD 是别名，不是可选分支。
    if (ref.startsWith('refs/heads/')) return [{ ref, name: ref.slice('refs/heads/'.length), current: head === '*' }];
    const remote = remoteBranch(ref, names);
    return remote ? [{ ref, name: `${remote.remote}/${remote.name}`, remote: remote.remote, current: false }] : [];
  });
}

async function worktreeSource(cwd: string, requested: string | undefined, baseBranch: string): Promise<{ sourceRef: string; sourceCommit: string }> {
  const sourceRef = requested ?? (baseBranch ? `refs/heads/${baseBranch}` : 'HEAD');
  if (requested !== undefined) {
    if (!/^refs\/(heads|remotes)\/.+/.test(requested)) throw new Error('工作区起点必须是完整的本地或远程分支引用。');
    await git(cwd, ['check-ref-format', requested]).catch(() => { throw new Error('无效的工作区起点分支。'); });
    const symbolic = await git(cwd, ['symbolic-ref', '-q', requested]).catch(() => '');
    if (symbolic) throw new Error('请选择具体分支，不能使用分支符号引用。');
    if (requested.startsWith('refs/remotes/')) {
      const source = remoteBranch(requested, await remotes(cwd));
      if (!source) throw new Error('工作区起点的远程仓库不存在。');
      // fetch 或认证失败后，不能回退到过期的跟踪引用。
      await fetchBranches(cwd, source.remote, source.name);
    }
  }
  const sourceCommit = await git(cwd, ['rev-parse', '--verify', '--end-of-options', `${sourceRef}^{commit}`])
    .then(value => value.trim(), () => { throw new Error('工作区起点分支不存在或尚无提交；请选择已有提交的本地或远程分支。'); });
  return { sourceRef, sourceCommit };
}

async function excludeWorktree(projectRoot: string, common: string, destination: string): Promise<() => Promise<void>> {
  const directory = path.join(common, 'info');
  // 追加本地 Git 规则时，不能跟随 info/exclude 符号链接。
  await ensureWorktreeParent(directory, []);
  const file = path.join(directory, 'exclude');
  const entry = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw new Error('Git 本地排除文件不能是符号链接或目录。');
  const original = entry ? await fs.readFile(file) : undefined;
  const escaped = path.relative(projectRoot, destination).split(path.sep).join('/').replace(/[\\*?\[\]#! ]/g, '\\$&');
  const rule = `/${escaped}/`;
  if (original?.toString('utf8').split(/\r?\n/).includes(rule)) return async () => undefined;
  const newline = original?.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
  const addition = Buffer.from(`${original?.length && original[original.length - 1] !== 10 ? newline : ''}${rule}${newline}`);
  await fs.writeFile(file, addition, { flag: 'a', mode: 0o600 });
  const expected = Buffer.concat([original ?? Buffer.alloc(0), addition]);
  return async () => {
    // Git 运行期间，外部编辑器可能改动 exclude。应保留其修改。
    const current = await fs.readFile(file).catch(() => undefined);
    if (!current?.equals(expected)) return;
    const currentEntry = await fs.lstat(file).catch(() => undefined);
    if (!currentEntry?.isFile() || currentEntry.isSymbolicLink()) return;
    if (original) await fs.writeFile(file, original);
    else await fs.unlink(file);
  };
}

export async function createWorktree(cwd: string, root: string, id: string, placement?: WorktreePlacement, baseRef?: string): Promise<string> {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('无效的会话标识。');
  return withGitMutation(cwd, async () => {
  const basePath = await fs.realpath(cwd);
  const baseBranch = (await git(cwd, ['branch', '--show-current'])).trim();
  const branch = `workbench/${id.slice(0, 8)}`;
  const sourceRoot = await gitWorktreeRoot(cwd);
  const projectRoot = placement ? await gitWorktreeRoot(placement.projectPath) : sourceRoot;
  const common = await fs.realpath((await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  const projectCommon = await fs.realpath((await git(projectRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  if (common !== projectCommon) throw new Error('当前会话与项目不属于同一个 Git 仓库。');
  const { sourceRef, sourceCommit } = await worktreeSource(cwd, baseRef, baseBranch);
  if (placement?.location === 'project') {
    const [tracked, sourceTracked] = await Promise.all([
      git(projectRoot, ['ls-files', '-z', '--', '.claude/worktrees']),
      git(sourceRoot, ['ls-tree', '-r', '--name-only', '-z', sourceCommit, '--', '.claude/worktrees'])
    ]);
    if (tracked || sourceTracked) throw new Error('.claude/worktrees 已包含受 Git 跟踪的文件，请先移走这些文件或选择统一目录。');
  }
  const destination = await worktreeDestination(root, id, placement, sourceRoot, projectRoot, [common, await gitDirectory(cwd), await gitDirectory(projectRoot)]);
  const created: string[] = [];
  let undoExclude: (() => Promise<void>) | undefined;
  let added = false;
  let reserved = false;
  try {
    await ensureWorktreeParent(path.dirname(destination), created);
    // 独占预留：Git 允许使用已有空目录，但本应用界面不能接管它。
    try { await fs.mkdir(destination); reserved = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('工作区目标目录已经存在，请更换名称后重试。'); throw error; }
    if (placement?.location === 'project') undoExclude = await excludeWorktree(projectRoot, common, destination);
    await git(cwd, ['worktree', 'add', '--no-track', '-b', branch, destination, sourceCommit]);
    added = true;
    const owner: Ownership = { version: 2, sessionId: id, basePath, branch, baseBranch, sourceRef, sourceCommit };
    await fs.writeFile(path.join(await gitDirectory(destination), OWNER_FILE), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    return destination;
  } catch (error) {
    if (added) {
      // 即使没有 --force，Git remove 也可能删除已忽略的数据。检出钩子可能
      // 在所有者标记失败前创建了数据，因此仍须应用常规清理保护。
      const noIgnoredFiles = await git(destination, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']).then(value => !value, () => false);
      if (noIgnoredFiles) await git(cwd, ['worktree', 'remove', '--', destination]).catch(() => undefined);
    }
    // 仅移除本应用预留且为空的目录。不能强制删除检出、钩子或用户数据。
    if (reserved) await fs.rmdir(destination).catch(() => undefined);
    const remains = !reserved || await fs.lstat(destination).then(() => true, (cause: NodeJS.ErrnoException) => cause.code !== 'ENOENT');
    if (!remains) await undoExclude?.().catch(() => undefined);
    await removeEmptyWorktreeParents(created);
    if (reserved && remains) throw new Error(`创建工作区未完成，已保留目录 ${destination}，请检查文件后手动处理。${errorMessage(error)}`, { cause: error });
    throw error;
  }
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
  // 重命名检测需要两侧路径。不能仅因旧路径来自 Git
  // 就信任它：会话可能仅限于仓库的某个子目录。
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
    if (!validOwnership(owner) || owner.sessionId !== sessionId || owner.basePath !== base || owner.branch !== branch || branch !== `workbench/${sessionId.slice(0, 8)}`) return;
    const registered = await git(basePath, ['worktree', 'list', '--porcelain', '-z']);
    const registeredPaths = await Promise.all(registered.split('\0').filter(record => record.startsWith('worktree ')).map(record => fs.realpath(record.slice(9)).catch(() => '')));
    if (!registeredPaths.includes(child)) return;
    return owner;
  } catch { return; }
}

export async function worktreeInfo(basePath: string, worktreePath: string, sessionId: string, running = false): Promise<WorktreeInfo> {
  const result: WorktreeInfo = { owned: false, path: worktreePath, basePath, clean: false, baseClean: false, merged: false, canMerge: false, canCleanup: false, reasons: [], cleanupReasons: [] };
  const cleanupBlocked = (message: string) => { result.reasons.push(message); result.cleanupReasons.push(message); };
  const owner = await ownership(basePath, worktreePath, sessionId);
  if (!owner) { cleanupBlocked('此工作区缺少匹配的应用所有权记录，不能自动合并或清理。'); return result; }
  result.owned = true; result.branch = owner.branch; result.baseBranch = owner.baseBranch || undefined;
  result.sourceRef = owner.sourceRef; result.sourceCommit = owner.sourceCommit;
  try {
    const [status, baseStatus, baseBranch, ignored, head] = await Promise.all([
      git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']), git(basePath, ['status', '--porcelain=v1', '--untracked-files=all']),
      git(basePath, ['branch', '--show-current']), git(worktreePath, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']),
      git(worktreePath, ['rev-parse', '--verify', 'HEAD'])
    ]);
    result.clean = !status.trim(); result.baseClean = !baseStatus.trim();
    const targetExists = !!owner.baseBranch && await git(basePath, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${owner.baseBranch}^{commit}`]).then(() => true, () => false);
    const targetMatches = targetExists && baseBranch.trim() === owner.baseBranch;
    result.merged = targetExists && await git(basePath, ['merge-base', '--is-ancestor', owner.branch, `refs/heads/${owner.baseBranch}`]).then(() => true, () => false);
    const forward = targetExists && await git(basePath, ['merge-base', '--is-ancestor', `refs/heads/${owner.baseBranch}`, owner.branch]).then(() => true, () => false);
    const unchanged = owner.version === 2 && head.trim() === owner.sourceCommit;
    if (running) cleanupBlocked('请先停止使用此工作区及来源目录的所有会话。');
    if (!result.clean) cleanupBlocked('工作区存在未提交或未跟踪文件，请先提交或移走需要保留的文件。');
    if (!result.baseClean) result.reasons.push('主项目存在未提交更改，不能自动合并。');
    if (!owner.baseBranch) result.reasons.push('创建时来源目录处于 detached HEAD，没有可自动合并的目标分支，请手动合并。');
    else if (!targetExists) result.reasons.push(`来源分支 ${owner.baseBranch} 不存在或尚无提交，请手动处理合并目标。`);
    else if (!targetMatches) result.reasons.push(`主项目已切换分支；请切回 ${owner.baseBranch} 后操作。`);
    if (targetExists && !result.merged && !forward) result.reasons.push('分支已经分叉，请手动合并并解决冲突；自动合并仅允许快进。');
    if (!result.merged && !unchanged) cleanupBlocked(`隔离分支包含新提交且尚未合入 ${owner.baseBranch || '来源分支'}，请先合并后再清理。`);
    if (ignored) {
      const files = ignored.split('\0').filter(Boolean);
      cleanupBlocked(`工作区含 ${files.length} 个被 Git 忽略的文件（${files.slice(0, 5).map(file => file.slice(0, 200)).join('、')}${files.length > 5 ? '…' : ''}），清理前请移走或自行删除。`);
    }
    result.canMerge = !running && result.clean && result.baseClean && targetMatches && (forward || result.merged);
    result.canCleanup = !running && result.clean && (result.merged || unchanged) && !ignored;
  } catch (error) { cleanupBlocked(errorMessage(error)); }
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
    if (!info.canCleanup) return { ok: false, status: 'blocked', message: info.cleanupReasons.join('\n') || '工作区提交尚未合并，不能清理。' };
    try {
      await git(basePath, ['worktree', 'remove', '--', worktreePath]);
      return { ok: true, status: 'removed', message: '已移除干净且未新增提交或已合并的工作区；分支保留，可手动删除。' };
    } catch (error) { return { ok: false, status: 'blocked', message: `工作区未被强制删除。${errorMessage(error)}` }; }
  });
}

function containsDirectory(root: string, target: string): boolean {
  const relative = path.relative(process.platform === 'win32' ? root.toLowerCase() : root, process.platform === 'win32' ? target.toLowerCase() : target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/** 同时检查已忽略和未跟踪目录：嵌套仓库属于独立用户数据。 */
async function assertNoNestedRepositories(root: string): Promise<void> {
  const pending = [root], deadline = Date.now() + 30000;
  let inspected = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    inspected += entries.length;
    if (inspected > 500000 || Date.now() > deadline) throw new Error('隔离目录内容过多，无法完成嵌套仓库检查；请先手动移走较大的子目录后重试。');
    if (directory !== root) {
      const names = new Map(entries.map(entry => [entry.name.toLowerCase(), entry]));
      const bare = names.get('head')?.isFile() && names.get('objects')?.isDirectory() &&
        (names.get('refs')?.isDirectory() || names.get('reftable')?.isDirectory());
      if (names.has('.git') || bare) throw new Error(`隔离目录内包含独立 Git 仓库或子模块，请先移走后再删除：${directory}`);
    }
    // 不能进入符号链接（包括 Windows 目录联接），也不能进入
    // 当前工作树的 .git 元数据。实际移除操作由 git worktree remove 负责。
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.toLowerCase() !== '.git') pending.push(path.join(directory, entry.name));
    }
  }
}

async function forceRemoveVerifiedWorktree(basePath: string, worktreePath: string, sessionId: string): Promise<WorktreeActionResult> {
    try {
      const [base, target, common, directory, root, entry] = await Promise.all([
        fs.realpath(basePath), fs.realpath(worktreePath),
        git(basePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']).then(value => fs.realpath(value.trim())),
        gitDirectory(worktreePath).then(value => fs.realpath(value)), gitWorktreeRoot(worktreePath), fs.lstat(worktreePath),
      ]);
      if (!entry.isDirectory() || entry.isSymbolicLink() || target !== root) throw new Error('只能删除会话登记的完整 worktree 根目录，不能删除链接或子目录。');
      if (containsDirectory(target, base) || containsDirectory(target, common) || containsDirectory(target, directory)) {
        throw new Error('隔离目录包含来源目录或 Git 元数据，不能强制删除。');
      }
      if (!await ownership(base, target, sessionId)) throw new Error('此工作区缺少匹配的应用所有权记录，不能强制删除。');
      const registered = await git(base, ['worktree', 'list', '--porcelain', '-z']);
      for (const record of registered.split('\0').filter(value => value.startsWith('worktree '))) {
        const registeredPath = path.resolve(record.slice(9));
        const resolved = await fs.realpath(registeredPath).catch(() => registeredPath);
        if (resolved !== target && (containsDirectory(target, resolved) || containsDirectory(target, registeredPath))) {
          throw new Error(`隔离目录内还登记了其他 worktree，请先处理：${registeredPath}`);
        }
      }
      await assertNoNestedRepositories(target);
      // 检查过程中，外部工具可能移动工作树。
      const current = await fs.lstat(target);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== entry.dev || current.ino !== entry.ino ||
          await gitWorktreeRoot(target) !== target || !await ownership(base, target, sessionId)) {
        throw new Error('工作区在检查过程中发生变化，请刷新后重试。');
      }
      // 仅使用一次 --force：Git 仍会拒绝已锁定的工作树。不能解锁、
      // 重复强制执行、清除注册或回退到递归文件系统删除。
      await git(base, ['worktree', 'remove', '--force', '--', target]);
      return { ok: true, status: 'removed', message: '已强制移除隔离目录及其中的未提交文件；Git 分支和已提交记录保留。' };
    } catch (error) {
      return { ok: false, status: 'blocked', message: `隔离目录未完成强制删除；不会绕过 Git 保护或递归删除目录。${errorMessage(error)}` };
    }
}

async function canonicalExistingParent(value: string): Promise<string> {
  let current = path.resolve(value);
  const missing: string[] = [];
  for (;;) {
    try { return path.join(await fs.realpath(current), ...missing); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current)); current = parent;
    }
  }
}

async function optionalEntry(file: string) {
  return fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined; });
}

async function metadataText(file: string): Promise<string> {
  const entry = await fs.lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 16384) throw new Error('工作区登记元数据异常，不能自动恢复。');
  return fs.readFile(file, 'utf8');
}

/** 依据源仓库证明身份，不依赖目标的 .git 文件。 */
async function registeredWorktreeOwner(base: string, target: string, sessionId: string): Promise<{ directory: string; common: string } | undefined> {
  const common = await fs.realpath((await git(base, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  if (containsDirectory(target, base) || containsDirectory(target, common)) throw new Error('隔离目录包含来源目录或 Git 元数据，不能强制删除。');
  const records = (await git(base, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0').filter(Boolean);
  let matched: string[] | undefined;
  for (const record of records) {
    const fields = record.split('\0'), value = fields.find(field => field.startsWith('worktree '));
    if (!value) continue;
    const registered = await canonicalExistingParent(value.slice(9));
    if (registered === target) {
      if (matched) throw new Error('隔离目录存在重复登记，不能自动恢复。');
      matched = fields;
    } else if (containsDirectory(target, registered)) throw new Error(`隔离目录内还登记了其他 worktree，请先处理：${registered}`);
  }
  if (!matched) return;
  if (matched.some(field => field === 'locked' || field.startsWith('locked '))) throw new Error('隔离目录已被 Git 锁定（locked），请先处理锁定原因。');
  const branch = `workbench/${sessionId.slice(0, 8)}`;
  if (!matched.includes(`branch refs/heads/${branch}`)) throw new Error('隔离目录登记的分支与会话不匹配，不能自动恢复。');
  const metadataRoot = path.join(common, 'worktrees');
  const rootEntry = await fs.lstat(metadataRoot);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) throw new Error('工作区登记目录异常，不能自动恢复。');
  let found: string | undefined;
  for (const entry of await fs.readdir(metadataRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = path.join(metadataRoot, entry.name);
    // 其他注册也可能损坏；不能修复或修改它们。
    const pointer = await metadataText(path.join(directory, 'gitdir')).catch(() => undefined);
    if (!pointer || await canonicalExistingParent(pointer.trim()) !== path.join(target, '.git')) continue;
    if (found) throw new Error('隔离目录存在重复所有权记录，不能自动恢复。');
    if (containsDirectory(target, directory)) throw new Error('隔离目录包含 Git 元数据，不能强制删除。');
    const owner = JSON.parse(await metadataText(path.join(directory, OWNER_FILE))) as Ownership;
    const shared = await fs.realpath(path.resolve(directory, (await metadataText(path.join(directory, 'commondir'))).trim()));
    const head = (await metadataText(path.join(directory, 'HEAD'))).trim();
    if (!validOwnership(owner) || owner.sessionId !== sessionId || owner.basePath !== base || owner.branch !== branch ||
        shared !== common || head !== `ref: refs/heads/${branch}`) throw new Error('隔离目录缺少匹配的应用所有权记录，不能自动恢复。');
    if (await optionalEntry(path.join(directory, 'locked'))) throw new Error('隔离目录已被 Git 锁定（locked），请先处理锁定原因。');
    await git(base, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
    found = directory;
  }
  if (!found) throw new Error('隔离目录缺少匹配的应用所有权记录，不能自动恢复。');
  return { directory: found, common };
}

/** 显式破坏性选择：丢弃工作树文件，但不删除其分支。 */
export async function forceCleanupWorktree(basePath: string, worktreePath: string, sessionId: string, running = false): Promise<WorktreeActionResult> {
  const blocked = (message: string): WorktreeActionResult => ({ ok: false, status: 'blocked', message });
  const absent = (): WorktreeActionResult => ({ ok: true, status: 'removed', message: '隔离目录已经不存在，未删除任何文件；Git 分支和已提交记录保留。' });
  if (running) return blocked('请先停止使用此工作区及来源目录的所有会话。');
  try {
    const entry = await optionalEntry(worktreePath);
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) return blocked('只能删除会话登记的完整 worktree 根目录，不能删除链接或文件。');
    const target = await canonicalExistingParent(worktreePath);
    let base: string;
    try { base = await fs.realpath(basePath); await gitWorktreeRoot(base); }
    catch {
      if (!entry && !await optionalEntry(worktreePath)) return absent();
      return blocked(`无法验证来源仓库 ${basePath} 的 Git 信息。请恢复来源仓库，或选择“仅删除会话，保留隔离目录”。`);
    }
    return await withGitMutation(base, async () => {
      if (!entry) {
        const owner = await registeredWorktreeOwner(base, target, sessionId);
        if (await optionalEntry(worktreePath)) return blocked('隔离目录在检查过程中重新出现，请刷新后重试。');
        if (owner) await git(base, ['worktree', 'remove', '--force', '--', target]);
        return absent();
      }
      const marker = path.join(target, '.git');
      if (await optionalEntry(marker)) {
        try { await gitWorktreeRoot(target); }
        catch { return blocked(`隔离目录 ${target} 的 .git 信息已损坏。请恢复原链接，或选择“仅删除会话，保留隔离目录”。`); }
        return forceRemoveVerifiedWorktree(base, worktreePath, sessionId);
      }
      const owner = await registeredWorktreeOwner(base, target, sessionId);
      if (!owner) return blocked('隔离目录缺少匹配的应用所有权记录，不能自动恢复；可选择仅删除会话并保留目录。');
      const current = await fs.lstat(target);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== entry.dev || current.ino !== entry.ino || await fs.realpath(worktreePath) !== target) {
        return blocked('隔离目录在检查过程中发生变化，请刷新后重试。');
      }
      // 反向链接消失后，Git 无法移除已注册目录。
      // 仅恢复已证实属于本所有者的缺失文件；git worktree repair 还会
      // 改动无关注册，因此此处有意不使用该命令。
      const pointer = `gitdir: ${owner.directory}\n`;
      const handle = await fs.open(marker, 'wx', 0o600);
      let created: import('node:fs').Stats | undefined, written = false, result: WorktreeActionResult | undefined;
      try {
        created = await handle.stat();
        await handle.writeFile(pointer); written = true;
        await handle.close();
        result = await forceRemoveVerifiedWorktree(base, target, sessionId);
        return result;
      } finally {
        await handle.close().catch(() => undefined);
        if (!result?.ok && created) {
          // 仅回滚本应用尚未变化的 inode 与字节，包括部分
          // 写入内容。并发替换或编辑的 .git 文件必须保留。
          const remaining = await optionalEntry(marker);
          if (remaining?.isFile() && !remaining.isSymbolicLink() && remaining.dev === created.dev && remaining.ino === created.ino) {
            const contents = await fs.readFile(marker, 'utf8');
            if (written ? contents === pointer : pointer.startsWith(contents)) await fs.unlink(marker);
          }
        }
      }
    });
  } catch (error) {
    const detail = errorMessage(error);
    return blocked(`无法安全清理隔离目录；可选择“仅删除会话，保留隔离目录”。${/^(Command failed: git|spawn git)/.test(detail) ? `来源仓库 ${basePath} 或隔离目录的 Git 信息已变化，请检查后重试。` : detail}`);
  }
}
