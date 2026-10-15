import { DEFAULT_THEME, normalizeThemeId, type ThemeId } from '../shared/theme';

const cacheKey = 'cc-desk.theme';
/** 仅作为绘制时的提示，主进程保存的工作区仍是权威状态。 */
export function readCachedTheme(): ThemeId {
  try { return normalizeThemeId(localStorage.getItem(cacheKey)); } catch { return DEFAULT_THEME; }
}
export function cacheSavedTheme(theme: ThemeId): void {
  try { localStorage.setItem(cacheKey, theme); } catch { /* 主题通过工作区持久化，不使用浏览器存储。 */ }
}
