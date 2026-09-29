import { useEffect, useState } from 'react';
import { Dialog } from '../Dialog';
import { NativeImagePreviewBody } from '../NativeImagePreview';
import { NewSessionImagePreviewController, newSessionImagePreviewKey, scheduleNewSessionImagePreview, type NewSessionImagePreviewSelection, type NewSessionImagePreviewState } from './new-session-image-preview-state';

export function NewSessionImagePreview({ selection, onClose }: { selection: NewSessionImagePreviewSelection; onClose: () => void }) {
  const [state, setState] = useState<NewSessionImagePreviewState>({ status: 'idle' });
  const [controller] = useState(() => new NewSessionImagePreviewController(request => window.desktop.previewDraftNativeImage(request), setState));
  const key = newSessionImagePreviewKey(selection);
  useEffect(() => scheduleNewSessionImagePreview(controller, selection), [controller, key]);
  const current = state.status !== 'idle' && newSessionImagePreviewKey(state.selection) === key ? state : undefined;
  const close = () => { controller.close(); onClose(); };
  return <Dialog label="图片预览" className="native-image-preview" onClose={close}>
    <NativeImagePreviewBody name={selection.file.name} bytes={selection.file.bytes} versionLabel="当前选择版本（本地预览）" state={current}
      onClose={close} onRetry={() => { void controller.retry(); }} onDecodeError={version => controller.decodeFailed(version)}/>
  </Dialog>;
}
