export type SystemFontId = `system:${string}`;
export type FontId = 'system' | SystemFontId | `imported:${string}`;
export interface SystemFont { id: SystemFontId; name: string }
export interface ImportedFont { id: FontId; name: string; format: 'ttf' | 'otf' | 'woff' | 'woff2'; bytes: number }
export interface TypographySettings { chatFontFamily?: FontId; chatFontSize?: number; uiFontFamily?: FontId; uiFontSize?: number }
export const IMPORTED_FONT_ID = /^imported:[a-f0-9]{64}$/;
export const MAX_FONT_BYTES = 20 * 1024 * 1024;
export const MAX_IMPORTED_FONTS = 24;
export const DEFAULT_TYPOGRAPHY = { chatFontFamily: 'system', chatFontSize: 12, uiFontFamily: 'system', uiFontSize: 13 } as const;
export const SYSTEM_FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif';
function validSystemFamily(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
}
export function systemFontId(family: string): SystemFontId {
  if (!validSystemFamily(family)) throw new Error('系统字体名称无效。');
  return 'system:' + encodeURIComponent(family) as SystemFontId;
}
export function systemFontFamily(id: unknown): string | undefined {
  if (typeof id !== 'string' || !id.startsWith('system:') || id.length > 2311) return;
  try {
    const name = decodeURIComponent(id.slice(7));
    return validSystemFamily(name) && systemFontId(name) === id ? name : undefined;
  } catch { return; }
}
export function normalizeSystemFonts(faces: readonly { family: unknown }[]): SystemFont[] {
  const families = new Map<string, SystemFont>();
  for (const face of faces) {
    const name = typeof face.family === 'string' ? face.family.trim() : '';
    if (!validSystemFamily(name)) continue;
    const key = name.toLocaleLowerCase('en-US');
    try { if (!families.has(key)) families.set(key, {id:systemFontId(name),name}); } catch { /* Ignore malformed font metadata. */ }
  }
  return [...families.values()].sort((a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true,sensitivity:'base'}));
}
export function isFontId(value: unknown): value is FontId {
  return typeof value === 'string' && (value === 'system' || IMPORTED_FONT_ID.test(value) || systemFontFamily(value) !== undefined);
}
export function importedFamily(id: string): string {
  if (!IMPORTED_FONT_ID.test(id)) throw new Error('无效的导入字体。');
  return 'WorkbenchImported_' + id.slice(9);
}
export function fontFamily(id: FontId | undefined): string {
  if (id && IMPORTED_FONT_ID.test(id)) return '"' + importedFamily(id) + '", ' + SYSTEM_FONT_STACK;
  const system = systemFontFamily(id);
  if (system) return '"' + system.replace(/\\/g,'\\\\').replace(/"/g,'\\"') + '", ' + SYSTEM_FONT_STACK;
  return SYSTEM_FONT_STACK;
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
