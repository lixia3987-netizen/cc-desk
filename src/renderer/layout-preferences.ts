const inspectorKey = 'cc-desk.inspector-open';
const panelsKey = 'cc-desk.inspector-panels';
const activePanelKey = 'cc-desk.inspector-active-panel';

export const inspectorPanelIds = ['context', 'git', 'workflows', 'diagnostics'] as const;
export type InspectorPanelId = typeof inspectorPanelIds[number];
export type InspectorActivePanel = InspectorPanelId | null;

/** One docked tool, or only the persistent tool rail. Legacy hidden content stays hidden. */
export function readInspectorActivePanel(storage?: Pick<Storage, 'getItem'>): InspectorActivePanel {
  try {
    const source = storage ?? localStorage;
    const current = source.getItem(activePanelKey);
    if (current !== null) {
      try {
        const active: unknown = JSON.parse(current);
        if (active === null || inspectorPanelIds.some(id => id === active)) return active as InspectorActivePanel;
      } catch { /* A corrupt new preference can still migrate a valid legacy layout. */ }
    }
    if (source.getItem(inspectorKey) === 'false') return null;
    const value: unknown = JSON.parse(source.getItem(panelsKey) ?? 'null');
    if (value && typeof value === 'object' && 'open' in value && 'collapsed' in value && Array.isArray(value.open) && Array.isArray(value.collapsed)) {
      const open = value.open, collapsed = value.collapsed;
      return inspectorPanelIds.find(id => open.includes(id) && !collapsed.includes(id)) ?? null;
    }
  } catch { /* Use the initial layout when storage is unavailable or invalid. */ }
  return 'context';
}

/** Keep this window layout preference separate from session and CLI settings. */
export function saveInspectorActivePanel(active: InspectorActivePanel, storage?: Pick<Storage, 'setItem'>): void {
  try { (storage ?? localStorage).setItem(activePanelKey, JSON.stringify(active)); } catch { /* Tools remain usable without storage. */ }
}
