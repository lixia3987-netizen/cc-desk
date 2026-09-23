import { isPermissionMode } from '../shared/permissions';
import fs from 'node:fs';
import path from 'node:path';
import { spawn as spawnProcess } from 'node:child_process';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { Capabilities, Session, TerminalChunk, TerminalSnapshot } from '../shared/types';
import { claudeArguments, cliInvocation, environment, execFileAsync, shellInvocation } from './commands';
import { transcriptExists } from './history';
import { StateStore } from './store';
import { createPtyHookBridge, supportsPtyHooks, type PtyHookBridge } from './pty-hooks';
import { SubtaskTracker } from './subtask-tracker';
import { automaticSessionTitlePatch } from '../shared/session-title';

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

interface ProcessEntry { process: IPty; ending: boolean; paused?: boolean; hooks?: PtyHookBridge; hooksClose?: Promise<void>; released?: boolean; cleanup?: Promise<void> }
export class Runtime {
  private running = new Map<string, ProcessEntry>();
  private stopping = new Map<string, ProcessEntry>();
  private cleanups = new Set<Promise<void>>();
  private starting = new Set<string>();
  private startCompletions = new Map<string, Promise<void>>();
  private buffers = new Map<string, TerminalBuffer>();
  private logErrors = new Set<string>();
  private pending = new Map<string, string>();
  private flushTimer?: NodeJS.Timeout;
  private shuttingDown = false;
  private maintenance = false;
  private cleanupError?: unknown;
  private sequence = 0;
  private cancelledStarts = new Set<string>();
  private shutdownPromise?: Promise<void>;
  private lifecycleError?: Error;
  private subtasks: SubtaskTracker;
  constructor(private store: StateStore, private onState: () => void, private onData: (chunk: TerminalChunk) => void, private options: { maxStoppedBuffers?: number; onError?: (error: Error) => void } = {}) {
    this.subtasks = new SubtaskTracker(store, onState);
    fs.mkdirSync(path.join(store.directory,'logs'), { recursive: true, mode: 0o700 });
  }
  get activeCount() { return new Set([...this.running.keys(), ...this.starting, ...this.stopping.keys()]).size; }
  get retainedBufferCount() { return this.buffers.size; }
  get pendingCleanupCount() { return this.cleanups.size; }
  get lastError() { return this.lifecycleError; }
  has(id: string) { return this.running.has(id) || this.starting.has(id) || this.stopping.has(id); }
  private reportError(error: unknown) {
    this.lifecycleError = error instanceof Error ? error : new Error(String(error));
    try { this.options.onError?.(this.lifecycleError); } catch { /* Error reporting must never prevent cleanup. */ }
  }
  private guard(action: () => void) { try { action(); } catch (error) { this.reportError(error); } }
  private trackCleanup(cleanup: Promise<void>) {
    const tracked = cleanup.catch(error => { this.cleanupError = error; this.reportError(error); });
    this.cleanups.add(tracked);
    void tracked.then(() => this.cleanups.delete(tracked));
    return tracked;
  }
  private closeHooks(entry: ProcessEntry) {
    return entry.hooksClose ??= this.trackCleanup(Promise.resolve().then(() => entry.hooks?.close()));
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
  async start(id: string, capabilities: Capabilities) {
    if (this.shuttingDown) throw new Error('工作台正在退出，无法启动新会话。');
    if (this.maintenance) throw new Error('Claude Code 正在更新，暂时不能启动终端。');
    const session = this.getSession(id);
    if (this.has(id)) return;
    if (session.archived) throw new Error('请先取消归档，再启动会话。');
    if (session.identityPending) throw new Error('CLI 已切换会话，但新会话身份尚未确认。请从历史记录重新导入目标会话，避免恢复错误的对话。');
    if (session.kind === 'claude' && session.observedPermissionMode && !isPermissionMode(session.observedPermissionMode)) throw new Error('上次 CLI 使用了客户端启动选项以外的权限模式。请先在会话设置中明确选择受支持的权限模式，再恢复。');
    if (this.activeCount >= this.store.state.settings.maxSessions) throw new Error(`已达到 ${this.store.state.settings.maxSessions} 个并发会话上限，请先停止一个会话。`);
    this.starting.add(id);
    let finishStart!: () => void;
    this.startCompletions.set(id, new Promise<void>(resolve => { finishStart = resolve; }));
    let hooks: PtyHookBridge | undefined;
    let spawned: ProcessEntry | undefined;
    try {
      this.guard(() => this.subtasks.end(id, 'interrupted', '会话已重新连接，之前的子任务不再运行。'));
      if (!fs.statSync(session.cwd).isDirectory()) throw new Error('项目目录不存在。');
      const env = environment();
      let file: string; let args: string[];
      if (session.kind === 'claude') {
        if (!capabilities.available) throw new Error(capabilities.error || 'Claude Code 尚未就绪，请在设置中检测。');
        const cli = cliInvocation(this.store.state.settings, env);
        file = cli.file;
        args = [...cli.prefix, ...claudeArguments(session, capabilities, await transcriptExists(session.claudeId))];
        if (supportsPtyHooks(capabilities)) {
          hooks = await createPtyHookBridge(session.claudeId, patch => {
            const active = this.running.get(id);
            if (active && active.hooks === hooks) this.guard(() => this.update(id, active.ending ? { ...patch, taskState: 'interrupted' } : patch));
          }, event => {
            const active = this.running.get(id);
            if (!active || active.ending || active.hooks !== hooks) return;
            this.guard(() => {
              if (event.type === 'begin') this.subtasks.begin(id, event.turnId);
              else if (event.type === 'observe') this.subtasks.observe(id, event.observation);
              else this.subtasks.end(id, event.status, event.reason);
            });
          }, prompt => {
            const active = this.running.get(id);
            if (!active || active.ending || active.hooks !== hooks) return;
            this.guard(() => {
              const patch = automaticSessionTitlePatch(this.getSession(id), prompt);
              if (patch) this.update(id, patch);
            });
          });
          args.push('--settings', hooks.settings);
        }
      } else ({ file, args } = shellInvocation(this.store.state.settings));
      if (this.shuttingDown || this.maintenance || this.cancelledStarts.has(id)) throw new Error('已取消启动会话。');
      this.emit(id, '\r\n\x1b[90m── ' + (session.started ? '重新连接' : '启动会话') + ' · ' + new Date().toLocaleString() + ' ──\x1b[0m\r\n');
      const child = pty.spawn(file, args, { name: 'xterm-256color', cwd: session.cwd, env, cols: 100, rows: 30 });
      const entry: ProcessEntry = spawned = { process: child, ending: false, hooks };
      this.running.set(id, entry);
      child.onData(data => this.guard(() => this.queue(id,data)));
      child.onExit(({ exitCode }) => {
        if (this.running.get(id) !== entry) return;
        // Detach ownership before any fallible persistence, output, or UI callback.
        this.running.delete(id);
        if (process.platform === 'win32') this.releasePty(entry);
        void this.closeHooks(entry);
        this.guard(() => this.subtasks.end(id, entry.ending ? 'interrupted' : exitCode !== 0 ? 'failed' : 'unknown',
          entry.ending ? '会话已停止。' : exitCode !== 0 ? '会话进程异常退出。' : '会话进程已退出，未收到子任务完成通知。'));
        this.guard(() => this.flush());
        this.guard(() => this.emit(id, `\r\n\x1b[90m── 会话进程已退出 · code ${exitCode} ──\x1b[0m\r\n`));
        this.guard(() => this.update(id, { status: entry.ending || exitCode === 0 ? 'stopped' : 'error', exitCode,
          taskState: entry.ending ? 'interrupted' : exitCode !== 0 ? 'error' : this.store.state.sessions.find(session => session.id === id)?.taskState,
          error: !entry.ending && exitCode !== 0 ? `Claude / Shell 退出码 ${exitCode}，请查看终端中的错误。` : undefined }));
        this.trimBuffers();
      });
      this.update(id, { started: true, status: 'running', error: undefined, exitCode: undefined, taskState: undefined,
        terminalSync: session.kind === 'claude' ? hooks ? 'waiting' : 'unsupported' : undefined });
    } catch (error) {
      // A successful spawn followed by a failed state write still owns a real process.
      if (spawned) await this.beginStop(id, spawned);
      else { try { await hooks?.close(); } catch (closeError) { this.reportError(closeError); } }
      this.guard(() => this.update(id,{ status: this.cancelledStarts.has(id) || this.shuttingDown ? 'stopped' : 'error', error: String((error as Error).message).slice(0,1000) }));
      throw error;
    } finally {
      this.starting.delete(id); this.cancelledStarts.delete(id); this.startCompletions.delete(id);
      finishStart(); this.trimBuffers();
    }
  }
  write(id: string, data: string) {
    const entry = this.running.get(id);
    if (!entry || entry.ending) throw new Error('会话没有运行。请先启动或恢复。');
    entry.process.write(data);
  }
  resize(id: string, cols: number, rows: number) { this.running.get(id)?.process.resize(cols,rows); }
  interrupt(id: string) {
    this.write(id,'\x03');
    // Ctrl-C is only a request: background agents may continue until a hook or process exit confirms otherwise.
    this.update(id, { taskState: 'interrupted' });
  }
  stop(id: string) {
    if (this.starting.has(id)) this.cancelledStarts.add(id);
    const entry = this.running.get(id);
    if (!entry || entry.ending) return;
    // Start resource cleanup first: failed persistence must not make stop irreversible.
    void this.beginStop(id, entry);
    this.guard(() => this.flush());
    this.update(id,{ status: 'stopping' });
  }
  private beginStop(id: string, entry: ProcessEntry): Promise<void> {
    if (entry.cleanup) return entry.cleanup;
    entry.ending = true;
    this.guard(() => this.subtasks.end(id, 'interrupted', '会话已停止。'));
    this.stopping.set(id, entry);
    entry.cleanup = this.trackCleanup((async () => {
      try {
        if (process.platform === 'win32') await this.stopWindowsTree(entry);
        else await this.stopPosixTree(entry);
      } finally {
        this.releasePty(entry);
        await this.closeHooks(entry);
        if (this.stopping.get(id) === entry) this.stopping.delete(id);
        this.trimBuffers();
      }
    })());
    return entry.cleanup;
  }
  private stopWindowsTree(entry: ProcessEntry): Promise<void> {
    return new Promise((resolve, reject) => {
      const killer = spawnProcess('taskkill', ['/PID',String(entry.process.pid),'/T','/F'], { windowsHide:true, stdio:'ignore' });
      let done = false;
      const finish = (error?: Error) => {
        if (done) return;
        done = true; clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => {
        try { killer.kill(); } catch { /* Already exited. */ }
        finish(new Error('等待会话进程树停止超时。'));
      }, 2500);
      killer.once('error', error => finish(error));
      killer.once('close', code => finish(code === 0 ? undefined : new Error('无法确认会话进程树已完全停止。')));
    });
  }
  private releasePty(entry: ProcessEntry) {
    if (entry.released) return;
    entry.released = true;
    // External taskkill can leave node-pty's ConPTY worker alive after the root exits.
    try { entry.process.kill(); } catch { /* Native handle is already closed. */ }
  }
  private async stopPosixTree(entry: ProcessEntry) {
    const ids = new Set([entry.process.pid]);
    try {
      const result = await execFileAsync('ps',['-eo','pid=,ppid='],{timeout:1500,maxBuffer:2*1024*1024});
      const processes = result.stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
      let changed = true;
      while (changed) { changed = false; for (const [pid,parent] of processes) if (ids.has(parent) && !ids.has(pid)) {ids.add(pid);changed=true;} }
    } catch { /* Fall back to the owned process group. */ }
    let failure: unknown;
    const signal = (name: NodeJS.Signals) => {
      for (const pid of [...ids].reverse()) {
        try { process.kill(pid,name); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure = error; }
      }
      try { process.kill(-entry.process.pid,name); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure = error; }
    };
    signal('SIGTERM');
    // Keep this cleanup even when the root exits before an ignoring descendant.
    // This is a tracked Promise, independent of the root PTY's exit event.
    await new Promise<void>(resolve => setTimeout(resolve,1500));
    signal('SIGKILL');
    if (failure) throw failure;
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
  /** Terminal replay is bounded retention, never represented as the complete Claude conversation. */
  exportLogs(id: string): string {
    this.getSession(id);
    this.flush();
    const files = [this.logPath(id) + '.previous', this.logPath(id)];
    const retained = files.filter(file => fs.existsSync(file)).map(file => fs.readFileSync(file));
    const header = '# Claude Workbench terminal log\n# Scope: retained terminal output only (previous + current, up to 10 MiB).\n# Older output may have rotated out; this is not a complete Claude transcript.\n# Exported at: ' + new Date().toISOString() + '\n\n';
    return header + Buffer.concat(retained).toString('utf8');
  }
  /** Call before removing session metadata; active processes must be stopped and awaited first. */
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
    // Resource cleanup is idempotent, but saving must be retried after a disk fault.
    this.store.flush();
  }
  setMaintenance(value: boolean) { this.maintenance = value; }
  async disconnectAll() {
    if (!this.maintenance) throw new Error('断开终端前必须暂停新会话。');
    await this.performShutdown(false);
    if (this.activeCount || this.cleanupError) throw new Error('无法确认全部终端进程已停止，已取消更新。请关闭残留进程并重启工作台后重试。');
    this.store.flush();
  }
  private async performShutdown(permanent = true) {
    if (permanent) this.shuttingDown = true;
    for (const id of this.starting) this.cancelledStarts.add(id);
    for (const id of this.running.keys()) this.guard(() => this.stop(id));
    await Promise.all([...this.startCompletions.values()]);
    const deadline = Date.now() + 3000;
    while ((this.running.size || this.starting.size) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve,50));
    for (const [id, entry] of this.running) {
      await this.beginStop(id, entry);
      this.releasePty(entry);
    }
    // Root exit is not proof that descendants, taskkill, or hook servers have finished.
    while (this.cleanups.size) await Promise.all([...this.cleanups]);
    this.guard(() => this.flush());
  }
}
