import { X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { InspectorPanelId } from '../layout-preferences';

interface Props {
  id: InspectorPanelId; title: string; open: boolean;
  onClose: () => void; children: ReactNode;
}

/** Mount on first use; hiding a panel must not discard unfinished edits. */
export function InspectorPanel({ id, title, open, onClose, children }: Props) {
  const [visited, setVisited] = useState(open);
  if (open && !visited) setVisited(true);
  return <section id={`inspector-${id}`} role="region" aria-label={`${title}面板`} hidden={!open} className="inspector-panel">
    <header className="inspector-panel-header">
      <strong className="inspector-panel-title">{title}</strong>
      <button className="icon-button" aria-label={`关闭${title}面板`} title={`关闭${title}面板 · Shift + Esc`} onClick={onClose}><X size={14} /></button>
    </header>
    <div id={`inspector-${id}-body`} className="inspector-panel-body">{visited && children}</div>
  </section>;
}
