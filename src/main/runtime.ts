import fs from 'node:fs';
import path from 'node:path';
import { spawn as spawnProcess } from 'node:child_process';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { Capabilities, Session, TerminalChunk, TerminalSnapshot } from '../shared/types';
import { claudeArguments, cliInvocation, environment, execFileAsync, shellInvocation } from './commands';
import { transcriptExists } from './history';
import { StateStore } from './store';

const MEMORY_LIMIT = 1024 * 1024;
const LOG_LIMIT = 5 * 1024 * 1024;
export class TerminalBuffer {
  private sequence = 0;
  private length = 0;
  chunks: TerminalChunk[] = [];
  push(sessionId: string, data: string): TerminalChunk {
    const chunk = { sessionId, data: data.slice(-MEMORY_LIMIT), seq: ++this.sequence };
    this.chunks.push(chunk); this.length += chunk.data.length;
    while (this.length > MEMORY_LIMIT && this.chunks.length > 1) this.length -= this.chunks.shift()!.data.length;
    return chunk;
  }
}

interface ProcessEntry { process: IPty; ending: boolean; paused?: boolean; killTimer?: NodeJS.Timeout }
export class Runtime {
  private running = new Map<string, ProcessEntry>();
  private starting = new Set<string>();
  private buffers = new Map<string, TerminalBuffer>();
  private logErrors = new Set<string>();
  private pending = new Map<string, string>();
  private flushTimer?: NodeJS.Timeout;
  private shuttingDown = false;
  constructor(private store: StateStore, private onState: () => void, private onData: (chunk: TerminalChunk) => void) {
    fs.mkdirSync(path.join(store.directory,'logs'), { recursive: true, mode: 0o700 });
  }
  get activeCount() { return this.running.size + this.starting.size; }
  getSession(id: string): Session {
    const session = this.store.state.sessions.find(s => s.id === id);
    if (!session) throw new Error('会话不存在。');
    return session;
  }
  private update(id: string, patch: Partial<Session>) {
    this.store.change(state => Object.assign(state.sessions.find(s => s.id === id)!, patch, { updatedAt: new Date().toISOString() }));
    this.onState();
  }
  logPath(id: string) { return path.join(this.store.directory, 'logs', `${id}.log`); }
  private appendLog(id: string, data: string) {
    if (this.logErrors.has(id)) return;
    try {
      const file = this.logPath(id);
      if (fs.existsSync(file) && fs.statSync(file).size > LOG_LIMIT) fs.renameSync(file, file + '.previous');
      fs.appendFileSync(file, data, { mode: 0o600 });
    } catch {
      this.logErrors.add(id);
      this.update(id, { error: '终端日志写入失败。会话仍在运行，请检查磁盘空间与权限。' });
    }
  }
  private emit(id: string, data: string) {
    let buffer = this.buffers.get(id);
    if (!buffer) { buffer = new TerminalBuffer(); this.buffers.set(id,buffer); }
    const chunk = buffer.push(id,data);
    this.appendLog(id,data);
    this.onData(chunk);
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
    if (this.activeCount >= this.store.state.settings.maxSessions) throw new Error(`已达到 ${this.store.state.settings.maxSessions} 个并发会话上限，请先停止一个会话。`);
    this.starting.add(id);
    try {
      if (!fs.statSync(session.cwd).isDirectory()) throw new Error('项目目录不存在。');
      let file: string; let args: string[];
      if (session.kind === 'claude') {
        if (!capabilities.available) throw new Error(capabilities.error || 'Claude Code 尚未就绪，请在设置中检测。');
        const cli = cliInvocation(this.store.state.settings);
        file = cli.file;
        args = [...cli.prefix, ...claudeArguments(session, capabilities, await transcriptExists(session.claudeId))];
      } else ({ file, args } = shellInvocation(this.store.state.settings));
      if (this.shuttingDown) throw new Error('工作台正在退出，已取消启动。');
      this.emit(id, '\r\n\x1b[90m── ' + (session.started ? '重新连接' : '启动会话') + ' · ' + new Date().toLocaleString() + ' ──\x1b[0m\r\n');
      const child = pty.spawn(file, args, { name: 'xterm-256color', cwd: session.cwd, env: environment(), cols: 100, rows: 30 });
      const entry: ProcessEntry = { process: child, ending: false };
      this.running.set(id, entry);
      child.onData(data => this.queue(id,data));
      child.onExit(({ exitCode }) => {
        this.flush(); this.running.delete(id);
        this.emit(id, `\r\n\x1b[90m── 会话进程已退出 · code ${exitCode} ──\x1b[0m\r\n`);
        this.update(id, { status: entry.ending || exitCode === 0 ? 'stopped' : 'error', exitCode,
          error: !entry.ending && exitCode !== 0 ? `Claude / Shell 退出码 ${exitCode}，请查看终端中的错误。` : undefined });
      });
      this.update(id, { started: true, status: 'running', error: undefined, exitCode: undefined });
    } catch (error) {
      this.update(id,{ status: 'error', error: String((error as Error).message).slice(0,1000) });
      throw error;
    } finally { this.starting.delete(id); }
  }
  write(id: string, data: string) {
    const entry = this.running.get(id);
    if (!entry || entry.ending) throw new Error('会话没有运行。请先启动或恢复。');
    entry.process.write(data);
  }
  resize(id: string, cols: number, rows: number) { this.running.get(id)?.process.resize(cols,rows); }
  interrupt(id: string) { this.write(id,'\x03'); }
  stop(id: string) {
    const entry = this.running.get(id);
    if (!entry || entry.ending) return;
    entry.ending = true;
    this.update(id,{ status: 'stopping' });
    if (process.platform === 'win32') {
      const killer = spawnProcess('taskkill', ['/PID',String(entry.process.pid),'/T','/F'], { windowsHide:true, stdio:'ignore' });
      killer.on('error', () => { try { entry.process.kill(); } catch { /* Process already exited. */ } });
    } else void this.stopPosixTree(entry);
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
      const buffer = new TerminalBuffer();
      const file = this.logPath(id);
      if (fs.existsSync(file)) {
        const fd = fs.openSync(file,'r');
        try {
          const size = fs.fstatSync(fd).size;
          const data = Buffer.alloc(Math.min(size,MEMORY_LIMIT));
          fs.readSync(fd,data,0,data.length,Math.max(0,size-data.length));
          buffer.push(id,data.toString('utf8'));
        } finally { fs.closeSync(fd); }
      }
      this.buffers.set(id,buffer);
    }
    return { status: session.status, chunks: [...this.buffers.get(id)!.chunks] };
  }
  async shutdown() {
    this.shuttingDown = true;
    for (const id of this.running.keys()) this.stop(id);
    const deadline = Date.now() + 3000;
    while (this.running.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve,50));
    for (const entry of this.running.values()) { try { entry.process.kill(); } catch { /* Exited. */ } }
    this.flush();
  }
}
