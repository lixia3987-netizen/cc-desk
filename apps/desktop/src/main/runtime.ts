import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { IPty } from 'node-pty';
import type { Capabilities, Session, TerminalChunk, TerminalSnapshot } from '../shared/types';
import { StateStore } from './store';
import type { TerminalLauncher, TerminalLaunchResource } from './execution/terminal-launch';
import { releaseWindowsPty, windowsPtyCreationIdentity } from './execution/windows-pty-resources';
import { spawnTerminal } from './execution/spawn-terminal';
import { SubtaskTracker } from './subtask-tracker';
import { SessionTitles, type SessionTitleGenerator } from './session-titles';
import { signalPosixGroup } from './posix-process-group';
import { linuxLiveProcesses, stopWindowsProcessTree } from '@cc-desk/agent-node/process-supervisor';

const execFileAsync = promisify(execFile);
const MEMORY_LIMIT = 1024 * 1024;
const LOG_LIMIT = 5 * 1024 * 1024;
export class TerminalBuffer {
  constructor(private sequence = 0) {}
  private length = 0;
  chunks: TerminalChunk[] = [];
  push(sessionId: string, data: string): TerminalChunk {
    const chunk = { sessionId, data: data.slice(-MEMORY_LIMIT), seq: ++this.sequence };
    this.chunks.push(chunk); this.length += chunk.data.length;
    while (this.length > MEMORY_LIMIT && this.chunks.length > 1) this.length -= this.chunks.shift()!.data.length;
    return chunk;
  }
}

