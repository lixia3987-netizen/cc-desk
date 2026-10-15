import { z } from 'zod';
import type { Register } from './registration';
import type { NativeImagePreviewHost } from '../native-image-preview';

export function registerNativeImageHandlers(handle: Register, previews: Pick<NativeImagePreviewHost, 'preview'>): void {
  // 宿主应用严格模式并返回固定错误。若经 IPC 包装器传出原始
  // Zod 诊断，可能回显不可信的输入数据。
  handle('native:image-preview', z.unknown(), request => previews.preview(request));
}
