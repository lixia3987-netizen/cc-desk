import type { NativeImageAttachment } from '@cc-desk/contracts/chat';

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
