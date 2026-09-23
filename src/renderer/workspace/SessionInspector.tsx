import { Activity, Archive, Copy, GitBranch } from 'lucide-react';
import type { ExecutionCapabilities } from '../../shared/execution';
import { emptyGitReviewDraft, emptyWorkflowDraft, type PanelDrafts } from '../../shared/panel-drafts';
import type { AppState, Capabilities, Session } from '../../shared/types';
import { DiagnosticsPanel, GitPanel } from '../ProjectPanels';
import { SessionConfig } from '../SessionConfig';
import { WorkflowPanel } from '../WorkflowPanel';

import { time } from './presentation';
import type { OpenNew, Perform, ReportError } from './types';
export type InspectorTab = 'context' | 'git' | 'workflows' | 'diagnostics';

interface Props {
  executionCapabilities?: ExecutionCapabilities;
  active: Session; project?: AppState['projects'][number]; structured: boolean; activeBusy: boolean;
  cap: Capabilities; busy: boolean; inspectorOpen: boolean; inspectorTab: InspectorTab;
  setInspectorTab: (tab: InspectorTab) => void; perform: Perform; report: ReportError;
  setNotice: (value: string) => void; openNew: OpenNew; selectSession: (id: string) => void;
  deleteConfirm: string; setDeleteConfirm: (id: string) => void; flushDrafts: () => void;
  appendReview: (text: string) => boolean; activePanels: PanelDrafts;
  updatePanel: <K extends keyof PanelDrafts>(id: string, key: K, update: (value: NonNullable<PanelDrafts[K]>) => NonNullable<PanelDrafts[K]>) => void;
}

export function SessionInspector({ executionCapabilities, active, project, structured, activeBusy, cap, busy, inspectorOpen, inspectorTab, setInspectorTab, perform, report, setNotice, openNew, selectSession, deleteConfirm, setDeleteConfirm, flushDrafts, appendReview, activePanels, updatePanel }: Props) {
  return <aside id="session-inspector" aria-label="会话详情" hidden={!inspectorOpen} className={'inspector ' + (inspectorTab === 'git' ? 'git-expanded' : '')}>
    <div className="inspector-tabs" role="tablist" aria-label="会话面板">{(['context', 'git', 'workflows', 'diagnostics'] as const).map(tab =>
      <button key={tab} role="tab" aria-selected={inspectorTab === tab} className={inspectorTab === tab ? 'active' : ''} onClick={() => setInspectorTab(tab)}>{{ context: '上下文', git: '变更', workflows: '工作流', diagnostics: '诊断' }[tab]}</button>)}</div>
    {inspectorTab === 'context' && <div className="panel-content">
      <div className="section-label">会话上下文<Activity size={14} />
      </div>
      <div className="detail-block">
        <label>项目</label>
        <strong>{project?.name ?? '原项目已移除'}</strong>
        <label>工作目录</label>
        <strong>{active.cwd}</strong>
        <label>运行方式</label>
        <strong>{structured ? '结构化对话' : active.kind === 'shell' ? '系统 Shell' : 'Claude Code 终端'}</strong>
        <label>创建时间</label>
        <strong>{time(active.createdAt)}</strong>{active.kind === 'agent' && <>
          <label>Claude 会话 ID{active.identityPending ? ' · 等待同步' : ''}</label>
          <button className="id-copy" title="复制会话 ID" onClick={() => void perform(async () => { await navigator.clipboard.writeText(active.execution.conversationId ?? ''); setNotice('会话 ID 已复制'); })}>{(active.execution.conversationId ?? '').slice(0, 18)}…<Copy size={12} />
          </button>
        </>}</div>
      {active.kind === 'agent' && <>
        <SessionConfig key={active.id} session={active} capabilities={cap} onError={report} />
        <button className="secondary full" disabled={!active.started || !executionCapabilities?.fork || activeBusy || active.identityPending} onClick={() => openNew('agent', active)}>
          <GitBranch size={14} />从此会话创建分支</button>
      </>}
      <button className="text-button archive-button" disabled={busy || (structured ? activeBusy : ['running', 'stopping'].includes(active.status))} onClick={() => void perform(async () => { await window.desktop.updateSession({ id: active.id, archived: !active.archived }); selectSession(''); })}>
        <Archive size={14} />{active.archived ? '取消归档' : '归档会话'}</button>
      <button className="text-button danger archive-button" disabled={busy || (structured ? activeBusy : ['running', 'stopping'].includes(active.status))} onClick={() => setDeleteConfirm(active.id)}>删除会话</button>
      {deleteConfirm === active.id && <div className="action-confirm">
        <p>删除工作台中的会话记录。原始 CLI 历史会保留；隔离目录需要先清理。</p>
        <button className="secondary compact" onClick={() => setDeleteConfirm('')}>取消</button>
        <button className="secondary compact danger" disabled={busy} onClick={() => void perform(async () => { flushDrafts(); await window.desktop.deleteSession(active.id); selectSession(''); })}>确认删除会话</button>
      </div>}</div>}
    {inspectorTab === 'git' && <GitPanel key={active.id} session={active} onError={report} onReview={appendReview} draft={activePanels.git ?? emptyGitReviewDraft()} onDraft={update => updatePanel(active.id, 'git', update)} />}
    {inspectorTab === 'diagnostics' && <DiagnosticsPanel key={active.id + active.cwd} sessionId={active.id} onError={report} />}
    {inspectorTab === 'workflows' && <WorkflowPanel key={active.id} session={active} onError={report} onTemplate={appendReview} draft={activePanels.workflow ?? emptyWorkflowDraft()} onDraft={update => updatePanel(active.id, 'workflow', update)} />}
  </aside>;
}
