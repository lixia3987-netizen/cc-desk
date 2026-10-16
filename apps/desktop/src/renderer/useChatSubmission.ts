import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { Attachment } from '../shared/types';
import type { ChatSnapshot } from '../shared/chat';
import { paintActionFeedback } from './action-feedback';
import { chatSubmissionState, visibleChatSubmissions } from './chat-submission-state';
import { runChatSubmission } from './chat-submission-runner';

/** 接收前保留草稿，接收后保留消息反馈，直到持久队列或正式用户消息接管。 */
export function useChatSubmission({ sessionId, conversationId, snapshot, draft, attachments, nativeTaskId, disabled, isBlocked, onSubmitting, onAccepted, onSent, onAttachmentsSent, onError, refresh }: {
  sessionId: string; conversationId?: string; snapshot?: Pick<ChatSnapshot, 'queue' | 'messages'>;
  draft: string; attachments: Attachment[]; disabled: boolean;
  nativeTaskId?: string;
  isBlocked?: () => boolean;
  onSubmitting?: () => void;
  onAccepted: () => void; onSent: (expectedDraft: string) => void;
  onAttachmentsSent: (files: Attachment[]) => void; onError: (error: unknown) => void;
  refresh: () => Promise<void>;
}) {
  const key = JSON.stringify([sessionId, conversationId ?? '']);
  const read = useCallback(() => chatSubmissionState.getSnapshot(key), [key]);
  const records = useSyncExternalStore(chatSubmissionState.subscribe, read, read);
  const mounted = useRef(true), currentScope = useRef(key);
  currentScope.current = key;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { chatSubmissionState.reconcile(key, snapshot?.queue, snapshot?.messages); }, [key, snapshot?.queue, snapshot?.messages]);

  const submit = async () => {
    if (disabled || isBlocked?.() || chatSubmissionState.hasInFlight(key) || (!draft.trim() && !attachments.length)) return;
    if (draft.length > 60000) { onError(new Error('单次提示词请控制在 60,000 个字符以内。')); return; }
    const submission = chatSubmissionState.begin(key, draft, attachments, nativeTaskId);
    if (!submission) return;
    onSubmitting?.();
    await runChatSubmission({ scope: key, state: chatSubmissionState, submission,
      paint: paintActionFeedback,
      send: () => window.desktop.submitChat(sessionId, submission.text, submission.files.map(file => file.path), submission.requestId, { nativeTaskId: submission.nativeTaskId }),
      isCurrent: () => mounted.current && currentScope.current === key,
      onSent, onAttachmentsSent, onAccepted, onError, refresh });
  };
  return { submitting: chatSubmissionState.hasInFlight(key), submissions: visibleChatSubmissions(records, snapshot?.queue, snapshot?.messages), submit,
    isSubmitting: () => chatSubmissionState.hasInFlight(key) };
}
