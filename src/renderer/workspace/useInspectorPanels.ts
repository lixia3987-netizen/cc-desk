import { useEffect, useState } from 'react';
import { inspectorPanelIds, readInspectorPanels, saveInspectorPanels, type InspectorPanelId } from '../layout-preferences';

export function useInspectorPanels() {
  const [panels, setPanels] = useState(readInspectorPanels);
  useEffect(() => saveInspectorPanels(panels), [panels]);
  const toggle = (id: InspectorPanelId) => setPanels(current => ({
    ...current,
    open: current.open.includes(id) ? current.open.filter(value => value !== id) : inspectorPanelIds.filter(value => value === id || current.open.includes(value)),
    // Reopening a tool should reveal its content, including its unfinished edits.
    collapsed: current.collapsed.filter(value => value !== id),
  }));
  const collapse = (id: InspectorPanelId) => setPanels(current => ({ ...current,
    collapsed: current.collapsed.includes(id) ? current.collapsed.filter(value => value !== id) : [...current.collapsed, id],
  }));
  return { ...panels, toggle, collapse };
}
