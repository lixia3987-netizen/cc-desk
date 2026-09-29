import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { Dialog } from './Dialog';
import { NativeImagePreviewController, nativeImagePreviewKey, scheduleNativeImagePreview, type NativeImagePreviewSelection, type NativeImagePreviewState } from './native-image-preview-state';

/** Kept separate from the portal so every visible state has a direct render test. */
export function NativeImagePreviewContent({ selection, state, onClose, onRetry, onDecodeError }: {
  selection: NativeImagePreviewSelection; state: NativeImagePreviewState;
  onClose: () => void; onRetry: () => void; onDecodeError: (version: number) => void;
}) {
  const current = state.status !== 'idle' && nativeImagePreviewKey(state.selection) === nativeImagePreviewKey(selection) ? state : undefined;
  const versionLabel = selection.request.source.kind === 'draft' ? '当前暂存版本' : '发送时的图片版本';
  return <>
    <div className="modal-title"><h2>图片预览</h2><button className="icon-button" aria-label="关闭图片预览" onClick={onClose}><X size={18}/></button></div>
    <p className="native-image-preview-description"><strong>{selection.expected.name}</strong><br/>{versionLabel} · {(selection.expected.bytes / 1024).toFixed(1)} KiB · 仅本地查看</p>
    <div className="native-image-preview-area" aria-busy={!current || current.status === 'loading'}>
      {current?.status === 'ready' ? <img key={current.version} src={current.preview.dataUrl} alt={`${current.preview.image.name}（${versionLabel}）`} draggable={false} decoding="async" onError={() => onDecodeError(current.version)}/>
        : current?.status === 'error' ? <div className="native-image-preview-error"><p role="alert">{current.message}</p><button className="secondary compact" onClick={onRetry}>重试预览</button></div>
          : <p role="status"><Loader2 size={18} className="spin"/> 正在读取图片…</p>}
    </div>
  </>;
}

export function NativeImagePreview({ selection, onClose }: { selection: NativeImagePreviewSelection; onClose: () => void }) {
  const [state, setState] = useState<NativeImagePreviewState>({ status: 'idle' });
  const [controller] = useState(() => new NativeImagePreviewController(request => window.desktop.previewNativeImage(request), setState));
  const key = nativeImagePreviewKey(selection);
  useEffect(() => scheduleNativeImagePreview(controller, selection), [controller, key]);
  const close = () => { controller.close(); onClose(); };
  return <Dialog label="图片预览" className="native-image-preview" onClose={close}>
    <NativeImagePreviewContent selection={selection} state={state} onClose={close} onRetry={() => { void controller.retry(); }} onDecodeError={version => controller.decodeFailed(version)}/>
  </Dialog>;
}
