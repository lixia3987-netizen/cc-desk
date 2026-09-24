const inspectorKey = 'cc-desk.inspector-open';
const panelsKey = 'cc-desk.inspector-panels';

export const inspectorPanelIds = ['context', 'git', 'workflows', 'diagnostics'] as const;
export type InspectorPanelId = typeof inspectorPanelIds[number];
export interface InspectorPanels { open: InspectorPanelId[]; collapsed: InspectorPanelId[] }

export function readInspectorPanels(): InspectorPanels {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(panelsKey) ?? 'null');
    if (value && typeof value === 'object' && 'open' in value && 'collapsed' in value && Array.isArray(value.open) && Array.isArray(value.collapsed)) {
      const open = value.open, collapsed = value.collapsed;
      return { open: inspectorPanelIds.filter(id => open.includes(id)), collapsed: inspectorPanelIds.filter(id => collapsed.includes(id)) };
    }
  } catch { /* Use the initial layout when storage is unavailable or invalid. */ }
  return { open: ['context'], collapsed: [] };
}

export function saveInspectorPanels(panels: InspectorPanels): void {
  try { localStorage.setItem(panelsKey, JSON.stringify(panels)); } catch { /* Layout remains usable without storage. */ }
}

/** Keep this window layout preference separate from session and CLI settings. */
export function readInspectorOpen(): boolean {
  try { return localStorage.getItem(inspectorKey) !== 'false'; } catch { return true; }
}

export function saveInspectorOpen(open: boolean): void {
  try { localStorage.setItem(inspectorKey, String(open)); } catch { /* The current window can still toggle if storage is unavailable. */ }
}
