import type { NativeImageAttachment } from '@cc-desk/contracts/chat';

export const NATIVE_IMAGE_MAX_COUNT = 4;
export const NATIVE_IMAGE_MAX_BYTES = 1024 * 1024;

/** 字节数据来自明确的编辑器粘贴事件，不来自剪贴板读取请求。 */
export interface NativePastedImage {
  mimeType: 'image/png' | 'image/jpeg';
  dataUrl: string;
}

/** 仅用于明确的本地查看，不加入模型提交或聊天快照。 */
export type NativeImagePreviewRequest = {
  sessionId: string;
  conversationId: string;
  source: { kind: 'draft'; path: string } | { kind: 'history'; runId: string; index: number; sha256: string };
};

export interface NativeImagePreview {
  image: NativeImageAttachment;
  dataUrl: string;
}
