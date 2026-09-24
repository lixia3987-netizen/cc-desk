import { normalizeSystemFonts, type SystemFont } from '../shared/fonts';

declare global {
  interface Window { queryLocalFonts?: () => Promise<{ family: string }[]> }
}

/** Enumerate metadata only; system fonts stay on the OS and are used through CSS. */
export async function listSystemFonts(): Promise<SystemFont[]> {
  if (!window.queryLocalFonts) throw new Error('当前环境不支持读取系统字体，请使用桌面应用或导入字体。');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const faces = await Promise.race([
      window.queryLocalFonts(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('读取系统字体超时，请重试。')), 10000); }),
    ]);
    return normalizeSystemFonts(faces);
  } finally { clearTimeout(timer); }
}
