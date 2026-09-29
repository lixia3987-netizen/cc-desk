import { Activity } from 'lucide-react';
import type { AppState, Capabilities, Session } from '../../shared/types';
import { SessionConfig } from '../SessionConfig';
import { time } from './presentation';
import type { ReportError } from './types';

export interface SessionContextPanelProps {
  active: Session;
  project?: AppState['projects'][number];
  structured: boolean;
  cap: Capabilities;
  report: ReportError;
}

export function SessionContextPanel({ active, project, structured, cap, report }: SessionContextPanelProps) {
  return <div className="panel-content">
    <div className="section-label">会话上下文<Activity size={14} /></div>
    <div className="detail-block">
      <label>项目</label>
      <strong>{project?.name ?? '原项目已移除'}</strong>
      <label>工作目录</label>
      <strong>{active.cwd}</strong>
      <label>运行方式</label>
      <strong>{structured ? '结构化对话' : active.kind === 'shell' ? '系统 Shell' : 'Claude Code 终端'}</strong>
      <label>创建时间</label>
      <strong>{time(active.createdAt)}</strong>
      {active.kind === 'agent' && <>
        <label>Claude 会话 ID{active.identityPending ? ' · 等待同步' : ''}</label>
        <strong>{active.execution.conversationId ?? '尚未生成'}</strong>
      </>}
    </div>
    {active.kind === 'agent' && <SessionConfig key={active.id} session={active} capabilities={cap} onError={report} />}
  </div>;
}
