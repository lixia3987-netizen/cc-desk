import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import type { Session, Settings } from '../shared/types';
import type { ExecutionDescriptor } from '../shared/execution';
import { isSessionBusy } from '../shared/session-activity';
import { resolveNativeRuntimeConfig } from '../shared/native-runtime-policy';
import { EngineConfigFields, configurationSupported, engineDefaults } from './EngineConfiguration';
import { NativeProjectSkills } from './components/NativeProjectSkills';
import { NativeMcpSelection } from './components/NativeMcpSelection';
import { NativeContextSettingsInfo } from './components/NativeContextSettingsInfo';
import { LegacyClaudeOverrides } from './components/LegacyClaudeOverrides';
import { engineFieldsForGroup, engineGroupTitles, type EngineSettingsGroup } from './settings-organization';

interface Props {
  session: Session; descriptor?: ExecutionDescriptor; onError(error: unknown): void;
  group?: EngineSettingsGroup; settings?: Settings;
}

function SessionConfigForSession({ session, descriptor, onError, group = 'context', settings }: Props) {
  const [value, setValue] = useState(session.engineConfig), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const persisted = JSON.stringify(session.engineConfig);
  useEffect(() => { setValue(session.engineConfig); setSaved(false); }, [session.id, persisted, group]);
  const running = session.status === 'running';
  const supported = configurationSupported(descriptor, session.engineConfig);
  const native = session.execution.providerId === 'native';
  const policyGroup = native && ['context', 'compaction', 'limits', 'recovery'].includes(group);
  const followsDefaults = policyGroup && value.options.runtimePolicy === 'defaults';
  const effective = native ? resolveNativeRuntimeConfig(value, engineDefaults(descriptor, settings)) : value;
  const fields = engineFieldsForGroup(descriptor, group, effective);
  const projectSkills = value.options.projectSkills;
  const validProjectSkills = projectSkills === undefined || Array.isArray(projectSkills) && projectSkills.every(path => typeof path === 'string');
  const mcpConnections = value.options.mcpConnections;
  const validMcpConnections = mcpConnections === undefined || Array.isArray(mcpConnections) && mcpConnections.every(id => typeof id === 'string');
  const locked = busy || !supported || !!descriptor?.maintenance || isSessionBusy(session) || (running && (session.execution.mode !== 'structured' || !descriptor?.capabilities.liveConfig));
  const bindingLocked = native && group === 'model' && session.started;
  const restarts = session.execution.providerId === 'claude' && running && value.options.permissionMode !== session.engineConfig.options.permissionMode &&
    (value.options.permissionMode === 'bypassPermissions' || session.engineConfig.options.permissionMode === 'bypassPermissions');
  const dirty = JSON.stringify(value) !== persisted;
  const save = () => {
    if (locked) return;
    setBusy(true); void window.desktop.updateSession({ id: session.id, engineConfig: value }).then(() => { if (mounted.current) setSaved(true); }).catch(error => { if (mounted.current) onError(error); }).finally(() => { if (mounted.current) setBusy(false); });
  };
  return <section className="session-config" aria-label={engineGroupTitles[group]} onKeyDown={event => {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault();
  }}>
    <h4>{engineGroupTitles[group]}</h4>
    <p className="panel-note">{session.title}</p>
    {session.execution.providerId === 'claude' && session.observedPermissionMode && <p className="panel-note">{running ? 'CLI 当前权限' : '最近报告权限'}：{session.observedPermissionMode}</p>}
    {!supported ? <p className="panel-note">当前执行器无法编辑此配置，原始值已保留。</p> : <>
      {policyGroup && <label>会话配置来源<select aria-label="会话配置来源" value={followsDefaults ? 'defaults' : 'custom'} disabled={locked} onChange={event => {
        const source = event.target.value;
        setValue(current => source === 'custom' ? { ...effective, options: { ...effective.options, runtimePolicy: 'custom' } }
          : { ...current, options: { ...current.options, runtimePolicy: 'defaults' } }); setSaved(false);
      }}><option value="defaults">跟随默认</option><option value="custom">单独设置</option></select></label>}
      {followsDefaults && <p className="panel-note">运行策略跟随已保存的设置。选择“单独设置”后可为此会话调整上下文、压缩和运行限制。</p>}
      {native && group === 'context' && <NativeContextSettingsInfo config={effective}/>}
      <EngineConfigFields value={effective} fields={fields} prefix="会话" disabled={locked || followsDefaults || bindingLocked} running={running} onChange={next => { setValue(next); setSaved(false); }} />
      {group === 'context' && effective.options.inputBudgetMode === 'model' && <p className="panel-note">窗口未知时备用输入预算：{Number(effective.options.maxInputTokens ?? 64000).toLocaleString()} tokens。</p>}
      {bindingLocked && <p className="panel-note">已有模型上下文，请新建会话切换模型连接或模型。</p>}
      {session.execution.providerId === 'claude' && group === 'permissions' && <><LegacyClaudeOverrides config={value} disabled={locked || running || session.status === 'stopping'} onChange={next => { setValue(next); setSaved(false); }}/><p className="panel-note">清除旧模型与强度覆盖需要先停止会话。</p></>}
      {group === 'tools' && native && session.execution.mode === 'structured' && (validProjectSkills
        ? <NativeProjectSkills sessionId={session.id} selected={(projectSkills ?? []) as string[]} disabled={locked} onChange={paths => {
          setValue(current => ({ ...current, options: { ...current.options, projectSkills: paths } })); setSaved(false);
        }} /> : <p className="panel-note">当前项目 Skills 配置无法编辑，原始值已保留。</p>)}
      {group === 'tools' && native && session.execution.mode === 'structured' && (validMcpConnections
        ? <NativeMcpSelection sessionId={session.id} selected={(mcpConnections ?? []) as string[]} disabled={locked || running} onChange={ids => {
          setValue(current => ({ ...current, options: { ...current.options, mcpConnections: ids } })); setSaved(false);
        }} /> : <p className="panel-note">当前 MCP 连接配置无法编辑，原始值已保留。</p>)}
      {!fields.length && group !== 'tools' && <p className="panel-note">此执行引擎没有本页可编辑的配置。</p>}
      {restarts && <p className="panel-note">切换 Bypass 时会停止空闲 CLI，下次发送自动恢复原会话。</p>}
      {(fields.length > 0 || group === 'tools' && native) && <button type="button" className="secondary compact full" disabled={locked || !dirty} onClick={save}><Check size={12} />{saved ? '已保存' : '保存配置'}</button>}
      {dirty && <p className="panel-note">会话修改尚未保存；切换页面或关闭设置会放弃这些修改。</p>}
      <p className="panel-note">{descriptor?.maintenance ? '引擎维护完成后可修改配置。' : locked ? '任务结束或停止会话后可修改。' : session.execution.mode === 'structured' ? '已保存配置用于下一轮任务。' : '配置用于下一次启动终端。终端内部变更可能尚未同步。'}</p>
    </>}
  </section>;
}

export function SessionConfig(props: Props) {
  return <SessionConfigForSession key={`${props.session.id}:${props.group ?? 'context'}`} {...props} />;
}
