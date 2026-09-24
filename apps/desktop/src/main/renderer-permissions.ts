import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function isTrustedRendererUrl(value: string, rendererFile: string, devUrl?: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return devUrl ? url.origin === devUrl : url.protocol === 'file:' && path.resolve(fileURLToPath(url)) === path.resolve(rendererFile);
  } catch { return false; }
}

export function allowsLocalFonts(permission: string, sameWindow: boolean, details: {isMainFrame: boolean; requestingUrl?: string}, rendererFile: string, devUrl?: string): boolean {
  return permission === 'local-fonts' && sameWindow && details.isMainFrame && isTrustedRendererUrl(details.requestingUrl ?? '', rendererFile, devUrl);
}
