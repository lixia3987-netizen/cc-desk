import type { EngineConfig, ExecutionCapabilities, ExecutionDescriptor, ExecutionMode } from '../../shared/execution';
import { engineConfigSchema } from '../../shared/schema';
import type { Session } from '../../shared/types';
import { ExecutionEvents } from './events';
import type { ExecutionLifecycle, ExecutionRegistration, StructuredExecutor, TerminalExecutor } from './ports';

type Feature = Exclude<keyof ExecutionCapabilities, 'available' | 'error'>;
const key = (providerId: string, mode: string) => JSON.stringify([providerId, mode]);

/** The composition root registers adapters; orchestration only knows this boundary. */
export class ExecutionRegistry {
  private registrations = new Map<string, ExecutionRegistration>();
  private maintenance = new Set<string>();
  private maintenanceDrivers = new Map<string, { executor: ExecutionLifecycle; shared: boolean; ids: string[] }[]>();
  readonly events = new ExecutionEvents();
  constructor(readonly getSession: (id: string) => Session) {}
  register(registration: ExecutionRegistration) {
    const id = key(registration.providerId, registration.mode);
    if (this.registrations.has(id)) throw new Error(`执行器已注册：${id}`);
    this.registrations.set(id, registration);
  }
  descriptors(): ExecutionDescriptor[] {
    return [...this.registrations.values()].map(({ providerId, mode, capabilities, displayName, configuration, history }) => ({
      providerId, mode, displayName: displayName ?? providerId, capabilities: capabilities(),
      configuration: configuration?.(), history: history ?? false, maintenance: this.maintenance.has(providerId),
    }));
  }
  registration(session: Session) {
    const registration = this.registrations.get(key(session.execution.providerId, session.execution.mode));
    if (!registration) throw new Error(`未安装会话执行器：${session.execution.providerId} / ${session.execution.mode}。`);
    return registration;
  }
  validateSession(session: Session) {
    const registration = this.registration(session);
    this.normalizeConfig(registration, session.engineConfig);
    registration.validateSession?.(session);
  }
  private normalizeConfig(registration: ExecutionRegistration, input: EngineConfig): EngineConfig {
    const config = engineConfigSchema.parse(input);
    const declared = registration.configuration?.();
    if (config.schemaVersion === 0 || (declared && declared.schemaVersion !== config.schemaVersion)) throw new Error('此引擎配置版本不受支持，原配置已保留。');
    return structuredClone(registration.validateConfig ? registration.validateConfig(config) : config);
  }
  validateConfig(id: string, config: EngineConfig) {
    const session = this.getSession(id);
    this.assertEngineAvailable(session.execution.providerId);
    return this.normalizeConfig(this.registration(session), config);
  }
  defaultConfig(providerId: string, mode: ExecutionMode, configured?: EngineConfig): EngineConfig {
    const registration = this.registrations.get(key(providerId, mode));
    if (!registration) throw new Error(`未安装会话执行器：${providerId} / ${mode}。`);
    return this.normalizeConfig(registration, configured ?? registration.configuration?.().defaults ?? { schemaVersion: 1, options: {} });
  }
  configurationError(id: string): string | undefined {
    try { this.validateSession(this.getSession(id)); return undefined; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }
  assertEngineAvailable(providerId: string) {
    if (this.maintenance.has(providerId)) throw new Error(`${providerId} 引擎正在维护，请等待完成。`);
  }
  defaultWorkflowError(id: string) {
    const session = this.getSession(id);
    this.validateSession(session);
    return this.registration(session).defaultWorkflowError?.(session);
  }
  createIdentity(providerId: string, mode: 'structured' | 'terminal', input: { conversationId?: string; fork?: boolean }) {
    this.assertEngineAvailable(providerId);
    const registration = this.registrations.get(key(providerId, mode));
    if (!registration?.createIdentity) throw new Error(`此执行器不支持创建会话：${providerId} / ${mode}。`);
    const capabilities = registration.capabilities();
    if (input.fork && !capabilities.fork) throw new Error('此会话执行器不支持 fork。');
    if (input.conversationId && !input.fork && !capabilities.resume) throw new Error('此会话执行器不支持 resume。');
    const identity = registration.createIdentity(input);
    if (identity.providerId !== providerId || identity.mode !== mode) throw new Error('执行器返回的会话身份与所选提供方或模式不匹配。');
    return identity;
  }
  require(id: string, feature: Feature, ready = true) {
    const session = this.getSession(id);
    this.assertEngineAvailable(session.execution.providerId);
    this.validateSession(session);
    const capabilities = this.registration(session).capabilities();
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
  private engineDrivers(providerId: string, ids: readonly string[]) {
    const registrations = [...this.registrations.values()];
    return [...new Set(registrations.filter(item => item.providerId === providerId).map(item => item.executor))].map(executor => ({
      executor,
      shared: registrations.some(item => item.executor === executor && item.providerId !== providerId),
      ids: ids.filter(id => {
        const session = this.getSession(id);
        return session.execution.providerId === providerId && this.registration(session).executor === executor;
      }),
    }));
  }
  setEngineMaintenance(providerId: string, ids: readonly string[], value: boolean) {
    // Establish the admission fence before invoking any driver that may fail.
    if (value) this.maintenance.add(providerId);
    const errors: unknown[] = [];
    try {
      const drivers = value ? this.engineDrivers(providerId, ids) : this.maintenanceDrivers.get(providerId) ?? [];
      if (value) this.maintenanceDrivers.set(providerId, drivers);
      for (const item of drivers) {
        try {
          if (item.executor.setSessionMaintenance) item.executor.setSessionMaintenance(item.ids, value);
          else if (!item.shared) item.executor.setMaintenance(value);
          else throw new Error('共享执行器不支持按会话维护，已取消操作。');
        } catch (error) { errors.push(error); }
      }
    } finally {
      // An already admitted deletion may remove a session while draining. Its
      // original driver still must be unfenced without re-reading that session.
      if (!value) { this.maintenance.delete(providerId); this.maintenanceDrivers.delete(providerId); }
    }
    if (errors.length) throw new AggregateError(errors, '无法切换引擎维护状态。');
  }
  async disconnectEngine(providerId: string, ids: readonly string[]) {
    if (!this.maintenance.has(providerId)) throw new Error('断开引擎前必须暂停新任务。');
    const results = await Promise.allSettled((this.maintenanceDrivers.get(providerId) ?? this.engineDrivers(providerId, ids)).map(async item => {
      if (item.executor.disconnectSessions) await item.executor.disconnectSessions(item.ids);
      else if (!item.shared) await item.executor.disconnectAll();
      else throw new Error('共享执行器不支持按会话断开，已取消操作。');
    }));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, '引擎资源未完全释放，已取消更新。');
  }
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
