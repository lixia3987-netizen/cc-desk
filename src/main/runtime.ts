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

interface ProcessEntry { process: IPty; ending: boolean; paused?: boolean; killTimer?: NodeJS.Timeout; hooks?: PtyHookBridge; released?: boolean }
export class Runtime {
  private running = new Map<string, ProcessEntry>();
  private starting = new Set<string>();
  private buffers = new Map<string, TerminalBuffer>();
  private logErrors = new Set<string>();
  private pending = new Map<string, string>();
  private flushTimer?: NodeJS.Timeout;
  private shuttingDown = false;
  private sequence = 0;
  private cancelledStarts = new Set<string>();
  constructor(private store: StateStore, private onState: () => void, private onData: (chunk: TerminalChunk) => void, private options: { maxStoppedBuffers?: number } = {}) {
    fs.mkdirSync(path.join(store.directory,'logs'), { recursive: true, mode: 0o700 });
  }
  get activeCount() { return new Set([...this.running.keys(), ...this.starting]).size; }
  get retainedBufferCount() { return this.buffers.size; }
  has(id: string) { return this.running.has(id) || this.starting.has(id); }
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
    if (!this.store.state.sessions.some(session => session.id === id)) return;
    this.store.change(state => Object.assign(state.sessions.find(s => s.id === id)!, patch, { updatedAt: new Date().toISOString() }));
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
      this.update(id, { error: '终端日志写入失败。会话仍在运行，请检查磁盘空间与权限。' });
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
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 24);
  }
  private flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    for (const [id,data] of this.pending) this.emit(id,data);
    this.pending.clear();
    for (const entry of this.running.values()) if (entry.paused) { entry.process.resume(); entry.paused = false; }
  }
  async start(id: string, capabilities: Capabilities) {
    if (this.shuttingDown) throw new Error('工作台正在退出，无法启动新会话。');
    const session = this.getSession(id);
    if (this.running.has(id) || this.starting.has(id)) return;
    if (session.archived) throw new Error('请先取消归档，再启动会话。');
    if (session.identityPending) throw new Error('CLI 已切换会话，但新会话身份尚未确认。请从历史记录重新导入目标会话，避免恢复错误的对话。');
    if (session.kind === 'claude' && session.observedPermissionMode && !['default', 'plan', 'acceptEdits'].includes(session.observedPermissionMode)) throw new Error('上次 CLI 使用了客户端启动选项以外的权限模式。请先在会话设置中明确选择默认、计划或接受编辑，再恢复。');
    if (this.activeCount >= this.store.state.settings.maxSessions) throw new Error(`已达到 ${this.store.state.settings.maxSessions} 个并发会话上限，请先停止一个会话。`);
    this.starting.add(id);
    let hooks: PtyHookBridge | undefined;
    try {
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
            if (active && active.hooks === hooks) this.update(id, active.ending ? { ...patch, taskState: 'interrupted' } : patch);
          });
          args.push('--settings', hooks.settings);
        }
      } else ({ file, args } = shellInvocation(this.store.state.settings));
      if (this.shuttingDown || this.cancelledStarts.has(id)) throw new Error('已取消启动会话。');
      this.emit(id, '\r\n\x1b[90m── ' + (session.started ? '重新连接' : '启动会话') + ' · ' + new Date().toLocaleString() + ' ──\x1b[0m\r\n');
      const child = pty.spawn(file, args, { name: 'xterm-256color', cwd: session.cwd, env, cols: 100, rows: 30 });
      const entry: ProcessEntry = { process: child, ending: false, hooks };
      this.running.set(id, entry);
      child.onData(data => this.queue(id,data));
      child.onExit(({ exitCode }) => {
        if (this.running.get(id) !== entry) return;
        this.flush(); this.running.delete(id);
        if (process.platform === 'win32') this.releasePty(entry);
        void entry.hooks?.close();
        this.emit(id, `\r\n\x1b[90m── 会话进程已退出 · code ${exitCode} ──\x1b[0m\r\n`);
        this.update(id, { status: entry.ending || exitCode === 0 ? 'stopped' : 'error', exitCode,
          taskState: entry.ending ? 'interrupted' : exitCode !== 0 ? 'error' : this.getSession(id).taskState,
          error: !entry.ending && exitCode !== 0 ? `Claude / Shell 退出码 ${exitCode}，请查看终端中的错误。` : undefined });
      });
      this.update(id, { started: true, status: 'running', error: undefined, exitCode: undefined, taskState: undefined,
        terminalSync: session.kind === 'claude' ? hooks ? 'waiting' : 'unsupported' : undefined });
    } catch (error) {
      await hooks?.close();
      this.update(id,{ status: this.cancelledStarts.has(id) || this.shuttingDown ? 'stopped' : 'error', error: String((error as Error).message).slice(0,1000) });
      throw error;
    } finally { this.starting.delete(id); this.cancelledStarts.delete(id); this.trimBuffers(); }
  }
  write(id: string, data: string) {
    const entry = this.running.get(id);
    if (!entry || entry.ending) throw new Error('会话没有运行。请先启动或恢复。');
    entry.process.write(data);
  }
  resize(id: string, cols: number, rows: number) { this.running.get(id)?.process.resize(cols,rows); }
  interrupt(id: string) { this.write(id,'\x03'); this.update(id, { taskState: 'interrupted' }); }
  stop(id: string) {
    if (this.starting.has(id)) this.cancelledStarts.add(id);
    this.flush();
    const entry = this.running.get(id);
    if (!entry || entry.ending) return;
    entry.ending = true;
    this.update(id,{ status: 'stopping' });
    if (process.platform === 'win32') {
      const killer = spawnProcess('taskkill', ['/PID',String(entry.process.pid),'/T','/F'], { windowsHide:true, stdio:'ignore' });
      const cleanup = () => { if (entry.killTimer) clearTimeout(entry.killTimer); this.releasePty(entry); };
      killer.once('error', cleanup);
      killer.once('close', cleanup);
      entry.killTimer = setTimeout(() => { try { killer.kill(); } catch { /* Already exited. */ } cleanup(); }, 2500);
      entry.killTimer.unref();
    } else void this.stopPosixTree(entry);
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
    const signal = (name: NodeJS.Signals) => {
      for (const pid of [...ids].reverse()) { try { process.kill(pid,name); } catch { /* Exited. */ } }
      try { process.kill(-entry.process.pid,name); } catch { /* Group exited. */ }
    };
    signal('SIGTERM');
    // Keep this cleanup even when the root exits before an ignoring descendant.
    entry.killTimer = setTimeout(() => signal('SIGKILL'),1500);
    entry.killTimer.unref();
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
  async shutdown() {
    this.shuttingDown = true;
    for (const id of this.running.keys()) this.stop(id);
    const deadline = Date.now() + 3000;
    while ((this.running.size || this.starting.size) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve,50));
    for (const entry of this.running.values()) { this.releasePty(entry); await entry.hooks?.close(); }
    this.flush();
  }
}