// 固定生命周期标签保留原始操作系统错误码和原因，不附加 argv 或环境数据。
function cleanupPhase(error: unknown, phase: string): Error {
  const failure = error instanceof Error ? error : new Error('终端资源清理失败。', { cause: error });
  try { Object.defineProperty(failure, 'cleanupPhase', { value: phase, enumerable: true, configurable: true }); return failure; }
  catch { return Object.assign(new Error('终端资源清理失败。', { cause: failure }), { cleanupPhase: phase }); }
}
interface ProcessEntry {
  process: IPty; ending: boolean; paused?: boolean; token: object;
  rootExited: boolean; spawnStartedAt: number; spawnCompletedAt: number;
  windowsCreated?: string;
  resource?: TerminalLaunchResource; resourceClose?: Promise<void>;
  release?: Promise<void>; released?: boolean; cleanup?: Promise<void>; cleanupError?: unknown;
  completion: Promise<void>; finishCompletion(): void;
}
export class Runtime {
  private titles: SessionTitles;
  private running = new Map<string, ProcessEntry>();
  private stopping = new Map<string, ProcessEntry>();
  private cleanups = new Map<Promise<void>, string>();
  private starting = new Set<string>();
  private startCompletions = new Map<string, Promise<void>>();
  private buffers = new Map<string, TerminalBuffer>();
  private logErrors = new Set<string>();
  private pending = new Map<string, string>();
  private flushTimer?: NodeJS.Timeout;
  private shuttingDown = false;
  private maintenance = false;
  private sessionMaintenance = new Set<string>();
  private cleanupErrors = new Map<string, unknown>();
  private sequence = 0;
  private cancelledStarts = new Set<string>();
  private shutdownPromise?: Promise<unknown[]>;
  private lifecycleError?: Error;
  private subtasks: SubtaskTracker;
  constructor(private store: StateStore, private onState: () => void, private onData: (chunk: TerminalChunk) => void, private launcher: TerminalLauncher, private options: { maxStoppedBuffers?: number; onError?: (error: Error) => void; capabilities?: () => Capabilities; titleGenerator?: SessionTitleGenerator } = {}) {
    this.titles = new SessionTitles(store, onState, options.titleGenerator);
    this.subtasks = new SubtaskTracker(store, onState);
    fs.mkdirSync(path.join(store.directory,'logs'), { recursive: true, mode: 0o700 });
  }
  get activeCount() { return new Set([...this.running.keys(), ...this.starting, ...this.stopping.keys()]).size; }
  get retainedBufferCount() { return this.buffers.size; }
  get pendingCleanupCount() { return this.cleanups.size; }
  get lastError() { return this.lifecycleError; }
  has(id: string) { return this.running.has(id) || this.starting.has(id) || this.stopping.has(id) || this.titles.has(id); }
  isBusy(id: string) { return this.has(id); }
  private reportError(error: unknown) {
    this.lifecycleError = error instanceof Error ? error : new Error(String(error));
    try { this.options.onError?.(this.lifecycleError); } catch { /* 错误报告不能阻止清理。 */ }
  }
  private guard(action: () => void) { try { action(); } catch (error) { this.reportError(error); } }
  private trackCleanup(id: string, cleanup: Promise<void>, entry?: ProcessEntry) {
    const tracked = cleanup.catch(error => {
      if (entry) entry.cleanupError ??= error;
      this.cleanupErrors.set(id, error); this.reportError(error);
    });
    this.cleanups.set(tracked, id);
    void tracked.then(() => this.cleanups.delete(tracked));
    return tracked;
  }
  private closeResource(id: string, entry: ProcessEntry) {
    return entry.resourceClose ??= this.trackCleanup(id, Promise.resolve().then(() => entry.resource?.close()).catch(error => { throw cleanupPhase(error, 'resource.close'); }), entry);
  }
  private trimBuffers() {
    const stopped = [...this.buffers.keys()].filter(id => !this.has(id));
    const limit = Math.max(0, this.options.maxStoppedBuffers ?? 8);
    for (const id of stopped.slice(0, Math.max(0, stopped.length - limit))) {
      this.buffers.delete(id);
      this.logErrors.delete(id);
    }
  }
  private touchBuffer(id: string, buffer: TerminalBuffer) {
    this.buffers.delete(id); this.buffers.set(id, buffer);
  }
  getSession(id: string): Session {
    const session = this.store.state.sessions.find(s => s.id === id);
    if (!session) throw new Error('会话不存在。');
    return session;
  }
  private update(id: string, patch: Partial<Session>) {
    const session = this.store.state.sessions.find(session => session.id === id);
    if (!session) return;
    const changed = (Object.keys(patch) as (keyof Session)[]).filter(key => !Object.is(session[key], patch[key]));
    if (!changed.length) return;
    const defer = changed.every(key => key === 'taskState' || key === 'terminalSync');
    this.store.change(state => Object.assign(state.sessions.find(s => s.id === id)!, patch, { updatedAt: new Date().toISOString() }), { defer });
    this.onState();
  }
  logPath(id: string) { return path.join(this.store.directory, 'logs', `${id}.log`); }
  private appendLog(id: string, data: string) {
    if (this.logErrors.has(id)) return;
    try {
      const file = this.logPath(id);
      let size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      const bytes = Buffer.from(data, 'utf8');
      for (let offset = 0; offset < bytes.length;) {
        if (size >= LOG_LIMIT) {
          fs.rmSync(file + '.previous', { force: true });
          fs.renameSync(file, file + '.previous'); size = 0;
        }
        const count = Math.min(bytes.length - offset, LOG_LIMIT - size);
        fs.appendFileSync(file, bytes.subarray(offset, offset + count), { mode: 0o600 });
        offset += count; size += count;
      }
    } catch {
      this.logErrors.add(id);
      this.guard(() => this.update(id, { error: '终端日志写入失败。会话仍在运行，请检查磁盘空间与权限。' }));
    }
  }
  private emit(id: string, data: string) {
    let buffer = this.buffers.get(id);
    if (!buffer) buffer = new TerminalBuffer(this.sequence);
    this.touchBuffer(id, buffer);
    const chunk = buffer.push(id,data);
    this.sequence = Math.max(this.sequence, chunk.seq);
    this.appendLog(id,data);
    this.onData(chunk);
    this.trimBuffers();
  }
  private queue(id: string, data: string) {
    this.pending.set(id, (this.pending.get(id) ?? '') + data);
    const entry = this.running.get(id);
    if (entry && !entry.paused && this.pending.get(id)!.length > 256 * 1024) { entry.process.pause(); entry.paused = true; }
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.guard(() => this.flush()), 24);
  }
  private flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const pending = [...this.pending];
    this.pending.clear();
    try { for (const [id,data] of pending) this.guard(() => this.emit(id,data)); }
    finally { for (const entry of this.running.values()) if (entry.paused) { entry.paused = false; this.guard(() => entry.process.resume()); } }
  }
  async start(id: string) {
    if (this.shuttingDown) throw new Error('工作台正在退出，无法启动新会话。');
    if (this.maintenance || this.sessionMaintenance.has(id)) throw new Error('执行程序正在更新，暂时不能启动终端。');
    this.titles.assertReleased(id);
    const session = this.getSession(id);
    if (this.running.has(id) || this.stopping.has(id) || this.starting.has(id)) return;
    // 已取消的元数据进程可能仍在排空；不能阻止新的前台启动。
    void this.titles.cancel(id);
    if (session.archived) throw new Error('请先取消归档，再启动会话。');
    if (session.identityPending) throw new Error('CLI 已切换会话，但新会话身份尚未确认。请从历史记录重新导入目标会话，避免恢复错误的对话。');
    if (this.activeCount >= this.store.state.settings.maxSessions) throw new Error(`已达到 ${this.store.state.settings.maxSessions} 个并发会话上限，请先停止一个会话。`);
    this.starting.add(id);
    let finishStart!: () => void;
    this.startCompletions.set(id, new Promise<void>(resolve => { finishStart = resolve; }));
    const token = {};
    let resource: TerminalLaunchResource | undefined;
    let spawned: ProcessEntry | undefined;
    try {
      this.guard(() => this.subtasks.end(id, 'interrupted', '会话已重新连接，之前的子任务不再运行。'));
      if (!fs.statSync(session.cwd).isDirectory()) throw new Error('项目目录不存在。');
      const launch = await this.launcher.prepare(session, {
        update: patch => {
          const active = this.running.get(id);
          if (!active || active.token !== token) return;
          this.guard(() => {
            const { conversationId, ...metadata } = patch;
            const current = this.getSession(id);
            this.update(id, { ...metadata,
              ...(conversationId && conversationId !== current.execution.conversationId
                ? { execution: { ...current.execution, conversationId } } : {}),
              ...(active.ending ? { taskState: 'interrupted' } : {}) });
          });
        },
        subtask: event => {
          const active = this.running.get(id);
          if (!active || active.ending || active.token !== token) return;
          this.guard(() => {
            if (event.type === 'begin') this.subtasks.begin(id, event.turnId);
            else if (event.type === 'observe') this.subtasks.observe(id, event.observation);
            else this.subtasks.end(id, event.status, event.reason);
          });
        },
        prompt: prompt => {
          const active = this.running.get(id);
          if (!active || active.ending || active.token !== token) return;
          this.guard(() => {
            this.titles.request(id, prompt, this.options.capabilities?.());
          });
        }
      });
      resource = launch.resource;
      if (this.shuttingDown || this.maintenance || this.sessionMaintenance.has(id) || this.cancelledStarts.has(id)) throw new Error('已取消启动会话。');
      this.emit(id, '\r\n\x1b[90m── ' + (session.started ? '重新连接' : '启动会话') + ' · ' + new Date().toLocaleString() + ' ──\x1b[0m\r\n');
      // 输出观察者可能在原生创建进程前同步进入维护状态。
      if (this.shuttingDown || this.maintenance || this.sessionMaintenance.has(id) || this.cancelledStarts.has(id)) throw new Error('已取消启动会话。');
      const spawnStartedAt = Date.now();
      const child = spawnTerminal(launch, session.cwd);
      const spawnCompletedAt = Date.now();
      let finishCompletion!: () => void;
      const completion = new Promise<void>(resolve => { finishCompletion = resolve; });
      const entry: ProcessEntry = spawned = { process: child, ending: false, rootExited: false, spawnStartedAt, spawnCompletedAt, token, resource, completion, finishCompletion };
      this.running.set(id, entry);
      child.onData(data => this.guard(() => this.queue(id,data)));
      child.onExit(({ exitCode }) => {
        entry.rootExited = true;
        if (this.running.get(id) !== entry) return;
        // 根进程退出不会释放子孙进程、转发工作线程或钩子。
        // 同一次清理完成之前，保持界面状态与所有权一致。
        this.running.delete(id);
        void this.titles.cancel(id);
        this.stopping.set(id, entry);
        this.guard(() => this.subtasks.end(id, entry.ending ? 'interrupted' : exitCode !== 0 ? 'failed' : 'unknown',
          entry.ending ? '会话已停止。' : exitCode !== 0 ? '会话进程异常退出。' : '会话进程已退出，未收到子任务完成通知。'));
        this.guard(() => this.flush());
        this.guard(() => this.emit(id, `\r\n\x1b[90m── 会话进程已退出 · code ${exitCode} ──\x1b[0m\r\n`));
        this.guard(() => this.update(id, { status: 'stopping', exitCode,
          taskState: entry.ending ? 'interrupted' : exitCode !== 0 ? 'error' : this.store.state.sessions.find(session => session.id === id)?.taskState,
          error: !entry.ending && exitCode !== 0 ? `会话进程退出码 ${exitCode}，请查看终端中的错误。` : undefined }));
        // 显式停止已负责进程树清理。自然退出仍负责
        // PTY 和启动器资源，在 POSIX 上也是如此。
        entry.cleanup ??= this.trackCleanup(id, (async () => {
          try {
            if (process.platform === 'win32') await this.stopWindowsTree(entry);
            else await this.stopPosixTree(entry);
          } finally {
            if (process.platform === 'win32') await this.releasePty(id, entry);
            else entry.released = true; // node-pty 在 onExit 之前关闭 POSIX 描述符。
            await this.closeResource(id, entry);
          }
        })(), entry);
        void entry.cleanup.then(() => {
          if (entry.released && this.stopping.get(id) === entry) this.stopping.delete(id);
          this.guard(() => this.update(id, {
            status: !entry.released ? 'stopping' : entry.cleanupError || (!entry.ending && exitCode !== 0) ? 'error' : 'stopped',
            ...(entry.cleanupError ? { error: '会话进程已退出，但资源清理失败。请检查残留进程并重启工作台。' } : {}),
          }));
          this.trimBuffers();
          entry.finishCompletion();
        });
      });
      if (process.platform === 'win32') entry.windowsCreated = windowsPtyCreationIdentity(child);
      this.update(id, { started: true, status: 'running', error: undefined, exitCode: undefined, taskState: undefined,
        terminalSync: launch.terminalSync });
    } catch (error) {
      // 成功创建进程后即使状态写入失败，仍持有真实进程。
      if (spawned) await this.beginStop(id, spawned);
      else if (resource) await this.trackCleanup(id, Promise.resolve().then(() => resource!.close()));
      this.guard(() => this.update(id,{ status: !this.cleanupErrors.has(id) && (this.cancelledStarts.has(id) || this.shuttingDown) ? 'stopped' : 'error', error: String((error as Error).message).slice(0,1000) }));
      throw error;
    } finally {
      this.starting.delete(id); this.cancelledStarts.delete(id); this.startCompletions.delete(id);
      finishStart(); this.trimBuffers();
    }
  }
  write(id: string, data: string) {
    if (this.maintenance || this.sessionMaintenance.has(id)) throw new Error('执行程序正在更新，暂时不能操作终端。');
    const entry = this.running.get(id);
    if (!entry || entry.ending) throw new Error('会话没有运行。请先启动或恢复。');
    entry.process.write(data);
  }
  resize(id: string, cols: number, rows: number) {
    if (this.maintenance || this.sessionMaintenance.has(id)) throw new Error('执行程序正在更新，暂时不能操作终端。');
    this.running.get(id)?.process.resize(cols,rows);
  }
  interrupt(id: string) {
    const entry = this.running.get(id);
    if (!entry || entry.ending) throw new Error('会话没有运行。请先启动或恢复。');
    entry.process.write('\x03');
    // Ctrl-C 仅是请求：后台 Agent 可能继续运行，直到钩子或进程退出证实已停止。
    this.update(id, { taskState: 'interrupted' });
  }
  stop(id: string) {
    void this.titles.cancel(id);
    if (this.starting.has(id)) this.cancelledStarts.add(id);
    const entry = this.running.get(id);
    if (!entry || entry.ending) return;
    // 先启动资源清理：持久化失败不能使停止操作无法重试。
    void this.beginStop(id, entry);
    this.guard(() => this.flush());
    this.update(id,{ status: 'stopping' });
  }
  /** 仅处理物理释放。队列和工作流确认由 SessionService 负责。 */
  async whenReleased(id: string): Promise<void> {
    await this.titles.cancel(id);
    this.titles.assertReleased(id);
    await this.startCompletions.get(id);
    const entry = this.running.get(id) ?? this.stopping.get(id);
    if (entry) {
      // 交互终端可能长期运行。清理开始之后，即使某个子孙进程
      // 仍保持 PTY 打开，清理失败也必须拒绝返回。
      while (!entry.cleanup && (this.running.get(id) === entry || this.stopping.get(id) === entry)) await new Promise(resolve => setTimeout(resolve, 25));
      await entry.cleanup;
      if (this.cleanupErrors.has(id)) throw new Error('终端清理失败，工作目录未释放。', { cause: this.cleanupErrors.get(id) });
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([entry.completion, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('终端输出流尚未释放，工作目录未释放。')), 5000); })]);
      } finally { if (timer) clearTimeout(timer); }
    }
    for (;;) {
      const cleanups = [...this.cleanups].filter(([, owner]) => owner === id).map(([cleanup]) => cleanup);
      if (!cleanups.length) break;
      await Promise.all(cleanups);
    }
    this.flush();
    this.store.flush();
    if (this.has(id) || this.cleanupErrors.has(id)) throw new Error('无法确认终端进程和资源已释放。', { cause: this.cleanupErrors.get(id) });
  }
  async stopAndWait(id: string): Promise<void> {
    let stopError: unknown;
    try { this.stop(id); } catch (error) { stopError = error; }
    await this.whenReleased(id);
    if (stopError) throw stopError;
  }
  private beginStop(id: string, entry: ProcessEntry): Promise<void> {
    if (entry.cleanup) return entry.cleanup;
    entry.ending = true;
    this.guard(() => this.subtasks.end(id, 'interrupted', '会话已停止。'));
    this.stopping.set(id, entry);
    entry.cleanup = this.trackCleanup(id, (async () => {
      try {
        if (process.platform === 'win32') await this.stopWindowsTree(entry);
        else await this.stopPosixTree(entry);
      } finally {
        await this.releasePty(id, entry);
        await this.closeResource(id, entry);
        if (entry.released && this.stopping.get(id) === entry) this.stopping.delete(id);
        this.trimBuffers();
      }
    })(), entry);
    return entry.cleanup;
  }
  private stopWindowsTree(entry: ProcessEntry): Promise<void> {
    if (!entry.windowsCreated) return Promise.reject(cleanupPhase(new Error('无法确认 Windows PTY 原始进程身份。'), 'windows.tree'));
    return stopWindowsProcessTree(entry.process.pid, undefined, {
      rootExited: entry.rootExited, created: entry.windowsCreated,
    }).catch(error => { throw cleanupPhase(error, 'windows.tree'); });
  }
  private releasePty(id: string, entry: ProcessEntry): Promise<void> {
    if (entry.release) return entry.release;
    this.stopping.set(id, entry);
    entry.release = this.trackCleanup(id, (async () => {
      try {
        if (process.platform === 'win32') await releaseWindowsPty(entry.process);
        else { try { entry.process.kill(); } catch { /* 原生句柄已关闭。 */ } }
        entry.released = true;
      } catch (error) { throw cleanupPhase(error, 'pty.release'); } finally {
        // 启动器和进程树清理完成后，由调用方释放所有权。
        this.trimBuffers();
      }
    })(), entry);
    return entry.release;
  }
  private async stopPosixTree(entry: ProcessEntry) {
    const ids = new Set([entry.process.pid]);
    try {
      const result = await execFileAsync('/bin/ps',['-eo','pid=,ppid='],{timeout:1500,maxBuffer:2*1024*1024});
      const processes = result.stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
      let changed = true;
      while (changed) { changed = false; for (const [pid,parent] of processes) if (ids.has(parent) && !ids.has(pid)) {ids.add(pid);changed=true;} }
    } catch { /* 回退到本应用持有的进程组。 */ }
    let failure: unknown;
    const signal = async (name: NodeJS.Signals) => {
      for (const pid of [...ids].reverse()) {
        try { process.kill(pid,name); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure = cleanupPhase(error, 'signal.pid.' + name); }
      }
      try { await signalPosixGroup(entry.process.pid, name); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure = cleanupPhase(error, 'signal.group.' + name); }
    };
    await signal('SIGTERM');
    // 即使根进程早于忽略信号的子孙进程退出，也保留此清理任务。
    // 这是受跟踪的 Promise，独立于根 PTY 的退出事件。
    await new Promise<void>(resolve => setTimeout(resolve,1500));
    await signal('SIGKILL');
    // 信号送达（或与退出竞态发生的操作系统错误）不能证明释放。重新
    // 检查才能确定所有保留 PID 和进程组成员均已消失。
    const deadline = Date.now() + 2000;
    for (;;) {
      try {
        if (!await this.posixTreeHasLiveMembers(ids, entry.process.pid)) break;
        if (Date.now() >= deadline) throw new Error('无法确认终端后代进程已停止。');
      } catch (error) {
        const inspection = cleanupPhase(error, 'posix.release_inspection');
        if (failure) throw new AggregateError([failure, inspection], '终端信号失败且无法确认进程树已释放。');
        throw inspection;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  private async posixTreeHasLiveMembers(ids: ReadonlySet<number>, group: number): Promise<boolean> {
    if (process.platform === 'linux') {
      const members = await Promise.all([linuxLiveProcesses({ group }), ...[...ids].map(pid => linuxLiveProcesses({ pid }))]);
      return members.some(items => items.length > 0);
    }
    const result = await execFileAsync('/bin/ps', ['-eo', 'pid=,pgid=,stat='], { timeout: 1500, maxBuffer: 2 * 1024 * 1024 });
    return this.posixSnapshotHasLiveMembers(result.stdout, ids, group);
  }
  private posixSnapshotHasLiveMembers(output: string, ids: ReadonlySet<number>, group: number): boolean {
    // 运行中的 ps 至少应包含自身。空输出或格式错误的输出
    // 表示释放依据不可用，不能证明所持有的进程树为空。
    const lines = output.trim().split('\n');
    const rows = lines.map(line => {
      const fields = line.trim().split(/\s+/);
      if (fields.length !== 3 || !/^\d+$/.test(fields[0]) || !/^\d+$/.test(fields[1])
        || !Number.isSafeInteger(Number(fields[0])) || !Number.isSafeInteger(Number(fields[1])) || !fields[2]) {
        throw new Error('无法解析终端进程存活状态。');
      }
      return { pid: Number(fields[0]), group: Number(fields[1]), state: fields[2] };
    });
    return rows.some(row => (ids.has(row.pid) || row.group === group) && !/^[ZX]/.test(row.state));
  }

  snapshot(id: string): TerminalSnapshot {
    const session = this.getSession(id);
    this.flush();
    if (!this.buffers.has(id)) {
      const buffer = new TerminalBuffer(this.sequence);
      const file = this.logPath(id);
      if (fs.existsSync(file)) {
        const fd = fs.openSync(file,'r');
        try {
          const size = fs.fstatSync(fd).size;
          const data = Buffer.alloc(Math.min(size,MEMORY_LIMIT));
          fs.readSync(fd,data,0,data.length,Math.max(0,size-data.length));
          this.sequence = buffer.push(id,data.toString('utf8')).seq;
        } finally { fs.closeSync(fd); }
      }
      this.buffers.set(id,buffer);
    }
    const buffer = this.buffers.get(id)!;
    this.touchBuffer(id, buffer);
    const result = { status: session.status, chunks: [...buffer.chunks] };
    this.trimBuffers();
    return result;
  }
  /** 终端重放只保留有界记录，不视为完整会话。 */
  exportLogs(id: string): string {
    this.getSession(id);
    this.flush();
    const files = [this.logPath(id) + '.previous', this.logPath(id)];
    const retained = files.filter(file => fs.existsSync(file)).map(file => fs.readFileSync(file));
    const header = '# cc-desk terminal log\n# Scope: retained terminal output only (previous + current, up to 10 MiB).\n# Older output may have rotated out; this is not a complete conversation transcript.\n# Exported at: ' + new Date().toISOString() + '\n\n';
    return header + Buffer.concat(retained).toString('utf8');
  }
  /** 移除会话元数据前调用；必须先停止活动进程并等待完成。 */
  forget(id: string, options: { deleteLogs?: boolean } = {}): void {
    if (this.has(id)) throw new Error('请先停止会话，再删除其运行数据。');
    this.flush();
    this.buffers.delete(id); this.pending.delete(id); this.logErrors.delete(id); this.cancelledStarts.delete(id);
    if (options.deleteLogs) {
      fs.rmSync(this.logPath(id), { force: true });
      fs.rmSync(this.logPath(id) + '.previous', { force: true });
    }
  }
  async shutdown(): Promise<void> {
    await (this.shutdownPromise ??= this.performShutdown());
    // 资源清理具有幂等性，但磁盘故障后必须重试保存。
    this.store.flush();
    this.titles.assertReleased();
    if (this.activeCount || this.cleanupErrors.size) throw new Error('无法确认全部终端进程和资源已释放，请检查残留进程后重试。', { cause: this.cleanupErrors.values().next().value });
  }
  setMaintenance(value: boolean) {
    this.maintenance = value;
    if (value) for (const id of this.starting) this.cancelledStarts.add(id);
  }
  setSessionMaintenance(ids: readonly string[], value: boolean): void {
    for (const id of ids) {
      if (value) {
        this.sessionMaintenance.add(id);
        // 屏障建立前开始的准备操作仍保持取消，即使维护已在
        // 提供方返回启动资源之前结束。
        if (this.starting.has(id)) this.cancelledStarts.add(id);
      } else this.sessionMaintenance.delete(id);
    }
  }
  async disconnectSessions(ids: readonly string[]): Promise<void> {
    const selected = new Set(ids);
    if (!this.maintenance && [...selected].some(id => !this.sessionMaintenance.has(id))) {
      throw new Error('断开终端前必须暂停目标会话。');
    }
    const failures = await this.performShutdown(false, selected);
    for (const id of selected) { try { this.titles.assertReleased(id); } catch (error) { failures.push(error); } }
    for (const id of selected) if (this.cleanupErrors.has(id)) failures.push(this.cleanupErrors.get(id));
    if ([...selected].some(id => this.has(id)) || failures.length) {
      throw new Error('无法确认目标终端进程和资源已释放，已取消更新。请关闭残留进程并重启工作台后重试。', {
        cause: new AggregateError(failures, '目标终端清理失败。'),
      });
    }
    this.store.flush();
  }
  async disconnectAll() {
    if (!this.maintenance) throw new Error('断开终端前必须暂停新会话。');
    await this.performShutdown(false);
    this.titles.assertReleased();
    if (this.activeCount || this.cleanupErrors.size) throw new Error('无法确认全部终端进程已停止，已取消更新。请关闭残留进程并重启工作台后重试。');
    this.store.flush();
  }
  private async performShutdown(permanent = true, selected?: ReadonlySet<string>): Promise<unknown[]> {
    if (permanent) this.shuttingDown = true;
    const includes = (id: string) => !selected || selected.has(id);
    const titlesStopped = Promise.all(this.titles.ids.filter(includes).map(id => this.titles.cancel(id)));
    const failures: unknown[] = [];
    for (const id of this.starting) if (includes(id)) this.cancelledStarts.add(id);
    for (const id of this.running.keys()) if (includes(id)) {
      try { this.stop(id); } catch (error) { failures.push(error); this.reportError(error); }
    }
    await Promise.all([...this.startCompletions].filter(([id]) => includes(id)).map(([, completion]) => completion));
    const deadline = Date.now() + 3000;
    const active = () => [...this.running.keys(), ...this.starting].some(includes);
    while (active() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve,50));
    for (const [id, entry] of this.running) {
      if (!includes(id)) continue;
      try { await this.beginStop(id, entry); await this.releasePty(id, entry); }
      catch (error) { failures.push(error); this.reportError(error); }
    }
    // 根进程退出不能证明子孙进程、taskkill 或启动器资源均已结束。
    const pending = () => [...this.cleanups].filter(([, id]) => includes(id)).map(([cleanup]) => cleanup);
    for (let cleanups = pending(); cleanups.length; cleanups = pending()) await Promise.all(cleanups);
    await titlesStopped;
    this.guard(() => this.flush());
    return failures;
  }
}
