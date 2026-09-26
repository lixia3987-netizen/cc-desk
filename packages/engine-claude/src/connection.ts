import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { JsonLineDecoder, object, string, type WireObject } from './chat-protocol.js';

interface ControlWaiter { resolve(value: WireObject): void; reject(error: Error): void; timer: NodeJS.Timeout }
interface ConnectionEvents {
  frame(value: WireObject): void;
  error(message: string): void;
  close(code: number | null, signal: NodeJS.Signals | null): void;
}
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const execFileAsync = promisify(execFile);
async function waitForGroupRelease(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2000;
  do {
    try {
      if (process.platform === 'linux') {
        let live = false;
        const namespace = await readlink('/proc/self/ns/pid');
        const depth = (await readFile('/proc/self/status', 'utf8')).match(/^NSpid:\s+(.+)$/m)![1].trim().split(/\s+/).length;
        for (const name of await readdir('/proc')) {
          if (!/^\d+$/.test(name)) continue;
          try {
            const status = await readFile(`/proc/${name}/status`, 'utf8');
            if (status.match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/).length !== depth || /^State:\s+[ZX]/m.test(status)) continue;
            const namespaceGroup = status.match(/^NSpgid:\s+(.+)$/m)?.[1].trim().split(/\s+/).at(-1);
            if (!namespaceGroup) return false;
            if (Number(namespaceGroup) === pid && await readlink(`/proc/${name}/ns/pid`) === namespace) { live = true; break; }
          }
          catch (error) { if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) continue; throw error; }
        }
        if (!live) return true;
      } else {
      const result = await execFileAsync('ps', ['-eo', 'pgid=,stat='], { timeout: 1500, maxBuffer: 2 * 1024 * 1024 });
      if (!result.stdout.trim().split('\n').some(line => { const [group, state] = line.trim().split(/\s+/); return Number(group) === pid && state && !/^[ZX]/.test(state); })) return true;
      }
    } catch { return false; }
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return false;
}
async function stopWindowsTree(pid: number): Promise<boolean> {
  const executable = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // CIM parent links retain an exited root's PID. Capture the tree before stopping
  // it and verify those exact identities; an unavailable inspector fails closed.
  const script = `$ErrorActionPreference='Stop'; $ids=@([int]${pid}); $all=@(Get-CimInstance Win32_Process); do { $before=$ids.Count; foreach($p in $all) { if(($ids -contains [int]$p.ParentProcessId) -and ($ids -notcontains [int]$p.ProcessId)) { $ids+= [int]$p.ProcessId } } } while($ids.Count -ne $before); $targets=@($all | Where-Object { $ids -contains [int]$_.ProcessId }); foreach($p in $targets) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }; $deadline=(Get-Date).AddSeconds(3); do { $live=@(Get-CimInstance Win32_Process | Where-Object { $ids -contains [int]$_.ProcessId }); if($live.Count -eq 0) { exit 0 }; Start-Sleep -Milliseconds 25 } while((Get-Date) -lt $deadline); exit 1`;
  try { await execFileAsync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000, maxBuffer: 1024 }); return true; } catch { return false; }
}

