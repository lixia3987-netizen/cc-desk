export const BUILTIN_FONT_IDS = ['system', 'noto-sans-sc', 'jetbrains-mono'] as const;
export type BuiltinFontId = typeof BUILTIN_FONT_IDS[number];
export type FontId = BuiltinFontId | `imported:${string}`;
export interface ImportedFont { id: FontId; name: string; format: 'ttf' | 'otf' | 'woff' | 'woff2'; bytes: number }
export interface TypographySettings { chatFontFamily?: FontId; chatFontSize?: number; uiFontFamily?: FontId; uiFontSize?: number }
export const IMPORTED_FONT_ID = /^imported:[a-f0-9]{64}$/;
export const MAX_FONT_BYTES = 20 * 1024 * 1024;
export const MAX_IMPORTED_FONTS = 24;
export const DEFAULT_TYPOGRAPHY = { chatFontFamily: 'system', chatFontSize: 12, uiFontFamily: 'system', uiFontSize: 13 } as const;
export const SYSTEM_FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif';
export const BUILTIN_FONTS = [
  { id: 'system', name: '系统默认', family: '', description: '使用当前系统的界面字体' },
  { id: 'noto-sans-sc', name: 'Noto Sans SC · 思源黑体', family: 'Noto Sans SC Variable', description: '简体中文无衬线，适合界面与日常阅读' },
  { id: 'jetbrains-mono', name: 'JetBrains Mono · 等宽', family: 'JetBrains Mono Variable', description: '拉丁字符等宽，中文使用内置黑体补齐' },
] as const;
export function isFontId(value: unknown): value is FontId {
  return typeof value === 'string' && ((BUILTIN_FONT_IDS as readonly string[]).includes(value) || IMPORTED_FONT_ID.test(value));
}
export function importedFamily(id: string): string {
  if (!IMPORTED_FONT_ID.test(id)) throw new Error('无效的导入字体。');
  return 'WorkbenchImported_' + id.slice(9);
}
export function fontFamily(id: FontId | undefined): string {
  if (id && IMPORTED_FONT_ID.test(id)) return '"' + importedFamily(id) + '", "Noto Sans SC Variable", ' + SYSTEM_FONT_STACK;
  const font = BUILTIN_FONTS.find(font => font.id === id);
  return font?.family ? '"' + font.family + '", "Noto Sans SC Variable", ' + SYSTEM_FONT_STACK : SYSTEM_FONT_STACK;
}
export function typography(settings: TypographySettings = {}) {
  const size = (value: number | undefined, fallback: number, max: number) => Number.isFinite(value) && Number.isInteger(value) && value! >= 11 && value! <= max ? value! : fallback;
  return {
    chatFontFamily: isFontId(settings.chatFontFamily) ? settings.chatFontFamily : DEFAULT_TYPOGRAPHY.chatFontFamily,
    uiFontFamily: isFontId(settings.uiFontFamily) ? settings.uiFontFamily : DEFAULT_TYPOGRAPHY.uiFontFamily,
    chatFontSize: size(settings.chatFontSize, DEFAULT_TYPOGRAPHY.chatFontSize, 28),
    uiFontSize: size(settings.uiFontSize, DEFAULT_TYPOGRAPHY.uiFontSize, 20),
  };
}
