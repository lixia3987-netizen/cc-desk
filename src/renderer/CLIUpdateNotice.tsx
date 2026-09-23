import { ArrowUpCircle, Loader2, RefreshCw, X } from 'lucide-react';
import { cliUpdateBusy, type CLIUpdateState } from '../shared/cli-update';

export function CLIUpdateNotice({state, onCheck, onUpdate, onDismiss, disabled = false}: {
  state: CLIUpdateState; onCheck(): void; onUpdate(): void; onDismiss?(): void; disabled?: boolean;
}) {
  const pending = cliUpdateBusy(state) || state.phase === 'checking';
  return <section className={'cli-update-notice ' + state.phase} aria-label="Claude Code CLI 更新" aria-busy={pending}>
    <div className="cli-update-copy"><strong>{pending ? <Loader2 size={16} className="spin"/> : <ArrowUpCircle size={16}/>}Claude Code CLI 更新</strong>
      <p role="status">{state.message}</p>
      {!onDismiss && <small>{state.channel ? `更新通道：${state.channel} · ` : ''}每次启动自动检查；仅在确认后更新。{state.currentVersion && ` 当前版本：${state.currentVersion}`}</small>}
    </div>
    <div className="cli-update-actions">
      {state.phase === 'available' ? <button type="button" className="primary compact" disabled={disabled || pending} onClick={onUpdate}>更新 CLI…</button>
        : !cliUpdateBusy(state) && <button type="button" className="secondary compact" disabled={disabled || pending} onClick={onCheck}><RefreshCw size={14}/>{state.phase === 'error' ? '重新检查' : '检查更新'}</button>}
      {onDismiss && !pending && <button type="button" className="secondary compact" aria-label={state.phase === 'available' ? '暂不更新 CLI' : '关闭更新提示'} onClick={onDismiss}>{state.phase === 'available' ? '暂不更新' : <X size={15}/>}</button>}
    </div>
  </section>;
}
