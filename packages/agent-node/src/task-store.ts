import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  applyNativeTaskUpdate, canonicalNativeTask, NativeTaskError, validateNativeTaskSnapshot,
  type NativeTaskSnapshot, type NativeTaskUpdate,
} from '@cc-desk/agent-core';
import { acquireWriter, assertUuid, readRegularFile, safeDirectory, syncDirectory } from './store-files.js';

export interface NativeTaskStoreReadOptions { rootDirectory: string; conversationId: string; sessionId: string }
export type NativeTaskStoreFaultPoint = 'before_write' | 'after_sync' | 'before_rename' | 'after_rename';
export interface NativeTaskStoreOptions extends NativeTaskStoreReadOptions {
  forbiddenValues?: readonly string[];
  now?: () => string;
  fault?: (point: NativeTaskStoreFaultPoint) => void | Promise<void>;
}
export interface NativeTaskWriteOptions { assertWriteAllowed?: () => void | Promise<void> }
interface MutationReceipt { taskId: string; mutationId: string; digest: string; revision: number }
interface TaskFile {
  schemaVersion: 1; sessionId: string; conversationId: string;
  tasks: NativeTaskSnapshot[]; receipts: MutationReceipt[]; hash: string;
}
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_TASKS = 16;
const MAX_RECEIPTS = MAX_TASKS * 512;
function fail(code: string, message: string): never { throw new NativeTaskError(code, message); }
function digest(value: unknown): string { return createHash('sha256').update(canonicalNativeTask(value)).digest('hex'); }
function clone<T>(value: T): T { return JSON.parse(canonicalNativeTask(value)) as T; }
function optionsValid(options: NativeTaskStoreReadOptions): void {
  assertUuid(options.conversationId, 'conversationId');
  if (typeof options.sessionId !== 'string' || !options.sessionId.trim() || options.sessionId.length > 512 || options.sessionId.includes('\0')) fail('invalid_identity', 'Invalid task session');
}
function empty(options: NativeTaskStoreReadOptions): TaskFile { return { schemaVersion: 1, sessionId: options.sessionId, conversationId: options.conversationId, tasks: [], receipts: [], hash: '' }; }
async function read(options: NativeTaskStoreReadOptions): Promise<TaskFile> {
  optionsValid(options);
  const root = path.resolve(options.rootDirectory, 'tasks'); const directory = path.join(root, options.conversationId);
  for (const item of [root, directory]) {
    try { const stat = await lstat(item); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_path', 'Task storage requires real directories'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty(options); throw error; }
  }
  const raw = await readRegularFile(path.join(directory, 'tasks.json'), MAX_BYTES);
  if (raw === undefined) return empty(options);
  let value: TaskFile;
  try { value = JSON.parse(raw) as TaskFile; } catch { return fail('corrupt_task_store', 'Task snapshot is not complete JSON'); }
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1 || value.sessionId !== options.sessionId || value.conversationId !== options.conversationId || Object.keys(value).some(key => !['schemaVersion', 'sessionId', 'conversationId', 'tasks', 'receipts', 'hash'].includes(key))) fail('invalid_identity', 'Task snapshot schema or session mismatch');
  if (!Array.isArray(value.tasks) || value.tasks.length > MAX_TASKS || !Array.isArray(value.receipts) || value.receipts.length > MAX_RECEIPTS) fail('corrupt_task_store', 'Task snapshot exceeds limits');
  const { hash, ...body } = value;
  if (hash !== digest(body)) fail('corrupt_task_store', 'Task snapshot checksum mismatch');
  const ids = new Set<string>();
  for (const task of value.tasks) {
    validateNativeTaskSnapshot(task);
    if (task.identity.conversationId !== options.conversationId || task.identity.sessionId !== options.sessionId || ids.has(task.taskId)) fail('invalid_identity', 'Task snapshot identity mismatch');
    ids.add(task.taskId);
  }
  const receipts = new Set<string>();
  for (const receipt of value.receipts) {
    if (!receipt || typeof receipt !== 'object' || Object.keys(receipt).some(key => !['taskId', 'mutationId', 'digest', 'revision'].includes(key)) || typeof receipt.digest !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.digest)) fail('corrupt_task_store', 'Invalid task mutation receipt');
    const task = value.tasks.find(item => item.taskId === receipt.taskId);
    if (!task?.history.some(item => item.mutationId === receipt.mutationId && item.revision === receipt.revision)) fail('corrupt_task_store', 'Mutation receipt has no matching committed revision');
    const key = `${receipt.taskId}/${receipt.mutationId}`;
    if (receipts.has(key)) fail('corrupt_task_store', 'Duplicate task mutation receipt'); receipts.add(key);
  }
  if (value.receipts.length !== value.tasks.reduce((total, task) => total + task.history.length, 0)) fail('corrupt_task_store', 'Task idempotency history is incomplete');
  return value;
}

