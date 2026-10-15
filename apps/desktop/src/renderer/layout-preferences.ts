const inspectorKey = 'cc-desk.inspector-open';
const panelsKey = 'cc-desk.inspector-panels';
const activePanelKey = 'cc-desk.inspector-active-panel';
const openPanelsKey = 'cc-desk.inspector-open-panels';
const selectedPanelKey = 'cc-desk.inspector-selected-panel';
const panelWidthKey = 'cc-desk.inspector-width';

export const inspectorPanelIds = ['context', 'git', 'workflows', 'commands', 'diagnostics'] as const;
export type InspectorPanelId = typeof inspectorPanelIds[number];
/** Native 命令控件仅适用于结构化 Native 会话。 */
export function visibleInspectorPanelIds(nativeStructured: boolean): InspectorPanelId[] {
  return inspectorPanelIds.filter(id => id !== 'commands' || nativeStructured);
}
const isPanelId = (value: unknown): value is InspectorPanelId => inspectorPanelIds.some(id => id === value);
const uniquePanels = (values: unknown[]): InspectorPanelId[] => [...new Set(values.filter(isPanelId))];
const parsePreference = (value: string | null): unknown => {
  try { return value === null ? undefined : JSON.parse(value); }
  catch { return undefined; }
};

/** 每次只展示一个详情；保留明确关闭的布局和最后打开的旧版工具。 */
export function readInspectorOpenPanels(storage?: Pick<Storage, 'getItem'>): InspectorPanelId[] {
  try {
    const source = storage ?? localStorage;
    const selected = parsePreference(source.getItem(selectedPanelKey));
    if (selected === null) return [];
    if (isPanelId(selected)) return [selected];
    const current = parsePreference(source.getItem(openPanelsKey));
    if (Array.isArray(current)) return uniquePanels(current).slice(-1);
    const active = parsePreference(source.getItem(activePanelKey));
    if (active === null) return [];
    if (isPanelId(active)) return [active];
    if (source.getItem(inspectorKey) === 'false') return [];
    const value = parsePreference(source.getItem(panelsKey));
    if (value && typeof value === 'object' && 'open' in value && 'collapsed' in value && Array.isArray(value.open) && Array.isArray(value.collapsed)) {
      const collapsed = value.collapsed;
      return uniquePanels(value.open).filter(id => !collapsed.includes(id)).slice(-1);
    }
  } catch { /* 存储不可用或无效时，使用初始布局。 */ }
  return ['context'];
}

/** 将窗口布局偏好与会话及 CLI 设置分开保存。 */
export function saveInspectorOpenPanels(open: InspectorPanelId[], storage?: Pick<Storage, 'setItem'>): void {
  try { (storage ?? localStorage).setItem(selectedPanelKey, JSON.stringify(uniquePanels(open).at(-1) ?? null)); } catch { /* 即使存储不可用，工具仍可使用。 */ }
}

export const inspectorWidthBounds = { min: 260, max: 560, initial: 340 };
export function clampInspectorWidth(value: number) {
  return Number.isFinite(value) ? Math.round(Math.max(inspectorWidthBounds.min, Math.min(inspectorWidthBounds.max, value))) : inspectorWidthBounds.initial;
}
export function readInspectorWidth(storage?: Pick<Storage, 'getItem'>): number {
  try {
    const value = parsePreference((storage ?? localStorage).getItem(panelWidthKey));
    return typeof value === 'number' ? clampInspectorWidth(value) : inspectorWidthBounds.initial;
  } catch { return inspectorWidthBounds.initial; }
}
export function saveInspectorWidth(width: number, storage?: Pick<Storage, 'setItem'>): void {
  try { (storage ?? localStorage).setItem(panelWidthKey, JSON.stringify(clampInspectorWidth(width))); } catch { /* 仍允许调整大小。 */ }
}
