import { useEffect, useRef, useState } from 'react';
import type { Attachment } from '../shared/types';

/** Submission ends at durable acceptance; the turn continues independently. */
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
    // Keep the accepted draft/attachment identity even if the user edits while
    // IPC is pending or switches to another session before it acknowledges.
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
  return { submitting, submit };
}
