import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { Check } from 'lucide-react';
import type { Session, Settings } from '../shared/types';
import type { ExecutionDescriptor } from '../shared/execution';
import { isSessionBusy } from '../shared/session-activity';
import { nativeSubagentPolicyKeys, resolveNativeRuntimeConfig } from '../shared/native-runtime-policy';
import { EngineConfigFields, configurationSupported, engineDefaults } from './EngineConfiguration';
import { NativeProjectSkills } from './components/NativeProjectSkills';
import { NativeSessionSkills } from './components/NativeSessionSkills';
import { NativeMcpSelection } from './components/NativeMcpSelection';
import { NativeContextSettingsInfo } from './components/NativeContextSettingsInfo';
import { LegacyClaudeOverrides } from './components/LegacyClaudeOverrides';
import { engineFieldsForGroup, engineGroupTitles, type EngineSettingsGroup } from './settings-organization';
import { SessionConfigDraftStore } from './session-config-drafts';

export { SessionConfigDraftStore } from './session-config-drafts';

interface Props {
  session: Session; descriptor?: ExecutionDescriptor; onError(error: unknown): void;
  group?: EngineSettingsGroup; settings?: Settings;
  draftStore?: SessionConfigDraftStore; onDirtyChange?(dirty: boolean): void;
}

