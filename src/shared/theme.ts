export const THEME_IDS = ['forest', 'cloud', 'sand', 'midnight', 'amber'] as const;
export type ThemeId = typeof THEME_IDS[number];
export const DEFAULT_THEME: ThemeId = 'forest';
export function normalizeThemeId(value: unknown): ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value) ? value as ThemeId : DEFAULT_THEME;
}
/** Shared with the native window so a saved light theme also starts on a light surface. */
export const THEME_APPEARANCE: Record<ThemeId, { background: string; scheme: 'light' | 'dark' }> = {
  forest: { background: '#111515', scheme: 'dark' },
  cloud: { background: '#f7f9fe', scheme: 'light' },
  sand: { background: '#fbf5eb', scheme: 'light' },
  midnight: { background: '#091421', scheme: 'dark' },
  amber: { background: '#161513', scheme: 'dark' },
};
