import type { NativeImageAttachment } from '@cc-desk/contracts/chat';

export const NATIVE_IMAGE_MAX_COUNT = 4;
export const NATIVE_IMAGE_MAX_BYTES = 1024 * 1024;

/** Bytes from an explicit editor paste event, never a clipboard read request. */
export interface NativePastedImage {
  mimeType: 'image/png' | 'image/jpeg';
  dataUrl: string;
}

/** Explicit local view only; never part of a model submission or chat snapshot. */
export type NativeImagePreviewRequest = {
  sessionId: string;
  conversationId: string;
  source: { kind: 'draft'; path: string } | { kind: 'history'; runId: string; index: number; sha256: string };
};

export interface NativeImagePreview {
  image: NativeImageAttachment;
  dataUrl: string;
}