/** Separate from runtime journal: it cannot acknowledge or replay an execution side effect. */
export class NativeTaskStore {
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing = false;
  private poisoned = false;
  private constructor(private readonly options: NativeTaskStoreOptions, private readonly directory: string, private state: TaskFile, private readonly release: () => Promise<void>) {}
  static async readAllSnapshots(options: NativeTaskStoreReadOptions): Promise<NativeTaskSnapshot[]> { return clone((await read(options)).tasks); }
  static async readSnapshot(options: NativeTaskStoreReadOptions): Promise<NativeTaskSnapshot | null> { return (await this.readAllSnapshots(options)).at(-1) ?? null; }
  static async open(options: NativeTaskStoreOptions): Promise<NativeTaskStore> {
    optionsValid(options);
    const directory = await safeDirectory(path.resolve(options.rootDirectory, 'tasks'), options.conversationId);
    const release = await acquireWriter(directory);
    try { return new NativeTaskStore(options, directory, await read(options), release); }
    catch (error) { await release(); throw error; }
  }
  read(taskId: string): NativeTaskSnapshot | null { return clone(this.state.tasks.find(task => task.taskId === taskId) ?? null); }
  latest(): NativeTaskSnapshot | null { return clone(this.state.tasks.at(-1) ?? null); }
  list(): NativeTaskSnapshot[] { return clone(this.state.tasks); }
  apply(update: NativeTaskUpdate, writeOptions: NativeTaskWriteOptions = {}): Promise<NativeTaskSnapshot> {
    if (this.closed || this.closing) return Promise.reject(new NativeTaskError('store_closed', 'Task store is closing or closed'));
    // Snapshot input immediately: callers cannot alter a queued or in-flight write.
    const request = clone(update);
    const operation = this.queue.then(() => this.write(request, writeOptions));
    this.queue = operation.catch(() => {});
    return operation;
  }
  private async write(update: NativeTaskUpdate, writeOptions: NativeTaskWriteOptions): Promise<NativeTaskSnapshot> {
    if (this.closed) fail('store_closed', 'Task store is closed');
    if (this.poisoned) fail('recovery_required', 'Task persistence outcome is uncertain; reopen before further writes');
    if (update.identity?.conversationId !== this.options.conversationId || update.identity?.sessionId !== this.options.sessionId) fail('invalid_identity', 'Task update belongs to another session');
    const requestDigest = digest(update);
    const receipt = this.state.receipts.find(item => item.taskId === update.taskId && item.mutationId === update.mutationId);
    if (receipt) {
      if (receipt.digest !== requestDigest) fail('mutation_conflict', 'Mutation id was already used with another payload');
      // Return current durable state, never roll the caller back to the old receipt revision.
      return this.read(update.taskId)!;
    }
    const previous = this.state.tasks.find(task => task.taskId === update.taskId) ?? null;
    if (!previous && this.state.tasks.length >= MAX_TASKS) fail('limit_exceeded', 'Conversation task limit reached');
    if (!previous && this.state.tasks.some(task => task.execution === 'active')) fail('task_active', 'Finish or interrupt the active task before creating another');
    const next = applyNativeTaskUpdate(previous, update, this.options.now?.() ?? new Date().toISOString());
    if (next.execution === 'active' && this.state.tasks.some(task => task.taskId !== next.taskId && task.execution === 'active')) fail('task_active', 'Only one task can own a conversation run');
    const tasks = update.mutation.type === 'continue'
      ? [...this.state.tasks.filter(task => task.taskId !== next.taskId), next]
      : this.state.tasks.map(task => task.taskId === next.taskId ? next : task);
    if (!previous) tasks.push(next);
    const body = { schemaVersion: 1 as const, sessionId: this.options.sessionId, conversationId: this.options.conversationId, tasks,
      receipts: [...this.state.receipts, { taskId: update.taskId, mutationId: update.mutationId, digest: requestDigest, revision: next.revision }] };
    const state: TaskFile = { ...body, hash: digest(body) };
    const data = canonicalNativeTask(state);
    if (Buffer.byteLength(data) > MAX_BYTES) fail('limit_exceeded', 'Task snapshot capacity reached');
    if (this.options.forbiddenValues?.some(value => value.length > 0 && (data.includes(value) || data.includes(JSON.stringify(value).slice(1, -1))))) fail('secret_rejected', 'Task snapshot contains a protected credential');
    const temporary = path.join(this.directory, `.tasks-${randomUUID()}.tmp`);
    const destination = path.join(this.directory, 'tasks.json');
    let renameAttempted = false;
    try {
      await this.options.fault?.('before_write');
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await handle.writeFile(data, 'utf8'); await handle.sync(); await this.options.fault?.('after_sync'); } finally { await handle.close(); }
      // Never replace a link/non-private file created while this instance was live.
      const persisted = await readRegularFile(destination, MAX_BYTES);
      if (persisted === undefined ? Boolean(this.state.hash) : persisted !== canonicalNativeTask(this.state)) fail('writer_lost', 'Task snapshot changed outside its writer');
      await this.options.fault?.('before_rename');
      await writeOptions.assertWriteAllowed?.();
      renameAttempted = true;
      await rename(temporary, destination);
      await this.options.fault?.('after_rename');
      await syncDirectory(this.directory);
      this.state = state;
      return clone(next);
    } catch (error) {
      if (renameAttempted) this.poisoned = true;
      throw error;
    } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  }
  close(): Promise<void> {
    // A failed release remains owned and retryable. Do not admit more writes
    // after closing starts, even if the lock was removed before directory fsync failed.
    this.closing = true;
    const operation = this.queue.then(async () => { if (!this.closed) { await this.release(); this.closed = true; } });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
