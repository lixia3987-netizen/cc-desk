import { IMPORTED_FONT_ID, fontFamily, importedFamily, typography, type FontId, type TypographySettings } from '../shared/fonts';

const cacheKey = 'cc-desk.typography';
export function readCachedTypography() {
  try { return typography(JSON.parse(localStorage.getItem(cacheKey) || '{}')); } catch { return typography(); }
}
export function cacheSavedTypography(value: TypographySettings) {
  try { localStorage.setItem(cacheKey, JSON.stringify(typography(value))); } catch { /* The workspace remains authoritative. */ }
}
export function applyTypography(value: TypographySettings) {
  const settings = typography(value), style = document.documentElement.style;
  style.setProperty('--ui-font-family', fontFamily(settings.uiFontFamily));
  style.setProperty('--ui-font-scale', String(settings.uiFontSize / 13));
  style.setProperty('--chat-font-family', fontFamily(settings.chatFontFamily));
  style.setProperty('--chat-font-size', settings.chatFontSize + 'px');
  style.setProperty('--chat-font-scale', String(settings.chatFontSize / 12));
}
interface FontLoad { promise: Promise<void>; face?: FontFace }
const imports = new Map<string, FontLoad>();
export function unloadImportedFont(id: string) {
  const item = imports.get(id);
  if (item?.face) document.fonts.delete(item.face);
  imports.delete(id);
}
export function loadFont(id: FontId): Promise<void> {
  if (!IMPORTED_FONT_ID.test(id)) return Promise.resolve();
  const cached = imports.get(id);
  if (cached) return cached.promise;
  const item: FontLoad = { promise: Promise.resolve() };
  imports.set(id, item);
  item.promise = window.desktop.readFont(id).then(async bytes => {
    const face = new FontFace(importedFamily(id), new Uint8Array(bytes), { weight: '100 900', style: 'normal' });
    await face.load();
    if (imports.get(id) !== item) return;
    item.face = face; document.fonts.add(face);
  }).catch(error => {
    if (imports.get(id) === item) imports.delete(id);
    throw error;
  });
  return item.promise;
}
