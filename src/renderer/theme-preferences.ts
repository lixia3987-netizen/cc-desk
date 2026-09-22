import { DEFAULT_THEME, normalizeThemeId, type ThemeId } from '../shared/theme';

const cacheKey = 'cc-desk.theme';
/** A paint-time hint only; the main process's saved workspace remains authoritative. */
export function readCachedTheme(): ThemeId {
  try { return normalizeThemeId(localStorage.getItem(cacheKey)); } catch { return DEFAULT_THEME; }
}
export function cacheSavedTheme(theme: ThemeId): void {
  try { localStorage.setItem(cacheKey, theme); } catch { /* Theme persistence uses the workspace, not browser storage. */ }
}
