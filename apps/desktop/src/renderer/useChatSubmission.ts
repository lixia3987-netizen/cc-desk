import { useEffect, useRef, useState } from 'react';
import type { Attachment } from '../shared/types';

/** 消息被持久接收后，提交即完成；当前轮次独立继续执行。 */
export function useChatSubmission({ sessionId, draft, attachments, nativeTaskId, disabled, isBlocked, onAccepted, onSent, onAttachmentsSent, onError, refresh }: {
  sessionId: string; draft: string; attachments: Attachment[]; disabled: boolean;
  nativeTaskId?: string;
  isBlocked?: () => boolean;
  onAccepted: () => void; onSent: (expectedDraft: string) => void;
  onAttachmentsSent: (files: Attachment[]) => void; onError: (error: unknown) => void;
  refresh: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false), mounted = useRef(true);
  const retry = useRef<{ draft: string; files: Attachment[]; requestId: string; nativeTaskId?: string } | undefined>(undefined);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const submit = async () => {
    if (disabled || isBlocked?.() || inFlight.current || (!draft.trim() && !attachments.length)) return;
    if (draft.length > 60000) { onError(new Error('单次提示词请控制在 60,000 个字符以内。')); return; }
    // 即使用户在 IPC 等待期间编辑内容，或在收到确认前
    // 切换到其他会话，也要保留已接收草稿与附件的标识。
    const submittedDraft = draft, submittedFiles = [...attachments], submittedTaskId = nativeTaskId;
    if (!retry.current || retry.current.draft !== submittedDraft || retry.current.nativeTaskId !== submittedTaskId || retry.current.files.length !== submittedFiles.length
      || retry.current.files.some((file, index) => file.path !== submittedFiles[index].path)) {
      retry.current = { draft: submittedDraft, files: submittedFiles, requestId: crypto.randomUUID(), nativeTaskId: submittedTaskId };
    }
    const requestId = retry.current.requestId;
    inFlight.current = true; setSubmitting(true);
    try {
      await window.desktop.submitChat(sessionId, submittedDraft.trim(), submittedFiles.map(file => file.path), requestId, { nativeTaskId: submittedTaskId });
      retry.current = undefined;
      onSent(submittedDraft);
      onAttachmentsSent(submittedFiles);
      if (mounted.current) onAccepted();
    } catch (error) { onError(error); }
    finally {
      inFlight.current = false;
      if (mounted.current) { setSubmitting(false); void refresh().catch(onError); }
    }
  };
  return { submitting, submit, isSubmitting: () => inFlight.current };
}