/** Owns stdio framing, bounded control traffic and whole-process-tree termination. */
export class ClaudeConnection {
  readonly child: ChildProcessWithoutNullStreams;
  readonly controls = new Map<string, ControlWaiter>();
  readonly decoder: JsonLineDecoder;
  ending = false;
  stderr = '';
  killTimer?: NodeJS.Timeout;
  termination?: Promise<boolean>;
  private rootExited = false;
  constructor(invocation: { file: string; args: string[] }, cwd: string, env: NodeJS.ProcessEnv,
    private events: ConnectionEvents, private controlTimeoutMs = 15_000,
    private signalProcessGroup: (pid: number, signal: NodeJS.Signals) => Promise<void>) {
    const child = this.child = spawn(invocation.file, invocation.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', shell: false });
    this.decoder = new JsonLineDecoder(value => events.frame(value));
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (this.ending) return; try { this.decoder.push(chunk); } catch (error) { events.error(messageOf(error)); } });
    child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-8000); });
    child.on('error', error => events.error(messageOf(error)));
    child.stdin.on('error', error => { if (!this.ending && !this.rootExited) events.error('CLI 输入连接已关闭：' + error.message); });
    // close waits for inherited descendant pipes; start cleanup at root exit so
    // orphan tools cannot hold those pipes and the directory lease indefinitely.
    child.once('exit', () => { this.rootExited = true; this.terminate(true); });
    child.on('close', (code, signal) => events.close(code, signal));
  }
  receiveControl(frame: WireObject) {
    const response = object(frame.response); const requestId = string(response.request_id);
    const pending = this.controls.get(requestId); if (!pending) return;
    this.controls.delete(requestId); clearTimeout(pending.timer);
    if (response.subtype === 'error') pending.reject(new Error(string(response.error) || 'CLI 拒绝了控制请求。'));
    else if (response.subtype === 'success') pending.resolve(object(response.response));
    else pending.reject(new Error('CLI 控制响应格式不兼容。'));
  }
  closeControls(error: string) {
    for (const waiter of this.controls.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(error)); }
    this.controls.clear();
  }
  finish() { if (!this.ending) { try { this.decoder.finish(); } catch (error) { this.events.error(messageOf(error)); } } }
  write(value: WireObject) {
    if (this.ending || this.child.stdin.destroyed || !this.child.stdin.writable) throw new Error('CLI 输入连接已关闭。');
    // Only one user turn is outstanding; control traffic is bounded separately.
    if (this.child.stdin.writableLength > 24 * 1024 * 1024) throw new Error('CLI 输入队列已满。');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  control(request: WireObject, timeout = this.controlTimeoutMs ?? 15_000): Promise<WireObject> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.controls.delete(requestId); const error = new Error('CLI 控制请求超时：' + string(request.subtype)); error.name = 'ChatControlTimeoutError'; reject(error); }, timeout);
      this.controls.set(requestId, { resolve, reject, timer });
      try { this.write({ type: 'control_request', request_id: requestId, request }); }
      catch (error) { clearTimeout(timer); this.controls.delete(requestId); reject(error); }
    });
  }
  reply(requestId: string, response: WireObject, error?: string) {
    this.write({ type: 'control_response', response: error ? { subtype: 'error', request_id: requestId, error } : { subtype: 'success', request_id: requestId, response } });
  }

  terminate(preserveOutput = false) {
    if (!preserveOutput) { this.ending = true; this.closeControls('会话进程已停止。'); }
    if (this.termination) return;
    if (process.platform === 'win32') {
      // Windows Stop-Process is already forceful. Starting a second PowerShell
      // snapshot on the POSIX escalation timer duplicates expensive CIM work
      // and can make concurrent sessions exceed the physical release budget.
      this.termination = (this.child.pid ? stopWindowsTree(this.child.pid) : Promise.resolve(true)).then(stopped => {
        this.child.stdin.destroy();
        return stopped;
      });
      return;
    }
    const signal = (value: NodeJS.Signals): Promise<boolean> => {
      if (!this.child.pid) return Promise.resolve(true);
      return this.signalProcessGroup(this.child.pid, value).then(() => true, () => {
        try { this.child.kill(value); } catch { /* Already exited. */ }
        return false;
      });
    };
    const first = signal('SIGTERM');
    // Settle the initial signal attempt before closing the input endpoint.
    void first.then(() => this.child.stdin.destroy());
    // Keep escalation even if the CLI root exits before an ignoring descendant.
    this.termination = new Promise(resolve => {
      this.killTimer = setTimeout(() => { void signal('SIGKILL').then(async last => resolve(last && (!this.child.pid || await waitForGroupRelease(this.child.pid)))); }, 1500);
    });
  }
}
