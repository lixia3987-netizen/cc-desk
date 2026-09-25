import path from 'node:path';
import fs from 'node:fs/promises';
import { environment, execFileAsync } from './platform-commands';
import type { GitInfo } from '../shared/types';
import { readProjectFile, resolveProjectFile } from './files';
import type { GitChange, GitChanges, GitDiff, WorktreeInfo, WorktreeActionResult } from '../shared/git';
import { ensureWorktreeParent, removeEmptyWorktreeParents, worktreeDestination, type WorktreePlacement } from './worktree-paths';

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

async function excludeWorktree(projectRoot: string, common: string, destination: string): Promise<() => Promise<void>> {
  const directory = path.join(common, 'info');
  // Never follow an info/exclude symlink when appending a local Git rule.
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
    // An external editor may have changed exclude while Git was running. Preserve its edits.
    const current = await fs.readFile(file).catch(() => undefined);
    if (!current?.equals(expected)) return;
    const currentEntry = await fs.lstat(file).catch(() => undefined);
    if (!currentEntry?.isFile() || currentEntry.isSymbolicLink()) return;
    if (original) await fs.writeFile(file, original);
    else await fs.unlink(file);
  };
}

export async function createWorktree(cwd: string, root: string, id: string, placement?: WorktreePlacement): Promise<string> {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('无效的会话标识。');
  return withGitMutation(cwd, async () => {
  await git(cwd, ['rev-parse', '--verify', 'HEAD']);
  const basePath = await fs.realpath(cwd);
  const baseBranch = (await git(cwd, ['branch', '--show-current'])).trim();
  if (!baseBranch) throw new Error('请先切换到一个分支，再创建隔离工作区。');
  const branch = `workbench/${id.slice(0, 8)}`;
  const sourceRoot = await gitWorktreeRoot(cwd);
  const projectRoot = placement ? await gitWorktreeRoot(placement.projectPath) : sourceRoot;
  const common = await fs.realpath((await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  const projectCommon = await fs.realpath((await git(projectRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  if (common !== projectCommon) throw new Error('当前会话与项目不属于同一个 Git 仓库。');
  if (placement?.location === 'project') {
    const [tracked, sourceTracked] = await Promise.all([
      git(projectRoot, ['ls-files', '-z', '--', '.claude/worktrees']),
      git(sourceRoot, ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', '.claude/worktrees'])
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
    // Reserve exclusively: Git itself permits an existing empty folder, but our UI must never take it over.
    try { await fs.mkdir(destination); reserved = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('工作区目标目录已经存在，请更换名称后重试。'); throw error; }
    if (placement?.location === 'project') undoExclude = await excludeWorktree(projectRoot, common, destination);
    await git(cwd, ['worktree', 'add', '-b', branch, destination, 'HEAD']);
    added = true;
    const owner: Ownership = { version: 1, sessionId: id, basePath, branch, baseBranch };
    await fs.writeFile(path.join(await gitDirectory(destination), OWNER_FILE), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    return destination;
  } catch (error) {
    if (added) {
      // Git remove can delete ignored data even without --force. Checkout hooks may
      // have created it before the owner marker failed, so apply the normal cleanup guard.
      const noIgnoredFiles = await git(destination, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']).then(value => !value, () => false);
      if (noIgnoredFiles) await git(cwd, ['worktree', 'remove', '--', destination]).catch(() => undefined);
    }
    // Only remove directories we reserved and only if empty. Never force-delete checkout/hook/user data.
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
  const result: WorktreeInfo = { owned: false, path: worktreePath, basePath, clean: false, baseClean: false, merged: false, canMerge: false, canCleanup: false, reasons: [], cleanupReasons: [] };
  const cleanupBlocked = (message: string) => { result.reasons.push(message); result.cleanupReasons.push(message); };
  const owner = await ownership(basePath, worktreePath, sessionId);
  if (!owner) { cleanupBlocked('此工作区缺少匹配的应用所有权记录，不能自动合并或清理。'); return result; }
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
    if (running) cleanupBlocked('请先停止使用此工作区及来源目录的所有会话。');
    if (!result.clean) cleanupBlocked('工作区存在未提交或未跟踪文件，请先提交或移走需要保留的文件。');
    if (!result.baseClean) result.reasons.push('主项目存在未提交更改，不能自动合并。');
    if (!targetMatches) result.reasons.push(`主项目已切换分支；请切回 ${owner.baseBranch} 后操作。`);
    if (!result.merged && !forward) result.reasons.push('分支已经分叉，请手动合并并解决冲突；自动合并仅允许快进。');
    if (!result.merged) cleanupBlocked(`隔离分支的提交尚未合入 ${owner.baseBranch}，请先合并后再清理。`);
    if (ignored) {
      const files = ignored.split('\0').filter(Boolean);
      cleanupBlocked(`工作区含 ${files.length} 个被 Git 忽略的文件（${files.slice(0, 5).map(file => file.slice(0, 200)).join('、')}${files.length > 5 ? '…' : ''}），清理前请移走或自行删除。`);
    }
    result.canMerge = !running && result.clean && result.baseClean && targetMatches && (forward || result.merged);
    result.canCleanup = !running && result.clean && result.merged && !ignored;
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
      return { ok: true, status: 'removed', message: '已移除干净且已合并的工作区；分支保留，可手动删除。' };
    } catch (error) { return { ok: false, status: 'blocked', message: `工作区未被强制删除。${errorMessage(error)}` }; }
  });
}

function containsDirectory(root: string, target: string): boolean {
  const relative = path.relative(process.platform === 'win32' ? root.toLowerCase() : root, process.platform === 'win32' ? target.toLowerCase() : target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/** Check ignored and untracked directories too: a nested repository is separate user data. */
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
    // Never descend through symlinks (including Windows junctions), or into the
    // current worktree's .git metadata. git worktree remove owns the actual removal.
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
      // External tools can move a worktree while inspection is in progress.
      const current = await fs.lstat(target);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== entry.dev || current.ino !== entry.ino ||
          await gitWorktreeRoot(target) !== target || !await ownership(base, target, sessionId)) {
        throw new Error('工作区在检查过程中发生变化，请刷新后重试。');
      }
      // Exactly one --force: Git still refuses locked worktrees. Never unlock,
      // double-force, prune registrations or fall back to recursive fs removal.
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

/** Prove identity from the source repository without relying on the target's .git file. */
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
    // Other registrations may be damaged too; never repair or modify them.
    const pointer = await metadataText(path.join(directory, 'gitdir')).catch(() => undefined);
    if (!pointer || await canonicalExistingParent(pointer.trim()) !== path.join(target, '.git')) continue;
    if (found) throw new Error('隔离目录存在重复所有权记录，不能自动恢复。');
    if (containsDirectory(target, directory)) throw new Error('隔离目录包含 Git 元数据，不能强制删除。');
    const owner = JSON.parse(await metadataText(path.join(directory, OWNER_FILE))) as Ownership;
    const shared = await fs.realpath(path.resolve(directory, (await metadataText(path.join(directory, 'commondir'))).trim()));
    const head = (await metadataText(path.join(directory, 'HEAD'))).trim();
    if (owner.version !== 1 || owner.sessionId !== sessionId || owner.basePath !== base || owner.branch !== branch || !owner.baseBranch ||
        shared !== common || head !== `ref: refs/heads/${branch}`) throw new Error('隔离目录缺少匹配的应用所有权记录，不能自动恢复。');
    if (await optionalEntry(path.join(directory, 'locked'))) throw new Error('隔离目录已被 Git 锁定（locked），请先处理锁定原因。');
    await git(base, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
    found = directory;
  }
  if (!found) throw new Error('隔离目录缺少匹配的应用所有权记录，不能自动恢复。');
  return { directory: found, common };
}

/** Explicit destructive choice: discard worktree files, but never delete its branch. */
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
      // Git cannot remove a registered directory whose backlink disappeared.
      // Restore only this proven owner's missing file; git worktree repair would
      // also mutate unrelated registrations, so it is deliberately not used here.
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
          // Roll back only our unchanged inode and bytes, including a partial
          // write. A concurrently replaced or edited .git file must survive.
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
