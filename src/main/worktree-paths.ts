import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

export interface WorktreePlacement {
  location: 'project' | 'custom';
  customRoot?: string;
  projectPath: string;
  projectName: string;
  name: string;
}

/** A display title is not a path. Keep readable Unicode while producing a portable component. */
export function sanitizeWorktreeName(title: string): string {
  let name = title.normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '-')
    .replace(/\.{2,}/g, '-').replace(/\s+/g, '-').replace(/^[.\s-]+|[.\s-]+$/g, '');
  name = Array.from(name).slice(0, 60).join('').replace(/[.\s-]+$/g, '') || 'worktree';
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}

function pathKey(value: string): string { return process.platform === 'win32' ? value.toLowerCase() : value; }
export function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(pathKey(parent), pathKey(child));
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Resolve existing ancestors too, so a not-yet-created path cannot bypass containment through a symlink. */
async function canonicalFuturePath(value: string): Promise<string> {
  try { return await fs.realpath(value); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A dangling symlink must not be mistaken for a missing directory.
    const entry = await fs.lstat(value).catch((cause: NodeJS.ErrnoException) => { if (cause.code !== 'ENOENT') throw cause; });
    if (entry) throw new Error('工作区路径含无法解析的符号链接。');
    const parent = path.dirname(value);
    if (parent === value) throw error;
    return path.join(await canonicalFuturePath(parent), path.basename(value));
  }
}

export async function worktreeDestination(
  legacyRoot: string, id: string, placement: WorktreePlacement | undefined,
  sourceRoot: string, projectRoot: string, metadata: string[]
): Promise<string> {
  if (!placement) return path.join(await canonicalFuturePath(path.resolve(legacyRoot)), 'worktrees', id.slice(0, 8));
  if (!placement.name.trim() || /[/\\\u0000-\u001f\u007f]/.test(placement.name) || placement.name.includes('..')) {
    throw new Error('工作区名称不能包含路径分隔符、控制字符或 ..。');
  }
  const treeName = `${sanitizeWorktreeName(placement.name)}-${id.slice(0, 8)}`;
  if (placement.location === 'project') return path.join(projectRoot, '.claude', 'worktrees', treeName);
  if (placement.location !== 'custom') throw new Error('无效的工作区存放位置。');
  if (!placement.customRoot?.trim() || !path.isAbsolute(placement.customRoot)) throw new Error('统一工作区目录必须是绝对路径。');
  const root = await canonicalFuturePath(path.resolve(placement.customRoot));
  if ([sourceRoot, projectRoot, ...metadata].some(parent => containsPath(parent, root)) || root.split(path.sep).some(part => part.toLowerCase() === '.git')) {
    throw new Error('统一工作区目录必须位于项目和 Git 元数据目录之外；在项目内创建请使用“项目目录”模式。');
  }
  const projectHash = createHash('sha256').update(pathKey(projectRoot)).digest('hex').slice(0, 8);
  return path.join(root, `${sanitizeWorktreeName(placement.projectName)}-${projectHash}`, treeName);
}

/** Only create real directories and remember our own empty parents for conservative rollback. */
export async function ensureWorktreeParent(directory: string, created: string[]): Promise<void> {
  const parent = path.dirname(directory);
  if (parent !== directory) await ensureWorktreeParent(parent, created);
  try {
    const entry = await fs.lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('工作区父路径必须是目录，不能是文件或符号链接。');
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try { await fs.mkdir(directory); created.push(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const entry = await fs.lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('工作区父路径必须是目录，不能是文件或符号链接。');
  }
}

export async function removeEmptyWorktreeParents(created: string[]): Promise<void> {
  for (const directory of [...created].reverse()) await fs.rmdir(directory).catch(() => undefined);
}
