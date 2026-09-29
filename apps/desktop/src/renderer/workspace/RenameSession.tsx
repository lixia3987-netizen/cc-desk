import { useState } from 'react';
import type { Session } from '../../shared/types';

interface Props {
  target: Session;
  busy: boolean;
  error?: string;
  onSave: (title: string) => Promise<void>;
  onClose: () => void;
}

export function RenameSession({ target, busy, error, onSave, onClose }: Props) {
  const [rename, setRename] = useState(target.title);
  return <>
    <h2>重命名会话</h2>
    <p className="panel-note session-action-target">会话：{target.title}</p>
    <form onSubmit={event => { event.preventDefault(); if (!busy && rename.trim()) void onSave(rename.trim()); }}>
      <label>名称<input aria-label="新的会话名称" autoFocus maxLength={120} value={rename} disabled={busy} onChange={event => setRename(event.target.value)} /></label>
      {error && <p className="chat-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button className="secondary" type="button" disabled={busy} onClick={onClose}>取消</button>
        <button className="primary" disabled={busy || !rename.trim()}>{busy ? '正在保存…' : '保存'}</button>
      </div>
    </form>
  </>;
}
