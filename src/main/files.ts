import fs from 'node:fs/promises';
import path from 'node:path';
import { constants, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { environment, execFileAsync } from './commands';
import type { ProjectFile, ProjectFiles } from '../shared/git';

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 4000;
const EXCLUDED = new Set(['.git', 'node_modules', 'dist', 'release', '.next', 'coverage']);

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/** Renderer inputs are always project-relative; resolve symlinks before touching data. */
export async function resolveProjectFile(root: string, relative: string, allowMissing = false): Promise<string> {
  if (!relative || relative.length > 4096 || /[\x00-\x1f\\]/.test(relative) || path.isAbsolute(relative) || path.win32.isAbsolute(relative)) throw new Error('文件路径必须是项目内的相对路径。');
  const parts = relative.split('/');
  if (parts.some(part => part === '..' || part.toLowerCase() === '.git')) throw new Error('不允许访问项目外或 Git 内部文件。');
  const canonicalRoot = await fs.realpath(root);
  const target = path.resolve(canonicalRoot, relative);
  if (!isWithin(canonicalRoot, target) || target === canonicalRoot) throw new Error('文件必须位于项目内。');
  let existing = target;
  for (;;) {
    try {
      const canonical = await fs.realpath(existing);
      if (!isWithin(canonicalRoot, canonical)) throw new Error('符号链接指向项目外，已拒绝访问。');
      if (path.relative(canonicalRoot, canonical).split(path.sep).some(part => part.toLowerCase() === '.git')) throw new Error('不允许通过符号链接访问 Git 内部文件。');
      return existing === target ? canonical : target;
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const entry = await fs.lstat(existing).catch(() => undefined);
      if (entry?.isSymbolicLink()) throw new Error('无法安全解析符号链接。');
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}

const changedPath = () => new Error('文件或上级目录在读取期间发生变化，已拒绝预览，请重试。');
const sameFile = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;

async function identities(root: string, target: string): Promise<{ path: string; stat: BigIntStats }[]> {
  if (await fs.realpath(root) !== root || await fs.realpath(target) !== target) throw changedPath();
  const result: { path: string; stat: BigIntStats }[] = [];
  let current = root;
  const parts = path.relative(root,target).split(path.sep);
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) current = path.join(current,parts[i]);
    const stat = await fs.lstat(current,{bigint:true});
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw changedPath();
    result.push({path:current,stat});
  }
  return result;
}

/**
 * Linux opens each canonical component relative to an already opened directory
 * via procfs, refusing replacement symlinks at every step. Before returning bytes
 * it also checks the kernel-reported handle location. On macOS/Windows Node has
 * no openat / handle-final-path API: matching pre/open/post file and ancestor IDs
 * detects ordinary replacement races, but is not a native atomic sandbox against
 * a hostile process coordinating repeated ABA renames. Such a sandbox needs native
 * openat/F_GETPATH or CreateFile/GetFinalPathNameByHandle support.
 */
export async function readProjectFile(root: string, relative: string): Promise<ProjectFile> {
  const canonicalRoot = await fs.realpath(root);
  const resolved = await resolveProjectFile(canonicalRoot, relative);
  const expected = await identities(canonicalRoot,resolved);
  const safetyFlags = process.platform === 'win32' ? 0 : ((constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  const handles: FileHandle[] = [];
  try {
    let handle: FileHandle;
    if (process.platform === 'linux') {
      let directory = await fs.open(canonicalRoot,constants.O_RDONLY | constants.O_DIRECTORY | safetyFlags);
      handles.push(directory);
      if (!sameFile(await directory.stat({bigint:true}),expected[0].stat)) throw changedPath();
      for (let i = 1; i < expected.length; i++) {
        const last = i === expected.length - 1;
        const opened = await fs.open(`/proc/self/fd/${directory.fd}/${path.basename(expected[i].path)}`,
          constants.O_RDONLY | safetyFlags | (last ? 0 : constants.O_DIRECTORY));
        handles.push(opened);
        if (!sameFile(await opened.stat({bigint:true}),expected[i].stat)) throw changedPath();
        directory = opened;
      }
      handle = directory;
    } else {
      handle = await fs.open(resolved, constants.O_RDONLY | safetyFlags);
      handles.push(handle);
    }
    const stat = await handle.stat({bigint:true});
    if (!stat.isFile()) throw new Error('只能读取普通文件。');
    if (!sameFile(stat,expected.at(-1)!.stat)) throw changedPath();
    const verify = async () => {
      if (process.platform === 'linux' && await fs.realpath(`/proc/self/fd/${handle.fd}`) !== resolved) throw changedPath();
      const current = await identities(canonicalRoot,resolved);
      if (current.length !== expected.length || current.some((item,i) => !sameFile(item.stat,expected[i].stat))) throw changedPath();
    };
    await verify();
    const size = Number(stat.size);
    const buffer = Buffer.alloc(Math.min(size, MAX_FILE_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    // Never return data until the opened object and its ancestry are revalidated.
    await verify();
    const bytes = buffer.subarray(0, bytesRead);
    const binary = bytes.includes(0);
    return { path: relative, content: binary ? '' : bytes.toString('utf8'), bytes: size, binary, truncated: size > MAX_FILE_BYTES };
  } finally { await Promise.all(handles.map(handle => handle.close())); }
}

export async function listProjectFiles(root: string, query = ''): Promise<ProjectFiles> {
  if (query.length > 512 || /[\x00-\x1f]/.test(query)) throw new Error('文件搜索内容无效。');
  const needle = query.toLocaleLowerCase();
  let candidates: string[] = [];
  let truncated = false;
  try {
    const result = await execFileAsync('git', ['--literal-pathspecs', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'], { cwd: root, env: environment(), windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
    candidates = result.stdout.split('\0').filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      candidates = String((error as { stdout?: string }).stdout ?? '').split('\0').slice(0, -1); truncated = true;
    } else {
      let visited = 0;
      const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
        if (depth > 20 || candidates.length >= 20000 || visited++ >= 30000) { truncated = true; return; }
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (EXCLUDED.has(entry.name)) continue;
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative, depth + 1);
          else if (entry.isFile() || entry.isSymbolicLink()) candidates.push(relative);
          if (candidates.length >= 20000) { truncated = true; break; }
        }
      };
      await visit(await fs.realpath(root), '', 0);
    }
  }
  const files: string[] = [];
  for (const candidate of [...new Set(candidates)].sort()) {
    if (!candidate.toLocaleLowerCase().includes(needle) || candidate.split('/').some(part => EXCLUDED.has(part))) continue;
    try {
      const resolved = await resolveProjectFile(root, candidate);
      if (!(await fs.stat(resolved)).isFile()) continue;
      if (files.length >= MAX_FILES) { truncated = true; break; }
      files.push(candidate);
    } catch { /* Broken links, deleted files and paths outside the project are omitted. */ }
  }
  return { files, truncated };
}
