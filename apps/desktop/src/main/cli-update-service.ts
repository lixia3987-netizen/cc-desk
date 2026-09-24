import type { Capabilities } from '../shared/types';
import { cliUpdateBusy, type CLIUpdateState } from '../shared/cli-update';

export interface CLIUpdateCandidate {
  currentVersion: string;
  latestVersion: string;
  channel: 'latest' | 'stable';
  identity: string;
}
export interface CLIUpdateActions {
  check(): Promise<CLIUpdateCandidate>;
  confirm(candidate: CLIUpdateCandidate): Promise<boolean>;
  verify(candidate: CLIUpdateCandidate): Promise<void>;
  disconnect<T>(action: () => Promise<T>): Promise<T>;
  install(candidate: CLIUpdateCandidate): Promise<void>;
  refresh(): Promise<Capabilities>;
  changed(state: CLIUpdateState): void;
}

/** CLI versions are releases with an optional SemVer prerelease suffix. */
export function cliVersion(value: string): string {
  const version = value.trim().match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+[0-9A-Za-z.-]+)?(?=\s|$)/)?.[1];
  if (!version || version.length > 100) throw new Error('无法识别 Claude Code 版本号，请检查 CLI 安装后重试。');
  return version;
}
export function newerVersion(a: string, b: string): boolean {
  const [left, ...leftPre] = cliVersion(a).split('-'), [right, ...rightPre] = cliVersion(b).split('-');
  const x = left.split('.').map(BigInt), y = right.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  if (!leftPre.length || !rightPre.length) return !leftPre.length && !!rightPre.length;
  const xp = leftPre.join('-').split('.'), yp = rightPre.join('-').split('.');
  for (let i = 0; i < Math.max(xp.length, yp.length); i++) {
    if (xp[i] === yp[i]) continue;
    if (xp[i] === undefined || yp[i] === undefined) return yp[i] === undefined;
    const xn = /^\d+$/.test(xp[i]), yn = /^\d+$/.test(yp[i]);
    return xn && yn ? BigInt(xp[i]) > BigInt(yp[i]) : xn !== yn ? yn : xp[i] > yp[i];
  }
  return false;
}

export class CLIUpdateService {
  state: CLIUpdateState = { phase: 'idle', message: '每次启动时检查 Claude Code 更新。', showBanner: false };
  private candidate?: CLIUpdateCandidate;
  private epoch = 0;
  private checking?: Promise<CLIUpdateState>;
  constructor(private actions: CLIUpdateActions) {}
  get busy() { return cliUpdateBusy(this.state); }
  assertIdle() { if (this.busy) throw new Error('Claude Code 正在更新，请等待完成后再操作。'); }
  private publish(patch: Partial<CLIUpdateState>) { this.state = { ...this.state, ...patch }; this.actions.changed(this.state); }
  reset() {
    this.assertIdle(); this.epoch++; this.candidate = undefined; this.checking = undefined;
    this.state = { phase: 'idle', message: '等待检查 Claude Code 更新。', showBanner: false };
    this.actions.changed(this.state);
  }
  dismiss() { if (!this.busy) this.publish({ showBanner: false }); }
  check(): Promise<CLIUpdateState> {
    if (this.busy) return Promise.resolve(this.state);
    if (this.checking) return this.checking;
    const epoch = ++this.epoch;
    this.candidate = undefined;
    this.publish({ phase: 'checking', message: '正在检查 Claude Code 更新…', showBanner: false });
    const operation = (async () => {
      try {
        const candidate = await this.actions.check();
        if (epoch !== this.epoch) return this.state;
        this.candidate = candidate;
        const available = newerVersion(candidate.latestVersion, candidate.currentVersion);
        this.publish({ phase: available ? 'available' : 'current', currentVersion: candidate.currentVersion,
          latestVersion: candidate.latestVersion, channel: candidate.channel, checkedAt: new Date().toISOString(), showBanner: available,
          message: available ? `Claude Code ${candidate.latestVersion} 可更新（当前 ${candidate.currentVersion}）。` : '当前 Claude Code 已是所选通道的最新版本。' });
      } catch (error) {
        if (epoch === this.epoch) this.publish({ phase: 'error', message: error instanceof Error ? error.message : '检查更新失败，请稍后重试。', showBanner: false });
      } finally { if (epoch === this.epoch) this.checking = undefined; }
      return this.state;
    })();
    this.checking = operation;
    return operation;
  }
  async update(): Promise<CLIUpdateState> {
    this.assertIdle();
    const candidate = this.candidate;
    if (!candidate || this.state.phase !== 'available') throw new Error('请先检查更新，确认存在可用的新版本。');
    this.publish({ phase: 'confirming', message: '等待确认断开全部工作区…', showBanner: true });
    let disconnected = false;
    try {
      if (!await this.actions.confirm(candidate)) {
        this.publish({ phase: 'available', message: `已取消更新，当前继续使用 Claude Code ${candidate.currentVersion}。` });
        return this.state;
      }
      // A changed path or externally updated installation needs another check and confirmation.
      await this.actions.verify(candidate);
      this.publish({ phase: 'disconnecting', message: '正在停止全部工作区的会话、终端和工作流…' });
      await this.actions.disconnect(async () => {
        disconnected = true;
        await this.actions.verify(candidate);
        this.publish({ phase: 'updating', message: '工作区已断开，正在更新 Claude Code，请稍候…' });
        let capabilities: Capabilities;
        try { await this.actions.install(candidate); }
        finally { capabilities = await this.actions.refresh(); }
        if (!capabilities.available) throw new Error('更新命令已结束，但 CLI 检测失败。请检查安装和可执行路径后重新检测。');
        const installed = cliVersion(capabilities.version);
        if (newerVersion(candidate.latestVersion, installed)) throw new Error('更新命令已结束，但当前路径尚未达到目标版本。请检查 CLI 更新通道、安装权限；Homebrew / WinGet 等安装请通过对应包管理器更新，然后重新检测。');
        this.publish({ phase: 'updated', currentVersion: installed, message: `Claude Code 已更新至 ${installed}。工作区保持断开，可手动恢复会话。` });
      });
    } catch (error) {
      this.publish({ phase: 'error', message: (error instanceof Error ? error.message : '更新失败，请重新检查后重试。') + (disconnected ? ' 工作区保持断开，未自动重启任务。' : ''), showBanner: true });
    } finally { this.candidate = this.state.phase === 'available' ? candidate : undefined; }
    return this.state;
  }
}
