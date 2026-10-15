import type { Capabilities, Session, Settings } from '../shared/types';
import { automaticSessionTitlePatch, canAutomaticallyNameSession } from '../shared/session-title';
import type { StateStore } from './store';
import { generateClaudeSessionTitle, SessionTitleCleanupError } from './engines/claude/title-generator';

export interface SessionTitleRequest {
  session: Session;
  prompt: string;
  settings: Settings;
  capabilities?: Capabilities;
  signal: AbortSignal;
}
export type SessionTitleGenerator = (request: SessionTitleRequest) => Promise<string | undefined>;

/** 可选后台元数据任务，独立于用户会话和轮次结果。 */
export class SessionTitles {
  private cleanupFailures = new Set<string>();
  private jobs = new Map<string, { controller: AbortController; completion: Promise<void> }>();
  constructor(private store: StateStore, private onState: () => void, private generate: SessionTitleGenerator = generateClaudeSessionTitle) {}
  get ids() { return [...new Set([...this.jobs.keys(), ...this.cleanupFailures])]; }
  has(id: string) { return this.jobs.has(id) || this.cleanupFailures.has(id); }
  assertReleased(id?: string) {
    if (id ? this.cleanupFailures.has(id) : this.cleanupFailures.size) throw new SessionTitleCleanupError('无法确认会话命名进程已停止，请检查残留进程后重启工作台。');
  }
  request(id: string, prompt: string, capabilities?: Capabilities) {
    const session = this.store.state.sessions.find(item => item.id === id);
    if (!session || session.archived || !canAutomaticallyNameSession(session) || this.has(id)) return;
    const text = prompt.trim();
    if (!text || /^[!/][\w:.-]+(?:\s|$)/.test(text)) return;
    const controller = new AbortController();
    const job = { controller, completion: Promise.resolve() };
    this.jobs.set(id, job);
    // 在消息接收后入队。模型延迟和失败不能拖延前台轮次。
    job.completion = Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      const generated = await this.generate({ session: structuredClone(session), settings: this.store.state.settings,
        prompt: text, capabilities, signal: controller.signal });
      if (!generated || controller.signal.aborted) return;
      const current = this.store.state.sessions.find(item => item.id === id);
      if (!current || current.archived || current.cwd !== session.cwd) return;
      const patch = automaticSessionTitlePatch(current, generated);
      if (!patch) return;
      this.store.change(state => {
        const target = state.sessions.find(item => item.id === id);
        if (target && canAutomaticallyNameSession(target)) Object.assign(target, patch, { updatedAt: new Date().toISOString() });
      });
      this.onState();
    }).catch(error => {
      if (error instanceof SessionTitleCleanupError) this.cleanupFailures.add(id);
      // 认证、网络或协议错误时保留默认名称；后续消息可重试。
      // 尤其不能回退到复制或截断用户消息的方式。
    }).finally(() => { if (this.jobs.get(id) === job) this.jobs.delete(id); });
  }
  cancel(id: string): Promise<void> {
    const job = this.jobs.get(id);
    job?.controller.abort();
    return job?.completion ?? Promise.resolve();
  }
  async cancelAll() { await Promise.all(this.ids.map(id => this.cancel(id))); }
}
