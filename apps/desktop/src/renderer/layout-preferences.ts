const inspectorKey = 'cc-desk.inspector-open';
const panelsKey = 'cc-desk.inspector-panels';
const activePanelKey = 'cc-desk.inspector-active-panel';
const openPanelsKey = 'cc-desk.inspector-open-panels';

export const inspectorPanelIds = ['context', 'git', 'workflows', 'diagnostics'] as const;
export type InspectorPanelId = typeof inspectorPanelIds[number];
const isPanelId = (value: unknown): value is InspectorPanelId => inspectorPanelIds.some(id => id === value);
const uniquePanels = (values: unknown[]): InspectorPanelId[] => [...new Set(values.filter(isPanelId))];
const parsePreference = (value: string | null): unknown => {
  try { return value === null ? undefined : JSON.parse(value); }
  catch { return undefined; }
};

/** Preserve opening order and explicit hidden layouts across previous formats. */
export function readInspectorOpenPanels(storage?: Pick<Storage, 'getItem'>): InspectorPanelId[] {
  try {
    const source = storage ?? localStorage;
    const current = parsePreference(source.getItem(openPanelsKey));
    if (Array.isArray(current)) return uniquePanels(current);
    const active = parsePreference(source.getItem(activePanelKey));
    if (active === null) return [];
    if (isPanelId(active)) return [active];
    if (source.getItem(inspectorKey) === 'false') return [];
    const value = parsePreference(source.getItem(panelsKey));
    if (value && typeof value === 'object' && 'open' in value && 'collapsed' in value && Array.isArray(value.open) && Array.isArray(value.collapsed)) {
      const collapsed = value.collapsed;
      return uniquePanels(value.open).filter(id => !collapsed.includes(id));
    }
  } catch { /* Use the initial layout when storage is unavailable or invalid. */ }
  return ['context'];
}

/** Keep this window layout preference separate from session and CLI settings. */
export function saveInspectorOpenPanels(open: InspectorPanelId[], storage?: Pick<Storage, 'setItem'>): void {
  try { (storage ?? localStorage).setItem(openPanelsKey, JSON.stringify(uniquePanels(open))); } catch { /* Tools remain usable without storage. */ }
}
