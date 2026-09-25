import type { Runtime } from '../runtime';
import type { SessionExport, TerminalExecutor } from './ports';

/** One PTY owner can serve multiple providers without duplicating lifecycle calls. */
export class PtyExecutor implements TerminalExecutor {
  constructor(private runtime: Runtime, private exportSources: (id: string) => Promise<SessionExport[]>) {}
  get activeCount() { return this.runtime.activeCount; }
  has(id: string) { return this.runtime.has(id); }
  isBusy(id: string) { return this.runtime.has(id); }
  start(id: string) { return this.runtime.start(id); }
  write(id: string, data: string) { this.runtime.write(id, data); }
  resize(id: string, cols: number, rows: number) { this.runtime.resize(id, cols, rows); }
  snapshot(id: string) { return this.runtime.snapshot(id); }
  interrupt(id: string) { this.runtime.interrupt(id); }
  stop(id: string) { return this.runtime.stop(id); }
  async stopIdle(id: string) { if (this.has(id)) throw new Error('请先关闭终端释放工作目录。'); }
  forget(id: string) { this.runtime.forget(id, { deleteLogs: true }); }
  exports(id: string) { return this.exportSources(id); }
  setMaintenance(value: boolean) { this.runtime.setMaintenance(value); }
  setSessionMaintenance(ids: readonly string[], value: boolean) { this.runtime.setSessionMaintenance(ids, value); }
  disconnectSessions(ids: readonly string[]) { return this.runtime.disconnectSessions(ids); }
  disconnectAll() { return this.runtime.disconnectAll(); }
  shutdown() { return this.runtime.shutdown(); }
}
