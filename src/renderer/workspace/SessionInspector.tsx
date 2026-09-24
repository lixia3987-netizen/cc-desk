import { Activity, GitBranch, Stethoscope, Workflow } from 'lucide-react';
import { emptyGitReviewDraft, emptyWorkflowDraft, type PanelDrafts } from '../../shared/panel-drafts';
import { inspectorPanelIds, type InspectorPanelId } from '../layout-preferences';
import { DiagnosticsPanel, GitPanel } from '../ProjectPanels';
import { WorkflowPanel } from '../WorkflowPanel';
import { InspectorPanel } from './InspectorPanel';
import { SessionContextPanel, type SessionContextPanelProps } from './SessionContextPanel';
import { useInspectorPanels } from './useInspectorPanels';

interface Props extends SessionContextPanelProps {
  appendReview: (text: string) => boolean; activePanels: PanelDrafts;
  updatePanel: <K extends keyof PanelDrafts>(id: string, key: K, update: (value: NonNullable<PanelDrafts[K]>) => NonNullable<PanelDrafts[K]>) => void;
}

const panels = {
  context: { title: '上下文', icon: Activity }, git: { title: '变更', icon: GitBranch },
  workflows: { title: '工作流', icon: Workflow }, diagnostics: { title: '诊断', icon: Stethoscope },
};

export function SessionInspector(props: Props) {
  const { active, report, appendReview, activePanels, updatePanel } = props;
  const layout = useInspectorPanels();
  const close = (id: InspectorPanelId) => {
    layout.close(id);
    document.getElementById(`inspector-toggle-${id}`)?.focus();
  };

  return <aside id="session-inspector" aria-label="会话详情" className="inspector" data-empty={layout.activePanel === null} data-active={layout.activePanel ?? ''} onKeyDown={event => {
    if (event.key !== 'Escape' || !event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented || event.nativeEvent.isComposing || !layout.activePanel) return;
    if (document.querySelector('[role="dialog"]') || !(event.target instanceof Element) || !event.target.closest('.inspector-panel')) return;
    event.preventDefault(); event.stopPropagation(); close(layout.activePanel);
  }}>
    <div className="inspector-dock" hidden={layout.activePanel === null}>
      {inspectorPanelIds.map(id => <InspectorPanel key={`${active.id}:${id}`} id={id} title={panels[id].title} open={layout.activePanel === id} onClose={() => close(id)}>
        {id === 'context' && <SessionContextPanel {...props} />}
        {id === 'git' && <GitPanel session={active} visible={layout.activePanel === id} onError={report} onReview={appendReview} draft={activePanels.git ?? emptyGitReviewDraft()} onDraft={update => updatePanel(active.id, 'git', update)} />}
        {id === 'workflows' && <WorkflowPanel session={active} onError={report} onTemplate={appendReview} draft={activePanels.workflow ?? emptyWorkflowDraft()} onDraft={update => updatePanel(active.id, 'workflow', update)} />}
        {id === 'diagnostics' && <DiagnosticsPanel key={active.id + active.cwd} sessionId={active.id} onError={report} />}
      </InspectorPanel>)}
    </div>
    <div className="inspector-tools" role="group" aria-label="会话面板">
      {inspectorPanelIds.map(id => {
        const { title, icon: Icon } = panels[id];
        const open = layout.activePanel === id;
        return <button key={id} id={`inspector-toggle-${id}`} aria-label={title} aria-pressed={open} aria-expanded={open} aria-controls={`inspector-${id}`} title={`${open ? '关闭' : '打开'}${title}面板`} onClick={() => layout.toggle(id)}>
          <Icon size={18} /><span>{title}</span>
        </button>;
      })}
    </div>
  </aside>;
}
