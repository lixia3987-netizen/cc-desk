import { useEffect, useState } from 'react';
import { readInspectorOpenPanels, saveInspectorOpenPanels, type InspectorPanelId } from '../layout-preferences';

export function useInspectorPanels() {
  const [openPanels, setOpenPanels] = useState(() => readInspectorOpenPanels());
  useEffect(() => saveInspectorOpenPanels(openPanels), [openPanels]);
  const toggle = (id: InspectorPanelId) => setOpenPanels(current => current.includes(id) ? current.filter(panel => panel !== id) : [...current, id]);
  const close = (id: InspectorPanelId) => setOpenPanels(current => current.includes(id) ? current.filter(panel => panel !== id) : current);
  return { openPanels, toggle, close };
}
