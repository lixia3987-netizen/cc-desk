import { Activity, GitBranch, Stethoscope, Workflow } from 'lucide-react';
import type { CSSProperties } from 'react';
import { emptyGitReviewDraft, emptyWorkflowDraft, type PanelDrafts } from '../../shared/panel-drafts';
import { inspectorPanelIds } from '../layout-preferences';
import { DiagnosticsPanel, GitPanel } from '../ProjectPanels';
import { WorkflowPanel } from '../WorkflowPanel';
import { InspectorPanel } from './InspectorPanel';
import { SessionContextPanel, type SessionContextPanelProps } from './SessionContextPanel';
import { useInspectorPanels } from './useInspectorPanels';

interface Props extends SessionContextPanelProps {
  inspectorOpen: boolean; appendReview: (text: string) => boolean; activePanels: PanelDrafts;
  updatePanel: <K extends keyof PanelDrafts>(id: string, key: K, update: (value: NonNullable<PanelDrafts[K]>) => NonNullable<PanelDrafts[K]>) => void;
}

const panels = {
  context: { title: '上下文', icon: Activity }, git: { title: '变更', icon: GitBranch },
  workflows: { title: '工作流', icon: Workflow }, diagnostics: { title: '诊断', icon: Stethoscope },
};

export function SessionInspector(props: Props) {
  const { active, inspectorOpen, report, appendReview, activePanels, updatePanel } = props;
  const layout = useInspectorPanels();
  // CSS changes the column count without reparenting panels or remounting editors.
  const rows = (columns: number) => layout.open.reduce<string[]>((tracks, id, index) => {
    const row = Math.floor(index / columns);
    tracks[row] = tracks[row] === 'minmax(240px, 1fr)' || !layout.collapsed.includes(id) ? 'minmax(240px, 1fr)' : 'max-content';
    return tracks;
  }, []).join(' ');
  const style = { '--panel-rows': rows(1), '--panel-wide-rows': rows(2) } as CSSProperties;
  const visible = (id: typeof inspectorPanelIds[number]) => inspectorOpen && layout.open.includes(id) && !layout.collapsed.includes(id);

  return <aside id="session-inspector" aria-label="会话详情" hidden={!inspectorOpen} className="inspector" data-empty={!layout.open.length} data-multiple={layout.open.length > 1} data-git={layout.open.includes('git')}>
    <div className="inspector-tools" role="group" aria-label="会话面板">
      {inspectorPanelIds.map(id => {
        const { title, icon: Icon } = panels[id];
        return <button key={id} id={`inspector-toggle-${id}`} aria-label={title} aria-pressed={layout.open.includes(id)} aria-controls={`inspector-${id}`} title={`${layout.open.includes(id) ? '关闭' : '打开'}${title}面板`} onClick={() => layout.toggle(id)}>
          <Icon size={14} /><span>{title}</span>
        </button>;
      })}
    </div>
    <div className="inspector-grid" style={style} hidden={!layout.open.length}>
      {inspectorPanelIds.map(id => <InspectorPanel key={`${active.id}:${id}`} id={id} title={panels[id].title} open={layout.open.includes(id)} collapsed={layout.collapsed.includes(id)}
        onClose={() => { layout.toggle(id); document.getElementById(`inspector-toggle-${id}`)?.focus(); }} onCollapse={() => layout.collapse(id)}>
        {id === 'context' && <SessionContextPanel {...props} />}
        {id === 'git' && <GitPanel session={active} visible={visible(id)} onError={report} onReview={appendReview} draft={activePanels.git ?? emptyGitReviewDraft()} onDraft={update => updatePanel(active.id, 'git', update)} />}
        {id === 'workflows' && <WorkflowPanel session={active} onError={report} onTemplate={appendReview} draft={activePanels.workflow ?? emptyWorkflowDraft()} onDraft={update => updatePanel(active.id, 'workflow', update)} />}
        {id === 'diagnostics' && <DiagnosticsPanel key={active.id + active.cwd} sessionId={active.id} onError={report} />}
      </InspectorPanel>)}
    </div>
  </aside>;
}
