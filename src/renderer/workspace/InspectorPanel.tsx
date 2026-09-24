import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { InspectorPanelId } from '../layout-preferences';

interface Props {
  id: InspectorPanelId; title: string; open: boolean; collapsed: boolean;
  onClose: () => void; onCollapse: () => void; children: ReactNode;
}

/** Mount on first use; hiding a panel must not discard unfinished edits. */
export function InspectorPanel({ id, title, open, collapsed, onClose, onCollapse, children }: Props) {
  const [visited, setVisited] = useState(open);
  if (open && !visited) setVisited(true);
  return <section id={`inspector-${id}`} role="region" aria-label={`${title}面板`} hidden={!open} className={'inspector-panel' + (collapsed ? ' collapsed' : '')}>
    <header className="inspector-panel-header">
      <button className="inspector-panel-title" aria-label={`${collapsed ? '展开' : '折叠'}${title}面板`} aria-expanded={!collapsed} aria-controls={`inspector-${id}-body`} onClick={onCollapse}>
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}<span>{title}</span>
      </button>
      <button className="icon-button" aria-label={`关闭${title}面板`} title={`关闭${title}面板`} onClick={onClose}><X size={14} /></button>
    </header>
    <div id={`inspector-${id}-body`} className="inspector-panel-body" hidden={collapsed}>{visited && children}</div>
  </section>;
}
