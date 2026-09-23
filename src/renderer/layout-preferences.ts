const inspectorKey = 'cc-desk.inspector-open';

/** Keep this window layout preference separate from session and CLI settings. */
export function readInspectorOpen(): boolean {
  try { return localStorage.getItem(inspectorKey) !== 'false'; } catch { return true; }
}

export function saveInspectorOpen(open: boolean): void {
  try { localStorage.setItem(inspectorKey, String(open)); } catch { /* The current window can still toggle if storage is unavailable. */ }
}