function SessionConfigForSession({ session, descriptor, onError, group = 'context', settings, draftStore, onDirtyChange }: Props) {
  const localStore = useMemo(() => new SessionConfigDraftStore(), []);
  const store = draftStore ?? localStore;
  useSyncExternalStore(store.subscribe, store.getRevision, store.getRevision);
  const draft = store.get(session.id);
  const value = draft?.value ?? session.engineConfig;
  const busy = draft?.busy ?? false, saved = draft?.saved ?? false, dirty = draft?.dirty ?? false, conflict = draft?.conflict ?? false;
  const skillsDraft = store.nativeSkills.get(session.id), skillsSaving = skillsDraft?.saving ?? false;
  const setValue = (next: typeof value | ((current: typeof value) => typeof value)) => {
    store.change(session.id, typeof next === 'function' ? next(store.get(session.id)?.value ?? value) : next);
  };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const persisted = JSON.stringify(session.engineConfig);
  useEffect(() => { store.observe(session.id, session.engineConfig); }, [store, session.id, persisted]);
  const skillsDirty = !!skillsDraft?.dirty || !!skillsDraft?.attempt || skillsSaving;
  useEffect(() => { onDirtyChange?.(dirty || skillsDirty); }, [onDirtyChange, dirty, skillsDirty]);
  const running = session.status === 'running';
  const supported = configurationSupported(descriptor, session.engineConfig);
  const native = session.execution.providerId === 'native';
  const policyGroup = native && ['context', 'compaction', 'limits', 'recovery'].includes(group);
  const followsDefaults = policyGroup && value.options.runtimePolicy === 'defaults';
  const nativeSubagentDefaults = Object.fromEntries(nativeSubagentPolicyKeys.flatMap(key => {
    const fallback = configurationSupported(descriptor, value) ? descriptor?.configuration?.defaults.options[key] : undefined;
    return fallback === undefined ? [] : [[key, fallback]];
  }));
  const effective = native ? resolveNativeRuntimeConfig({ ...value, options: { permissionMode: 'default', ...nativeSubagentDefaults, ...value.options } }, engineDefaults(descriptor, settings)) : value;
  const savedEffective = native ? resolveNativeRuntimeConfig({ ...session.engineConfig, options: { ...nativeSubagentDefaults, ...session.engineConfig.options } }, engineDefaults(descriptor, settings)) : session.engineConfig;
  const fields = engineFieldsForGroup(descriptor, group, effective);
  const projectSkills = value.options.projectSkills;
  const validProjectSkills = projectSkills === undefined || Array.isArray(projectSkills) && projectSkills.every(path => typeof path === 'string');
  const mcpConnections = value.options.mcpConnections;
  const validMcpConnections = mcpConnections === undefined || Array.isArray(mcpConnections) && mcpConnections.every(id => typeof id === 'string');
  const settingsLocked = busy || !supported || !!descriptor?.maintenance || isSessionBusy(session) || (running && (session.execution.mode !== 'structured' || !descriptor?.capabilities.liveConfig));
  const locked = settingsLocked || skillsSaving;
  const bindingLocked = native && group === 'model' && session.started;
  const restarts = session.execution.providerId === 'claude' && running && value.options.permissionMode !== session.engineConfig.options.permissionMode &&
    (value.options.permissionMode === 'bypassPermissions' || session.engineConfig.options.permissionMode === 'bypassPermissions');
  const save = () => {
    if (locked || conflict) return;
    void store.save(session.id, config => window.desktop.updateSession({ id: session.id, engineConfig: config })).catch(error => { if (mounted.current) onError(error); });
  };
  return <section className="session-config" aria-label={engineGroupTitles[group]} onKeyDown={event => {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault();
  }}>
    <h4>{engineGroupTitles[group]}</h4>
    <p className="panel-note">{session.title}</p>
    {session.execution.providerId === 'claude' && session.observedPermissionMode && <p className="panel-note">{running ? 'CLI 当前权限' : '最近报告权限'}：{session.observedPermissionMode}</p>}
    {conflict && <div role="alert" className="panel-note"><p>此会话的已保存配置发生变化，当前草稿已保留。请先选择如何处理，再保存。</p>
      <button type="button" className="secondary compact" disabled={busy} onClick={() => store.discard(session.id)}>读取已保存配置</button>
      {value.schemaVersion === draft?.persisted.schemaVersion && <button type="button" className="secondary compact" disabled={busy} onClick={() => store.keepChanges(session.id)}>保留我的修改</button>}
      <p>保留修改会将草稿修改应用到最新配置；同一字段有冲突时使用草稿值。</p>
    </div>}
    {dirty && <p className="panel-note" role="status">会话修改尚未保存；切换分类或作用范围会保留草稿。保存配置会应用此会话在各分类中的全部修改。</p>}
    {dirty && !conflict && <button type="button" className="secondary compact" disabled={busy} onClick={() => store.discard(session.id)}>放弃会话草稿</button>}
    {!supported ? <p className="panel-note">当前执行器无法编辑此配置，原始值已保留。</p> : <>
      {policyGroup && <label>会话运行策略来源<select aria-label="会话运行策略来源" value={followsDefaults ? 'defaults' : 'custom'} disabled={locked || conflict} onChange={event => {
        const source = event.target.value;
        setValue(current => source === 'custom' ? { ...effective, options: { ...effective.options, runtimePolicy: 'custom' } }
          : { ...current, options: { ...current.options, runtimePolicy: 'defaults' } });
      }}><option value="defaults">跟随默认</option><option value="custom">单独设置</option></select></label>}
      {policyGroup && <p className="panel-note">此来源统一控制上下文预算、自动压缩、失败重试及子 Agent 预算与并发上限。{followsDefaults ? '当前跟随已保存的默认策略；选择“单独设置”会复制整套当前策略，再为此会话调整。' : '当前使用此会话单独保存的整套策略；切换来源会同时影响以上配置。'}</p>}
      {native && group === 'context' && <NativeContextSettingsInfo config={effective}/>}
      {native && group === 'limits' && <>
        <p className="panel-note">此会话下轮并发上限（已保存）：{Number.isInteger(savedEffective.options.maxSubagents) ? String(savedEffective.options.maxSubagents) : '未记录'} · 来源：{session.engineConfig.options.runtimePolicy === 'defaults' ? '跟随默认' : '此会话单独设置'}。</p>
        {dirty && <p className="panel-note">草稿并发上限：{Number.isInteger(effective.options.maxSubagents) ? String(effective.options.maxSubagents) : '未记录'}，保存后用于下一轮。本轮有效值请查看聊天区“子 Agent”。</p>}
        {!followsDefaults && <button type="button" className="secondary compact" disabled={locked || dirty || conflict} onClick={() => setValue(current => ({ ...current, options: { ...current.options, runtimePolicy: 'defaults' } }))}>改为跟随默认（保存后生效）</button>}
        <p className="panel-note">全局修改只影响跟随默认的会话；旧会话单独设置会继续保留。切换来源同时影响整套运行策略，请检查后保存。本轮配置在开始时固定。</p>
        <p className="panel-note">主 Agent 不限制执行时长、模型请求次数和工具调用次数。以下预算分别用于每个子 Agent，子任务之间不累计共享。并发上限不要求启动相同数量的子 Agent。</p>
      </>}
      <EngineConfigFields value={effective} fields={fields} prefix="会话" disabled={locked || followsDefaults || bindingLocked} running={running} onChange={setValue} />
      {group === 'context' && effective.options.inputBudgetMode === 'model' && <p className="panel-note">窗口未知时备用输入预算：{Number(effective.options.maxInputTokens ?? 64000).toLocaleString()} tokens。</p>}
      {bindingLocked && <p className="panel-note">已有模型上下文，请新建会话切换模型连接或模型。</p>}
      {session.execution.providerId === 'claude' && group === 'permissions' && <><LegacyClaudeOverrides config={value} disabled={locked || running || session.status === 'stopping'} onChange={setValue}/><p className="panel-note">清除旧模型与强度覆盖需要先停止会话。</p></>}
      {group === 'tools' && native && session.execution.mode === 'structured' && session.engineConfig.schemaVersion === 1 && (validProjectSkills
        ? <NativeProjectSkills sessionId={session.id} selected={(projectSkills ?? []) as string[]} disabled={locked} onChange={paths => {
          setValue(current => ({ ...current, options: { ...current.options, projectSkills: paths } }));
        }} /> : <p className="panel-note">当前项目 Skills 配置无法编辑，原始值已保留。</p>)}
      {group === 'tools' && native && session.execution.mode === 'structured' && validProjectSkills && <NativeSessionSkills session={session}
        store={store.nativeSkills} disabled={settingsLocked} parentDirty={dirty || conflict}
        canEdit={() => { const current = store.get(session.id); return !current?.dirty && !current?.busy && !current?.conflict; }}
        onSaved={config => store.observe(session.id, config)} />}
      {group === 'tools' && native && session.execution.mode === 'structured' && (validMcpConnections
        ? <NativeMcpSelection sessionId={session.id} selected={(mcpConnections ?? []) as string[]} disabled={locked || running} onChange={ids => {
          setValue(current => ({ ...current, options: { ...current.options, mcpConnections: ids } }));
        }} /> : <p className="panel-note">当前 MCP 连接配置无法编辑，原始值已保留。</p>)}
      {!fields.length && group !== 'tools' && <p className="panel-note">此执行引擎没有本页可编辑的配置。</p>}
      {restarts && <p className="panel-note">切换 Bypass 时会停止空闲 CLI，下次发送自动恢复原会话。</p>}
      {(fields.length > 0 || group === 'tools' && native) && <button type="button" className="secondary compact full" disabled={locked || !dirty || conflict} onClick={save}><Check size={12} />{busy ? '正在保存…' : saved ? '已保存' : '保存配置'}</button>}
      <p className="panel-note">{descriptor?.maintenance ? '引擎维护完成后可修改配置。' : skillsSaving ? '技能配置正在保存，请稍候。' : locked ? '任务结束或停止会话后可修改。' : session.execution.mode === 'structured' ? '已保存配置用于下一轮任务。' : '配置用于下一次启动终端。终端内部变更可能尚未同步。'}</p>
    </>}
  </section>;
}

export function SessionConfig(props: Props) {
  return <SessionConfigForSession key={props.session.id} {...props} />;
}
