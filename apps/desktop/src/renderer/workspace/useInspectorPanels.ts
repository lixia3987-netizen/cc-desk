import { useEffect, useState } from 'react';
import { clampInspectorWidth, readInspectorOpenPanels, readInspectorWidth, saveInspectorOpenPanels, saveInspectorWidth, type InspectorPanelId } from '../layout-preferences';

export function useInspectorPanels() {
  const [openPanels, setOpenPanels] = useState(() => readInspectorOpenPanels());
  const [width, setWidth] = useState(readInspectorWidth);
  useEffect(() => saveInspectorOpenPanels(openPanels), [openPanels]);
  useEffect(() => saveInspectorWidth(width), [width]);
  const toggle = (id: InspectorPanelId) => setOpenPanels(current => current.includes(id) ? [] : [id]);
  const close = (id: InspectorPanelId) => setOpenPanels(current => current.includes(id) ? current.filter(panel => panel !== id) : current);
  return { openPanels, toggle, close, width, resize: (value: number) => setWidth(clampInspectorWidth(value)) };
}
