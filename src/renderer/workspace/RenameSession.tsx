import { X } from 'lucide-react';
import type { Session } from '../../shared/types';

import type { Perform } from './types';

interface Props {
  active: Session; rename: string; setRename: (value: string) => void;
  structured: boolean; activeBusy: boolean; busy: boolean; perform: Perform; onClose: () => void;
}

export function RenameSession({ active, rename, setRename, structured, activeBusy, busy, perform, onClose }: Props) {
  return <>
    <h2>重命名会话</h2>
    <form onSubmit={event => { event.preventDefault(); void perform(async () => { await window.desktop.updateSession({ id: active.id, title: rename }); onClose(); }); }}>
      <label>名称<input aria-label="新的会话名称" autoFocus maxLength={120} value={rename} onChange={e => setRename(e.target.value)} />
      </label>
      <button className="primary full" disabled={busy || !rename.trim()}>保存</button>
    </form>{structured && active.status === 'running' && !activeBusy && <button className="secondary full" disabled={busy} title="释放空闲 CLI 进程，保留会话记录；下次发送时自动恢复" onClick={() => void perform(async () => { await window.desktop.stopSession(active.id); onClose(); })}>
      <X size={14} />关闭空闲会话进程</button>}</>;
}
