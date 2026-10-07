import { Activity } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AppState, Session, Settings } from '../../shared/types';
import type { ChatSnapshot } from '../../shared/chat';
import type { ExecutionCapabilities, ExecutionDescriptor } from '../../shared/execution';
import { resolveNativeRuntimeConfig } from '../../shared/native-runtime-policy';
import { engineDefaults } from '../EngineConfiguration';
import { ModelCapabilityInfo } from '../components/ModelCapabilityInfo';
import { ChatSnapshotSync } from '../chat-snapshot-sync';
import { sessionReadLifecycle } from '../session-read-lifecycle';
import { time } from './presentation';
import type { OpenNew, Perform, ReportError } from './types';

export interface SessionContextPanelProps {
  executionCapabilities?: ExecutionCapabilities;
  descriptor?: ExecutionDescriptor; unavailable?: string; readOnly: boolean;
  active: Session; project?: AppState['projects'][number]; structured: boolean;
  activeBusy: boolean; busy: boolean; perform: Perform; report: ReportError;
  setNotice: (value: string) => void; openNew: OpenNew; selectSession: (id: string) => void;
  flushDrafts: () => void;
  settings: Settings; onOpenSessionSettings: () => void;
}

export function SessionContextPanel({ active, project, structured, descriptor, readOnly, settings, onOpenSessionSettings }: SessionContextPanelProps) {
  const [snapshot, setSnapshot] = useState<ChatSnapshot>();
  const [loadError, setLoadError] = useState<string>();
  useEffect(() => {
    setSnapshot(undefined); setLoadError(undefined);
    if (!structured || active.kind !== 'agent' || !descriptor?.capabilities.contextUsage) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sync = new ChatSnapshotSync(active.id, {
      read: () => sessionReadLifecycle.read(active.id, () => window.desktop.chatSnapshot(active.id)),
      apply: setSnapshot, state: state => setLoadError(state.error),
    });
    const resume = sessionReadLifecycle.subscribe(active.id, () => { void sync.refresh(); });
    const off = window.desktop.onChat((id, _task, version) => {
      if (id === active.id && sync.notify(version) && sync.canAutoRefresh && !timer) timer = setTimeout(() => { timer = undefined; if (sync.canAutoRefresh) void sync.refresh(); }, 80);
    });
    void sync.refresh();
    return () => { clearTimeout(timer); off(); resume(); sync.dispose(); };
  }, [active.id, active.kind, structured, descriptor?.capabilities.contextUsage]);
  const native = active.execution.providerId === 'native';
  const policy = native ? resolveNativeRuntimeConfig(active.engineConfig, engineDefaults(descriptor, settings)) : active.engineConfig;
  const budget = snapshot?.context?.budget;
  const compactMode = policy.options.autoCompact;
  return <div className="panel-content">
    <div className="section-label">会话上下文<Activity size={14} /></div>
    <div className="detail-block">
      <label>项目</label><strong>{project?.name ?? '原项目已移除'}</strong>
      <label>工作目录</label><strong>{active.cwd}</strong>
      <label>运行方式</label><strong>{descriptor?.displayName ?? active.execution.providerId} · {structured ? '结构化对话' : '终端'}</strong>
      <label>创建时间</label><strong>{time(active.createdAt)}</strong>
      {active.kind === 'agent' && <><label>{descriptor?.displayName ?? active.execution.providerId} 会话 ID{active.identityPending ? ' · 等待同步' : ''}</label><strong>{active.execution.conversationId ?? '尚未生成'}</strong></>}
    </div>
    {active.kind === 'agent' && <section className="session-context-summary" aria-label="会话配置摘要">
      <h4>配置摘要</h4>
      <div className="detail-block">
        <label>当前模型</label><strong>{snapshot?.model ?? snapshot?.context?.requestModel ?? (typeof policy.options.model === 'string' && policy.options.model || '跟随连接或引擎默认')}</strong>
        {native && <>
          <label>运行策略</label><strong>{active.engineConfig.options.runtimePolicy === 'defaults' ? '跟随默认' : '单独设置'}</strong>
          <label>输入预算方式</label><strong>{policy.options.inputBudgetMode === 'model' ? '跟随模型窗口' : `自定义上限 ${Number(policy.options.maxInputTokens ?? 64000).toLocaleString()} tokens`}</strong>
          <label>最近回合预算</label><strong>{budget ? `${budget.estimatedInputTokens.toLocaleString()} / ${budget.maxInputTokens.toLocaleString()} 估算 tokens` : '等待回合数据'}</strong>
          <label>自动压缩</label><strong>{compactMode === 'before_send_and_during_run' ? '发送前与回合内' : compactMode === 'before_send' ? '发送前' : '关闭'}</strong>
          <label>会话工具</label><strong>MCP {Array.isArray(policy.options.mcpConnections) ? policy.options.mcpConnections.length : 0} · Skills {Array.isArray(policy.options.projectSkills) ? policy.options.projectSkills.length : 0}</strong>
        </>}
        {!native && snapshot?.context && <><label>上下文使用</label><strong>{snapshot.context.inputTokens?.toLocaleString() ?? '未知'} / {snapshot.context.contextWindow?.toLocaleString() ?? '未知'} tokens</strong></>}
      </div>
      {native && <p className="panel-note"><ModelCapabilityInfo capabilities={snapshot?.context?.modelCapabilities?.capabilities} conservative={snapshot?.context?.modelCapabilities?.conservative}/></p>}
      {loadError && <p className="panel-note" role="status">上下文摘要暂时无法读取。</p>}
      <button type="button" className="secondary compact full" onClick={onOpenSessionSettings}>会话设置</button>
      <p className="panel-note">配置修改用于下一轮任务；最近回合预算保留该轮执行时的值。</p>
    </section>}
    {readOnly && <p className="panel-note">执行器不可用时保留会话及工作目录；归档、删除与原始记录导出暂不可用。</p>}
  </div>;
}
