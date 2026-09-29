import { z } from 'zod';
import type { Register } from './registration';
import type { NativeImagePreviewHost } from '../native-image-preview';

export function registerNativeImageHandlers(handle: Register, previews: Pick<NativeImagePreviewHost, 'preview'>): void {
  // The host applies its strict schema and returns a fixed error. Passing raw
  // Zod diagnostics through the IPC wrapper could echo untrusted supplied data.
  handle('native:image-preview', z.unknown(), request => previews.preview(request));
}
