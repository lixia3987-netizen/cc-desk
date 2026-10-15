import { isSensitivePath, normalizeProjectPath, ProjectFiles, throwIfAborted } from './tools/project-files.js';

export interface ProjectSkillEntry { path: string; name: string; hash: string; bytes: number }
export interface ProjectSkillSource extends ProjectSkillEntry { content: string }
export interface ProjectSkillIssue { path: string; message: string }
export interface ProjectSkillDiscovery { entries: ProjectSkillEntry[]; issues: ProjectSkillIssue[]; truncated: boolean }
export interface ProjectSkillOptions { projectRoot: string; excludedRoots?: readonly string[] }
export interface ProjectSkillLoadOptions extends ProjectSkillOptions {
  paths: readonly string[];
  maxFileBytes?: number;
  maxTotalBytes?: number;
}
const ROOTS = ['.agents/skills', '.claude/skills'] as const;
const MAX_FILE_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024;
const MAX_ROOT_ENTRIES = 64;

/** 仅可选择显式指定的项目技能文件；不允许 HOME 别名或向上的路径。 */
export function normalizeProjectSkillPaths(paths: readonly string[]): string[] {
  if (!Array.isArray(paths) || paths.length > 16) throw new Error('Select at most 16 project skills.');
  const seen = new Set<string>();
  return paths.map(value => {
    const relative = normalizeProjectPath(value);
    const parts = relative.split('/');
    if (parts.length < 2 || parts.length > 22 || parts[0] === '~' || parts.at(-1) !== 'SKILL.md' || isSensitivePath(relative)) throw new Error('Only explicit, non-sensitive project-relative <directory>/SKILL.md paths are allowed (at most 21 directories).');
    // 在 Windows 和默认 macOS 卷上，仅大小写不同的别名可能指向同一文件。
    const key = relative.toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate project skill paths are not allowed.');
    seen.add(key);
    return relative;
  }).sort();
}

function safeReadError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException)?.code;
  const message = error instanceof Error ? error.message : '';
  if (code === 'ENOENT') return new Error('Selected project skill is missing. Refresh the project skills list.');
  if (/total byte limit/.test(message)) return new Error('Project skills exceed the shared instruction total byte limit.');
  if (/byte limit/.test(message)) return new Error('Project skill exceeds its byte limit.');
  if (/UTF-8|Binary/.test(message)) return new Error('Project skill must be valid UTF-8 text without binary data.');
  if (/links are refused/.test(message)) return new Error('Project skill links are refused; use ordinary project files and directories.');
  if (/protected|Protected/.test(message)) return new Error('Project skill is inside a protected directory.');
  if (/changed/.test(message)) return new Error('Project skill or its parent directory changed. Refresh before retrying.');
  return new Error('Project skill could not be read safely. Check the project file and permissions.');
}

/** 有限发现过程仅读取两个固定项目根目录中的 SKILL.md，绝不读取 HOME 或前置元数据中的导入。 */
export async function discoverProjectSkills(options: ProjectSkillOptions, signal?: AbortSignal): Promise<ProjectSkillDiscovery> {
  throwIfAborted(signal);
  const files = new ProjectFiles({ ...options, maxFileBytes: MAX_FILE_BYTES });
  try { await files.snapshot('.', 'directory'); }
  catch (error) { throwIfAborted(signal); throw safeReadError(error); }
  const result: ProjectSkillDiscovery = { entries: [], issues: [], truncated: false };
  let bytes = 0;
  for (const root of ROOTS) {
    throwIfAborted(signal);
    let listing: { names: string[]; truncated: boolean };
    try { listing = await files.entries(root, MAX_ROOT_ENTRIES, signal); }
    catch (error) {
      throwIfAborted(signal);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.issues.push({ path: root, message: safeReadError(error).message });
      continue;
    }
    result.truncated ||= listing.truncated;
    for (const name of listing.names) {
      throwIfAborted(signal);
      let relative: string;
      try { [relative] = normalizeProjectSkillPaths([`${root}/${name}/SKILL.md`]); }
      catch { result.issues.push({ path: root, message: 'A project skill directory has an unsafe or sensitive name and was omitted.' }); continue; }
      try {
        const snapshot = await files.snapshot(relative);
        const size = snapshot.identities.at(-1)!.stat.size;
        if (size > BigInt(MAX_FILE_BYTES)) { result.issues.push({ path: relative, message: 'Project skill exceeds the 32768 byte limit.' }); continue; }
        const remaining = MAX_TOTAL_BYTES - bytes;
        if (size > BigInt(remaining) || remaining === 0) { result.truncated = true; continue; }
        // 即使文件在大小检查之后增大，也限制实际句柄读取量。
        const readLimit = Math.min(MAX_FILE_BYTES, remaining);
        const reader = new ProjectFiles({ ...options, maxFileBytes: readLimit });
        await files.verify(await reader.snapshot(relative), true);
        let source;
        try { source = await reader.read(relative, signal); }
        catch (error) { bytes += readLimit; throw error; }
        bytes += source.bytes;
        throwIfAborted(signal);
        // 新建的限量读取器仍必须解析到原始授权的根目录和文件。
        await files.verify(source.snapshot, true);
        await files.verify(snapshot, true);
        result.entries.push({ path: relative, name, hash: source.hash, bytes: source.bytes });
      } catch (error) {
        throwIfAborted(signal);
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.issues.push({ path: relative, message: safeReadError(error).message });
      }
    }
  }
  result.entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return result;
}

/** 仅加载宿主显式选择的文件；所选文件不可用时默认拒绝。 */
export async function loadProjectSkills(options: ProjectSkillLoadOptions, signal?: AbortSignal): Promise<{ sources: ProjectSkillSource[]; bytes: number }> {
  throwIfAborted(signal);
  const paths = normalizeProjectSkillPaths(options.paths);
  const perFile = options.maxFileBytes ?? MAX_FILE_BYTES;
  const totalLimit = options.maxTotalBytes ?? MAX_TOTAL_BYTES;
  // AGENTS/CLAUDE 已耗尽共享预算时，允许剩余字节数为零仍有意义。
  if (!Number.isSafeInteger(totalLimit) || totalLimit < 0 || totalLimit > 256 * 1024) throw new Error('Invalid project skill total byte limit.');
  const files = new ProjectFiles({ ...options, maxFileBytes: perFile });
  const sources: ProjectSkillSource[] = [];
  let bytes = 0;
  for (const relative of paths) {
    throwIfAborted(signal);
    let snapshot;
    try { snapshot = await files.snapshot(relative); }
    catch (error) { throwIfAborted(signal); throw safeReadError(error); }
    const size = snapshot.identities.at(-1)!.stat.size;
    if (size > BigInt(perFile)) throw new Error(`Project skill exceeds the ${perFile} byte limit.`);
    const remaining = totalLimit - bytes;
    if (size > BigInt(remaining)) throw new Error('Project skills exceed the shared instruction total byte limit.');
    try {
      const reader = new ProjectFiles({ ...options, maxFileBytes: Math.min(perFile, Math.max(1, remaining)) });
      await files.verify(await reader.snapshot(relative), true);
      const source = await reader.read(relative, signal);
      throwIfAborted(signal);
      await files.verify(source.snapshot, true);
      await files.verify(snapshot, true);
      bytes += source.bytes;
      if (bytes > totalLimit) throw new Error('Project skills exceed the shared instruction total byte limit.');
      sources.push({ path: relative, name: relative.split('/').at(-2)!, hash: source.hash, bytes: source.bytes, content: source.content });
    } catch (error) { throwIfAborted(signal); throw safeReadError(error); }
  }
  return { sources, bytes };
}
