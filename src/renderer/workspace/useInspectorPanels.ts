import { useEffect, useState } from 'react';
import { readInspectorActivePanel, saveInspectorActivePanel, type InspectorPanelId } from '../layout-preferences';

export function useInspectorPanels() {
  const [activePanel, setActivePanel] = useState(() => readInspectorActivePanel());
  useEffect(() => saveInspectorActivePanel(activePanel), [activePanel]);
  const toggle = (id: InspectorPanelId) => setActivePanel(current => current === id ? null : id);
  const close = (id: InspectorPanelId) => setActivePanel(current => current === id ? null : current);
  return { activePanel, toggle, close };
}
