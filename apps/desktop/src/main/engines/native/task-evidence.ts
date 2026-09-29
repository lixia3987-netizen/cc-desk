import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { constants, type BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import type { PreparedTool, ToolResult } from '@cc-desk/agent-core';
import type { NativeTaskCommand, NativeTaskEvidence, NativeTaskSnapshot, NativeTaskWorkspace, NativeTaskChangeSummary } from '@cc-desk/contracts/native-task';
import { isSensitivePath, isWithin, normalizeProjectPath, ProjectFiles, throwIfAborted, type PathSnapshot } from '@cc-desk/agent-node/tools';

export type TaskWorkspace = NativeTaskWorkspace;
export type TaskWorkspaceFile = TaskWorkspace['files'][number];
export type TaskChangeSummary = NativeTaskChangeSummary;
/** Receipt comparison needs no second copy of the complete file inventory. */
export type TaskCommandWorkspace = Pick<TaskWorkspace, 'fingerprint' | 'rootFingerprint' | 'complete'>;
export interface TaskWorkspaceOptions {
  projectRoot: string; excludedRoots?: readonly string[]; signal?: AbortSignal;
  limits?: { maxEntries?: number; maxBytes?: number; maxFileBytes?: number; maxMs?: number };
}
export interface TaskCommandEvidenceOptions {
  task: Pick<NativeTaskSnapshot, 'taskId' | 'identity' | 'planRevision' | 'acceptanceRevision'>; before: TaskCommandWorkspace; after: TaskCommandWorkspace;
  /** Chosen by host UI/declared acceptance, never inferred from stdout. */
  stepIds?: string[]; criterionIds?: string[]; now?: string;
}

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const EXCLUDED = ['.git', 'node_modules', 'dist', 'release', '.next', 'coverage'];
const SCOPE = ['ordinary-project-files-v1', ...EXCLUDED.map(item => `exclude-directory:${item}`), 'exclude-sensitive-paths', 'exclude-host-protected-roots'];
const NOFOLLOW = process.platform === 'win32' ? 0 : ((constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
const DIRECTORY = process.platform === 'win32' ? 0 : constants.O_DIRECTORY;
const sameObject = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.isFile() === b.isFile() && a.isDirectory() === b.isDirectory();
const sameVersion = (a: BigIntStats, b: BigIntStats) => sameObject(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** Mirrors ProjectFiles' handle boundary, but hashes binary assets without decoding. */
async function readBytes(files: ProjectFiles, snapshot: PathSnapshot, maximum: number, check: () => void): Promise<{ bytes: Buffer; stat: BigIntStats }> {
  const handles: FileHandle[] = [];
  try {
    let handle: FileHandle;
    if (process.platform === 'linux') {
      handle = await fs.open(snapshot.identities[0].path, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
      handles.push(handle);
      if (!sameObject(await handle.stat({ bigint: true }), snapshot.identities[0].stat)) throw new Error('changed');
      for (let index = 1; index < snapshot.identities.length; index++) {
        handle = await fs.open(`/proc/self/fd/${handle.fd}/${path.basename(snapshot.identities[index].path)}`, constants.O_RDONLY | NOFOLLOW | (index < snapshot.identities.length - 1 ? DIRECTORY : 0));
        handles.push(handle);
        if (!sameObject(await handle.stat({ bigint: true }), snapshot.identities[index].stat)) throw new Error('changed');
      }
    } else {
      handle = await fs.open(snapshot.absolute, constants.O_RDONLY | NOFOLLOW);
      handles.push(handle);
    }
    const stat = await handle.stat({ bigint: true });
    if (!sameVersion(stat, snapshot.identities.at(-1)!.stat) || stat.size > BigInt(maximum)) throw new Error('changed');
    const bytes = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      check();
      const read = await handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
      if (read.bytesRead === 0) throw new Error('changed');
      offset += read.bytesRead;
    }
    check();
    if (!sameVersion(stat, await handle.stat({ bigint: true }))) throw new Error('changed');
    if (process.platform === 'linux' && await fs.realpath(`/proc/self/fd/${handle.fd}`) !== snapshot.absolute) throw new Error('changed');
    await files.verify(snapshot, true);
    return { bytes, stat };
  } finally { await Promise.all(handles.map(handle => handle.close())); }
}

function bound(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error('Invalid task workspace scan limit.');
  return result;
}

/** Capture bytes, not HEAD: uncommitted and externally changed files participate. */
export async function captureTaskWorkspace(options: TaskWorkspaceOptions): Promise<TaskWorkspace> {
  const limits = options.limits ?? {};
  const maxEntries = bound(limits.maxEntries, 4000, 4000);
  const maxBytes = bound(limits.maxBytes, 32 * 1024 * 1024, 128 * 1024 * 1024);
  const maxFileBytes = bound(limits.maxFileBytes, 4 * 1024 * 1024, 16 * 1024 * 1024);
  const maxMs = bound(limits.maxMs, 5000, 30000);
  const started = performance.now(), issues = new Set<string>(), files: TaskWorkspaceFile[] = [];
  const checked: PathSnapshot[] = [];
  const scope = [...SCOPE];
  let rootFingerprint = hash(path.resolve(options.projectRoot)), usedEntries = 0, usedBytes = 0;
  const check = () => {
    throwIfAborted(options.signal);
    if (performance.now() - started > maxMs) { issues.add('time_limit'); throw new Error('bounded'); }
  };
  try {
    check();
    const root = await fs.realpath(options.projectRoot);
    const exclusions: string[] = [];
    for (const excluded of options.excludedRoots ?? []) {
      check();
      const absolute = path.resolve(excluded);
      const canonical = await fs.realpath(absolute).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return absolute; });
      exclusions.push(absolute, canonical);
    }
    const distinctExclusions = [...new Set(exclusions)].sort();
    scope.push(...distinctExclusions.map(item => `protected-root:${hash(item)}`));
    const projectFiles = new ProjectFiles({ projectRoot: root, excludedRoots: distinctExclusions });
    const rootSnapshot = await projectFiles.snapshot('.', 'directory');
    const rootStat = rootSnapshot.identities[0].stat;
    rootFingerprint = hash(`${root}\0${rootStat.dev}\0${rootStat.ino}`);
    const walk = async (relative: string, depth: number) => {
      check();
      if (depth > 64) { issues.add('depth_limit'); return; }
      const snapshot = await projectFiles.snapshot(relative, 'directory');
      checked.push(snapshot);
      const entries = await projectFiles.entries(relative, Math.max(1, maxEntries - usedEntries), options.signal);
      if (entries.truncated) issues.add('entry_limit');
      for (const name of entries.names) {
        check();
        if (++usedEntries > maxEntries) { issues.add('entry_limit'); return; }
        const candidate = relative === '.' ? name : `${relative}/${name}`;
        if (name === '.git' || isSensitivePath(candidate)) continue;
        const absolute = path.join(root, candidate);
        if (distinctExclusions.some(item => isWithin(item, absolute))) continue;
        try {
          normalizeProjectPath(candidate);
          const stat = await fs.lstat(absolute, { bigint: true });
          if (stat.isSymbolicLink()) { issues.add('unsupported_link'); continue; }
          if (stat.isDirectory()) {
            if (!EXCLUDED.includes(name)) await walk(candidate, depth + 1);
          } else if (stat.isFile()) {
            if (stat.size > BigInt(maxFileBytes)) { issues.add('file_byte_limit'); continue; }
            if (stat.size > BigInt(maxBytes - usedBytes)) { issues.add('total_byte_limit'); continue; }
            const target = await projectFiles.snapshot(candidate);
            const read = await readBytes(projectFiles, target, Math.min(maxFileBytes, maxBytes - usedBytes), check);
            usedBytes += read.bytes.length;
            files.push({ path: candidate, hash: hash(read.bytes), bytes: read.bytes.length, mode: Number(read.stat.mode & 0o777n) });
            checked.push(target);
          } else issues.add('unsupported_file_type');
        } catch (error) {
          throwIfAborted(options.signal);
          if (issues.has('time_limit')) throw error;
          issues.add('unreadable_or_changed');
        }
      }
    };
    await walk('.', 0);
    // Verify the whole read interval, including directory membership. A tree is
    // still an optimistic observation, not an OS-level filesystem transaction.
    for (const snapshot of checked) {
      check();
      await projectFiles.verify(snapshot, snapshot.kind === 'file');
      const after = await fs.lstat(snapshot.absolute, { bigint: true });
      if (!sameVersion(snapshot.identities.at(-1)!.stat, after)) { issues.add('changed_during_scan'); break; }
    }
  } catch {
    throwIfAborted(options.signal);
    if (!issues.has('time_limit')) issues.add('unreadable_or_changed');
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return {
    fingerprint: hash(JSON.stringify({ rootFingerprint, scope, files })), complete: issues.size === 0,
    rootFingerprint, files, scope, issues: [...issues].sort(), capturedAt: new Date().toISOString(),
  };
}

/** Changes are observations since the task baseline, never an automatic rollback set. */
export function describeTaskChanges(baseline: TaskWorkspace, current: TaskWorkspace, maxPaths = 200): TaskChangeSummary {
  maxPaths = bound(maxPaths, 200, 4000);
  const comparable = baseline.rootFingerprint === current.rootFingerprint && JSON.stringify(baseline.scope) === JSON.stringify(current.scope);
  const complete = comparable && baseline.complete && current.complete;
  const result: TaskChangeSummary = { complete, added: [], modified: [], removed: [], attribution: 'observed_since_task_start', truncated: false };
  if (!comparable) return result;
  const before = new Map(baseline.files.map(file => [file.path, file]));
  const after = new Map(current.files.map(file => [file.path, file]));
  let count = 0;
  const add = (kind: 'added' | 'modified' | 'removed', name: string) => { if (count++ < maxPaths) result[kind].push(name); else result.truncated = true; };
  for (const file of current.files) {
    const previous = before.get(file.path);
    if (previous && (previous.hash !== file.hash || previous.mode !== file.mode)) add('modified', file.path);
    else if (!previous && baseline.complete) add('added', file.path);
  }
  if (current.complete) for (const file of baseline.files) if (!after.has(file.path)) add('removed', file.path);
  return result;
}

/** A command receipt stays unverified until a human reviews its relevance/coverage. */
export function commandEvidenceReceipt(prepared: PreparedTool, result: ToolResult, options: TaskCommandEvidenceOptions): NativeTaskEvidence | undefined {
  if (prepared.call.name !== 'run_command' || prepared.definition.risk !== 'command') return undefined;
  return makeCommandEvidenceReceipt(prepared, result, options);
}

/** Only the host's durable terminal observer may use a start_command call as evidence. */
export function terminalCommandEvidenceReceipt(prepared: PreparedTool, result: ToolResult, options: TaskCommandEvidenceOptions): NativeTaskEvidence | undefined {
  if (prepared.call.name !== 'start_command' || prepared.definition.risk !== 'command') return undefined;
  return makeCommandEvidenceReceipt(prepared, result, options);
}

function makeCommandEvidenceReceipt(prepared: PreparedTool, result: ToolResult, options: TaskCommandEvidenceOptions): NativeTaskEvidence {
  const { task, before, after } = options;
  if (typeof prepared.input.executable !== 'string' || !Array.isArray(prepared.input.argv) || prepared.input.argv.some(arg => typeof arg !== 'string') || typeof prepared.input.cwd !== 'string') throw new Error('Invalid host command receipt.');
  const command: NativeTaskCommand = { executable: prepared.input.executable, argv: [...prepared.input.argv] as string[], cwd: prepared.input.cwd };
  const value = result.output !== null && typeof result.output === 'object' && !Array.isArray(result.output) ? result.output : {};
  const exitCode = typeof value.exitCode === 'number' && Number.isSafeInteger(value.exitCode) ? value.exitCode : null;
  const recordedOutput = JSON.stringify(result.output);
  const outputBytes = Buffer.from(recordedOutput);
  const truncated = result.truncated === true || value.truncated === true || outputBytes.length > 8192;
  const sameWorkspace = before.complete && after.complete && before.fingerprint === after.fingerprint && before.rootFingerprint === after.rootFingerprint;
  const failed = result.status === 'failed' || value.timedOut === true || (exitCode !== null && exitCode !== 0);
  const reliable = result.status === 'completed' && exitCode === 0 && value.cleanup === 'released' && value.cancelled === false && value.timedOut === false && value.signal === null && !truncated && sameWorkspace;
  const reasons = [failed ? '命令检查失败；不能据此声明验收通过。' : reliable ? '命令退出成功；仍需人工确认它覆盖了对应验收条件，不能自动判定测试数量、跳过项或整体验收。' : '命令回执、日志或执行前后工作区不完整/不一致；保留原始结果待核查。'];
  if (!sameWorkspace) reasons.push('工作区范围未完整核对或命令期间文件发生变化。');
  if (truncated) reasons.push('日志已截断，摘要不代表完整输出。');
  return {
    id: `command-${hash(`${task.taskId}\0${task.identity.runId}\0${prepared.call.id}`).slice(0, 40)}`,
    identity: { ...task.identity }, stepIds: [...(options.stepIds ?? [])], criterionIds: [...(options.criterionIds ?? [])],
    source: 'command', status: failed ? 'failed' : 'unverified', planRevision: task.planRevision, acceptanceRevision: task.acceptanceRevision,
    workspaceFingerprint: after.fingerprint, workspaceComplete: sameWorkspace,
    toolCallId: prepared.call.id, command, exitCode,
    output: new TextDecoder('utf-8', { fatal: true }).decode(outputBytes.subarray(0, 8192), { stream: true }),
    outputDigest: hash(recordedOutput), truncated, reason: reasons.join(' '), createdAt: options.now ?? new Date().toISOString(),
  };
}
