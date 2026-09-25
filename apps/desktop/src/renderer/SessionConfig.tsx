import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import type { Session } from '../shared/types';
import type { ExecutionDescriptor } from '../shared/execution';
import { isSessionBusy } from '../shared/session-activity';
import { EngineConfigFields, configurationSupported } from './EngineConfiguration';

export function SessionConfig({ session, descriptor, onError }: { session: Session; descriptor?: ExecutionDescriptor; onError(error: unknown): void }) {
  const [value, setValue] = useState(session.engineConfig), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false);
  const persisted = JSON.stringify(session.engineConfig);
  useEffect(() => { setValue(session.engineConfig); setSaved(false); }, [session.id, persisted]);
  const running = session.status === 'running';
  const supported = configurationSupported(descriptor, session.engineConfig);
  const locked = busy || !supported || !!descriptor?.maintenance || isSessionBusy(session) || (running && (session.execution.mode !== 'structured' || !descriptor?.capabilities.liveConfig));
  const restarts = session.execution.providerId === 'claude' && running && value.options.permissionMode !== session.engineConfig.options.permissionMode &&
    (value.options.permissionMode === 'bypassPermissions' || session.engineConfig.options.permissionMode === 'bypassPermissions');
  return <form className="session-config" onSubmit={event => {
    event.preventDefault(); if (locked) return;
    setBusy(true); void window.desktop.updateSession({ id: session.id, engineConfig: value }).then(() => setSaved(true)).catch(onError).finally(() => setBusy(false));
  }}>
    <h4>运行配置</h4>
    {session.execution.providerId === 'claude' && session.observedPermissionMode && <p className="panel-note">{running ? 'CLI 当前权限' : '最近报告权限'}：{session.observedPermissionMode}</p>}
    {!supported ? <p className="panel-note">当前执行器无法编辑此配置，原始值已保留。</p> : <>
      <EngineConfigFields value={value} fields={descriptor?.configuration?.fields ?? []} prefix="会话" disabled={locked} running={running} onChange={next => { setValue(next); setSaved(false); }} />
      {restarts && <p className="panel-note">切换 Bypass 时会停止空闲 CLI，下次发送自动恢复原会话。</p>}
      <button className="secondary compact full" disabled={locked}><Check size={12} />{saved ? '已保存' : '保存配置'}</button>
      <p className="panel-note">{descriptor?.maintenance ? '引擎维护完成后可修改配置。' : locked ? '任务结束或停止会话后可修改。' : session.execution.mode === 'structured' ? '配置用于下一轮任务。' : '配置用于下一次启动终端。终端内部变更可能尚未同步。'}</p>
    </>}
  </form>;
}
