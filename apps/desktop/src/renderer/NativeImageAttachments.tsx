import { Image, Paperclip, X } from 'lucide-react';
import type { NativeImageAttachment } from '../shared/chat';
import type { Attachment } from '../shared/types';

const size = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;
const selectedType = (name: string) => /\.png$/i.test(name) ? 'PNG' : /\.jpe?g$/i.test(name) ? 'JPEG' : '不支持的格式';

export function NativeImageNotice() {
  return <p className="panel-note native-image-notice">Native 仅支持 PNG / JPEG，最多 4 张，合计不超过 1 MiB，每边不超过 4096 像素。可在输入框按 Ctrl / ⌘ + V 粘贴图片；不会自动读取剪贴板。选中的图片点击发送后才会交给模型，并保存在本机会话及原始记录中。服务的图片能力尚未验证。图片按编码字节保守计入输入预算，较大图片可能需要提高输入预算。压缩仅处理首个含图回合之前的纯文本历史；首个含图回合及之后的记录完整保留。首轮就含图或保留内容超预算时，压缩无法释放所需空间。</p>;
}

/** Read-only receipt: never resolves a historical filename into a filesystem URL. */
export function NativeImageAttachments({ images, onPreview }: { images: NativeImageAttachment[]; onPreview?: (index: number, image: NativeImageAttachment) => void }) {
  return <section className="native-image-history" aria-label="已提交图片记录">
    <ul>{images.map((image, index) => <li key={`${index}:${image.sha256}`}>
      <Paperclip size={12}/><strong>{image.name}</strong> · {image.mimeType === 'image/png' ? 'PNG' : 'JPEG'} · {size(image.bytes)}
      {onPreview && <button className="text-button native-image-preview-button" aria-label={'预览已发送图片 ' + image.name} onClick={() => onPreview(index, image)}><Image size={13}/>预览</button>}
      <details><summary>查看记录哈希</summary><code>SHA-256 {image.sha256}</code></details>
    </li>)}</ul>
    <p className="panel-note">以上是本次提交时的图片版本信息；不会读取原文件的后续变化。会话导出仅包含这些信息，不包含图像内容。</p>
  </section>;
}

export function ChatAttachmentChips({ attachments, isNative, disabled, onRemove, onPreview }: {
  attachments: Attachment[]; isNative: boolean; disabled: boolean; onRemove: (path: string) => void; onPreview?: (file: Attachment) => void;
}) {
  if (!attachments.length) return null;
  return <div className="attachment-chips">{attachments.map(file => <span key={file.path} title={isNative ? file.name : file.path}>
    <Paperclip size={12}/>{file.name}{isNative && ` · ${selectedType(file.name)} · ${size(file.bytes)}`}
    {isNative && onPreview && <button className="icon-button" aria-label={'预览待发送图片 ' + file.name} title="本地预览当前暂存版本" disabled={disabled} onClick={() => onPreview(file)}><Image size={13}/></button>}
    <button className="icon-button" aria-label={'移除附件 ' + file.name} disabled={disabled} onClick={() => onRemove(file.path)}><X size={12}/></button>
  </span>)}</div>;
}
