import type { ChatSubmission } from '../shared/chat';
import type { Attachment } from '../shared/types';
import type { ChatSubmissionState, PendingChatSubmission } from './chat-submission-state';

/** 发送确认、原稿清理与当前面板反馈有各自的生命周期。 */
export async function runChatSubmission(input: {
  scope: string; state: ChatSubmissionState; submission: PendingChatSubmission;
  paint(): Promise<void>; send(): Promise<ChatSubmission>; isCurrent(): boolean;
  onSent(expected: string): void; onAttachmentsSent(files: Attachment[]): void;
  onAccepted(): void; onError(error: unknown): void; refresh(): Promise<void>;
}): Promise<void> {
  const { scope, state, submission } = input;
  let accepted = false;
  try {
    await input.paint();
    // 反馈绘制期间可能已删除会话或更换其上下文；不向新上下文发送旧请求。
    if (!state.hasInFlight(scope)) return;
    try {
      const receipt = await input.send();
      accepted = state.accepted(scope, submission.requestId, receipt.messageId);
    } catch (error) {
      state.failed(scope, submission.requestId, error instanceof Error ? error.message : String(error));
      // 队列先到已经证明持久接收时，丢失 ACK 不应留下可再次提交的原稿。
      accepted = state.isObserved(scope, submission.requestId) && state.accepted(scope, submission.requestId);
      if (!accepted && input.isCurrent()) input.onError(error);
    }
    if (accepted) {
      input.onSent(submission.draft);
      input.onAttachmentsSent(submission.files);
      if (input.isCurrent()) input.onAccepted();
    }
  } catch (error) {
    if (!accepted) state.failed(scope, submission.requestId, error instanceof Error ? error.message : String(error));
    if (input.isCurrent()) input.onError(error);
  } finally {
    if (input.isCurrent()) void input.refresh().catch(error => { if (input.isCurrent()) input.onError(error); });
  }
}
