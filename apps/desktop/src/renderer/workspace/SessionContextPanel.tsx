import { Activity } from 'lucide-react';
import type { AppState, Session } from '../../shared/types';
import type { ExecutionCapabilities, ExecutionDescriptor } from '../../shared/execution';
import { SessionConfig } from '../SessionConfig';
import { time } from './presentation';
import type { OpenNew, Perform, ReportError } from './types';

export interface SessionContextPanelProps {
  executionCapabilities?: ExecutionCapabilities;
  descriptor?: ExecutionDescriptor; unavailable?: string; readOnly: boolean;
  active: Session; project?: AppState['projects'][number]; structured: boolean;
  activeBusy: boolean; busy: boolean; perform: Perform; report: ReportError;
  setNotice: (value: string) => void; openNew: OpenNew; selectSession: (id: string) => void;
  flushDrafts: () => void;
}

export function SessionContextPanel({ active, project, structured, descriptor, readOnly, report }: SessionContextPanelProps) {
  return <div className="panel-content">
    <div className="section-label">会话上下文<Activity size={14} /></div>
    <div className="detail-block">
      <label>项目</label><strong>{project?.name ?? '原项目已移除'}</strong>
      <label>工作目录</label><strong>{active.cwd}</strong>
      <label>运行方式</label><strong>{descriptor?.displayName ?? active.execution.providerId} · {structured ? '结构化对话' : '终端'}</strong>
      <label>创建时间</label><strong>{time(active.createdAt)}</strong>
      {active.kind === 'agent' && <><label>{descriptor?.displayName ?? active.execution.providerId} 会话 ID{active.identityPending ? ' · 等待同步' : ''}</label><strong>{active.execution.conversationId ?? '尚未生成'}</strong></>}
    </div>
    {active.kind === 'agent' && <SessionConfig key={active.id} session={active} descriptor={descriptor} onError={report} />}
    {readOnly && <p className="panel-note">执行器不可用时保留会话及工作目录；归档、删除与原始记录导出暂不可用。</p>}
  </div>;
}
