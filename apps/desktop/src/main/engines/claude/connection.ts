import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { JsonLineDecoder, object, string, type WireObject } from '../../chat-protocol';
import { signalPosixGroup } from '../../posix-process-group';

interface ControlWaiter { resolve(value: WireObject): void; reject(error: Error): void; timer: NodeJS.Timeout }
interface ConnectionEvents {
  frame(value: WireObject): void;
  error(message: string): void;
  close(code: number | null, signal: NodeJS.Signals | null): void;
}
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Owns stdio framing, bounded control traffic and whole-process-tree termination. */
export class ClaudeConnection {
  readonly child: ChildProcessWithoutNullStreams;
  readonly controls = new Map<string, ControlWaiter>();
  readonly decoder: JsonLineDecoder;
  ending = false;
  stderr = '';
  killTimer?: NodeJS.Timeout;
  termination?: Promise<boolean>;
  constructor(invocation: { file: string; args: string[] }, cwd: string, env: NodeJS.ProcessEnv,
    private events: ConnectionEvents, private controlTimeoutMs = 15_000) {
    const child = this.child = spawn(invocation.file, invocation.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', shell: false });
    this.decoder = new JsonLineDecoder(value => events.frame(value));
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (this.ending) return; try { this.decoder.push(chunk); } catch (error) { events.error(messageOf(error)); } });
    child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-8000); });
    child.on('error', error => events.error(messageOf(error)));
    child.stdin.on('error', error => { if (!this.ending) events.error('CLI 输入连接已关闭：' + error.message); });
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

  terminate() {
    if (this.ending) return;
    this.ending = true;
    this.closeControls('会话进程已停止。');
    const signal = (value: NodeJS.Signals): Promise<boolean> => {
      if (!this.child.pid) return Promise.resolve(true);
      if (process.platform === 'win32') {
        return new Promise(resolve => {
          const killer = spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.once('close', code => resolve(code === 0));
          killer.once('error', () => { try { this.child.kill(value); } catch { /* Already exited. */ } resolve(false); });
        });
      }
      return signalPosixGroup(this.child.pid, value).then(() => true, () => {
        try { this.child.kill(value); } catch { /* Already exited. */ }
        return false;
      });
    };
    const first = signal('SIGTERM');
    // Keep Windows' root alive until taskkill has found the process tree. Closing
    // stdin first lets a healthy CLI exit before taskkill can find descendants.
    void first.then(() => this.child.stdin.destroy());
    // Keep escalation even if the CLI root exits before an ignoring descendant.
    this.termination = new Promise(resolve => {
      this.killTimer = setTimeout(() => { void signal('SIGKILL').then(async last => resolve(process.platform === 'win32' ? await first || last : last)); }, 1500);
      this.killTimer.unref();
    });
  }
}
