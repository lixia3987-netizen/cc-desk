import type { ExecutionCapabilities, ExecutionDescriptor } from '../../shared/execution';
import type { Session } from '../../shared/types';
import { ExecutionEvents } from './events';
import type { ExecutionLifecycle, ExecutionRegistration, StructuredExecutor, TerminalExecutor } from './ports';

type Feature = Exclude<keyof ExecutionCapabilities, 'available' | 'error'>;
const key = (providerId: string, mode: string) => JSON.stringify([providerId, mode]);

/** The composition root registers adapters; orchestration only knows this boundary. */
export class ExecutionRegistry {
  private registrations = new Map<string, ExecutionRegistration>();
  readonly events = new ExecutionEvents();
  constructor(readonly getSession: (id: string) => Session) {}
  register(registration: ExecutionRegistration) {
    const id = key(registration.providerId, registration.mode);
    if (this.registrations.has(id)) throw new Error(`执行器已注册：${id}`);
    this.registrations.set(id, registration);
  }
  descriptors(): ExecutionDescriptor[] {
    return [...this.registrations.values()].map(({ providerId, mode, capabilities }) => ({ providerId, mode, capabilities: capabilities() }));
  }
  registration(session: Session) {
    const registration = this.registrations.get(key(session.execution.providerId, session.execution.mode));
    if (!registration) throw new Error(`未安装会话执行器：${session.execution.providerId} / ${session.execution.mode}。`);
    return registration;
  }
  validateSession(session: Session) { this.registration(session).validateSession?.(session); }
  createIdentity(providerId: string, mode: 'structured' | 'terminal', input: { conversationId?: string; fork?: boolean }) {
    const registration = this.registrations.get(key(providerId, mode));
    if (!registration?.createIdentity) throw new Error(`此执行器不支持创建会话：${providerId} / ${mode}。`);
    const identity = registration.createIdentity(input);
    if (identity.providerId !== providerId || identity.mode !== mode) throw new Error('执行器返回的会话身份与所选提供方或模式不匹配。');
    return identity;
  }
  require(id: string, feature: Feature, ready = true) {
    const capabilities = this.registration(this.getSession(id)).capabilities();
    if (ready && !capabilities.available) throw new Error(capabilities.error || '会话执行器尚未就绪。');
    if (!capabilities[feature]) throw new Error(`此会话执行器不支持 ${feature}。`);
  }
  structured(id: string): StructuredExecutor {
    const registration = this.registration(this.getSession(id));
    if (registration.mode !== 'structured') throw new Error('此功能需要图形化会话。');
    return registration.executor;
  }
  terminal(id: string): TerminalExecutor {
    const registration = this.registration(this.getSession(id));
    if (registration.mode !== 'terminal') throw new Error('此功能需要终端会话。');
    return registration.executor;
  }
  executors(mode?: 'structured' | 'terminal'): ExecutionLifecycle[] {
    // Claude and Shell may share one physical PTY runtime. Never disconnect it twice.
    return [...new Set([...this.registrations.values()].filter(item => !mode || item.mode === mode).map(item => item.executor))];
  }
  get activeCount() { return this.executors().reduce((count, executor) => count + executor.activeCount, 0); }
  has(id: string) { return this.executors().some(executor => executor.has(id)); }
  setMaintenance(value: boolean) {
    const errors: unknown[] = [];
    for (const executor of this.executors()) {
      try { executor.setMaintenance(value); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, '无法切换全部执行器的维护状态。');
  }
  async disconnectAll() { await this.all(executor => executor.disconnectAll()); }
  async shutdown() { await this.all(executor => executor.shutdown()); }
  private async all(action: (executor: ExecutionLifecycle) => Promise<void>) {
    const results = await Promise.allSettled(this.executors().map(executor => Promise.resolve().then(() => action(executor))));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('\n'));
  }
}
