/** 继续会话将已审核的可见文本复制到新会话尚未发送的草稿中。 */
export interface SessionContinuationInput {
  sourceSessionId: string;
  snapshotHash: string;
  messageIds: string[];
  /** 可选的用户编写摘要，不通过后台模型请求生成。 */
  summary?: string;
}
export interface SessionContinuationMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}
export interface SessionContinuationPreview {
  sourceSessionId: string;
  sourceProviderId: string;
  projectId: string;
  snapshotHash: string;
  messages: SessionContinuationMessage[];
  incomplete: boolean;
}
export const CONTINUATION_MESSAGE_LIMIT = 40;
export const CONTINUATION_MESSAGE_BYTES = 8 * 1024;
export const CONTINUATION_TOTAL_BYTES = 64 * 1024;
