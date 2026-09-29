import type { ExecutionDescriptor } from '../../shared/execution';
import type { Session } from '../../shared/types';
import { executionUnavailable } from '../EngineConfiguration';
import { Activity, GitBranch, Stethoscope, Workflow } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { emptyGitReviewDraft, emptyWorkflowDraft, type PanelDrafts } from '../../shared/panel-drafts';
import { inspectorPanelIds, type InspectorPanelId } from '../layout-preferences';
import { DiagnosticsPanel, GitPanel } from '../ProjectPanels';
import { WorkflowPanel } from '../WorkflowPanel';
import { InspectorPanel } from './InspectorPanel';
import { SessionContextPanel, type SessionContextPanelProps } from './SessionContextPanel';
import { useInspectorPanels } from './useInspectorPanels';

interface Props extends SessionContextPanelProps {
  executors: ExecutionDescriptor[]; sessions: Session[];
  connectionUnavailable?(session: Session): string | undefined;
  appendReview: (text: string) => boolean; activePanels: PanelDrafts;
  updatePanel: <K extends keyof PanelDrafts>(id: string, key: K, update: (value: NonNullable<PanelDrafts[K]>) => NonNullable<PanelDrafts[K]>) => void;
}

const panels = {
  context: { title: '上下文', icon: Activity }, git: { title: '变更', icon: GitBranch },
  workflows: { title: '工作流', icon: Workflow }, diagnostics: { title: '诊断', icon: Stethoscope },
};

const nativeRecoveryReadOnly = (session: Session) => session.execution.providerId === 'native' && !!session.error?.includes('此会话只读');

export function SessionInspector(props: Props) {
  const { active, report, appendReview, activePanels, updatePanel } = props;
  const layout = useInspectorPanels();
  const openingPanel = useRef<InspectorPanelId | null>(null);
  const empty = layout.openPanels.length === 0;
  // Keep keyed, visited panels mounted while matching keyboard order to the dock.
  const orderedPanels = [...layout.openPanels, ...inspectorPanelIds.filter(id => !layout.openPanels.includes(id))];
  useLayoutEffect(() => {
    const id = openingPanel.current;
    openingPanel.current = null;
    if (id && layout.openPanels.includes(id)) {
      document.getElementById(`inspector-${id}`)?.querySelector('header')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [layout.openPanels]);
  const toggle = (id: InspectorPanelId) => {
    openingPanel.current = layout.openPanels.includes(id) ? null : id;
    layout.toggle(id);
  };
  const close = (id: InspectorPanelId) => {
    layout.close(id);
    document.getElementById(`inspector-toggle-${id}`)?.focus();
  };

  return <aside id="session-inspector" aria-label="会话详情" className="inspector" data-empty={empty} data-count={layout.openPanels.length} onKeyDown={event => {
    if (event.key !== 'Escape' || !event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (document.querySelector('[role="dialog"]') || !(event.target instanceof Element)) return;
    const focusedPanel = event.target.closest<HTMLElement>('.inspector-panel')?.dataset.panel;
    const id = layout.openPanels.find(id => id === focusedPanel);
    if (!id) return;
    event.preventDefault(); event.stopPropagation(); close(id);
  }}>
    <div className="inspector-dock" hidden={empty}>
      {orderedPanels.map(id => <InspectorPanel key={`${active.id}:${id}`} id={id} title={panels[id].title} open={layout.openPanels.includes(id)} onClose={() => close(id)}>
        {id === 'context' && <SessionContextPanel {...props} />}
        {id === 'git' && <GitPanel session={active} visible={layout.openPanels.includes(id)} onError={report} onReview={appendReview} draft={activePanels.git ?? emptyGitReviewDraft()} onDraft={update => updatePanel(active.id, 'git', update)} />}
        {/* Saving a workflow draft does not require a live CLI or model credential. */}
        {id === 'workflows' && <WorkflowPanel session={active} disabled={props.readOnly || nativeRecoveryReadOnly(active) || !!props.descriptor?.maintenance || !props.descriptor?.capabilities.structured} executionBlocked={run => {
          const session = props.sessions.find(item => item.id === run.sessionId);
          const descriptor = props.executors.find(item => item.providerId === run.providerId && item.mode === run.executionMode);
          return !session || nativeRecoveryReadOnly(session) || !!executionUnavailable(descriptor, session) || !!props.connectionUnavailable?.(session);
        }} onError={report} onTemplate={appendReview} draft={activePanels.workflow ?? emptyWorkflowDraft()} onDraft={update => updatePanel(active.id, 'workflow', update)} />}
        {id === 'diagnostics' && (active.execution.providerId === 'claude' ? <DiagnosticsPanel key={active.id + active.cwd} sessionId={active.id} onError={report} /> : <div className="panel-content"><p className="panel-note">{props.unavailable ?? `${props.descriptor?.displayName ?? active.execution.providerId} 暂未提供连接诊断。`}</p></div>)}
      </InspectorPanel>)}
    </div>
    <div className="inspector-tools" role="group" aria-label="会话面板">
      {inspectorPanelIds.map(id => {
        const { title, icon: Icon } = panels[id];
        const open = layout.openPanels.includes(id);
        return <button key={id} id={`inspector-toggle-${id}`} aria-label={title} aria-pressed={open} aria-expanded={open} aria-controls={`inspector-${id}`} title={`${open ? '关闭' : '打开'}${title}面板`} onClick={() => toggle(id)}>
          <Icon size={18} /><span>{title}</span>
        </button>;
      })}
    </div>
  </aside>;
}
