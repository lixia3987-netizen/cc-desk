import { ArrowUpRight, History } from 'lucide-react';
import type { AppState, HistoryEntry, NewSession } from '../../shared/types';
import { PermissionModeField } from '../PermissionModeField';

import type { Dispatch, SetStateAction } from 'react';
import { time } from './presentation';

interface Props {
  state: AppState; draft: NewSession; setDraft: Dispatch<SetStateAction<NewSession>>; busy: boolean;
  historyQuery: string; setHistoryQuery: (value: string) => void; history: HistoryEntry[]; historyBusy: boolean;
  historyNext: number | null; importHistory: (id: string, title: string) => Promise<void>; moreHistory: () => Promise<void>;
}

export function HistoryImport({ state, draft, setDraft, busy, historyQuery, setHistoryQuery, history, historyBusy, historyNext, importHistory, moreHistory }: Props) {
  return <>
    <div className="eyebrow">CONTINUE YOUR WORK</div>
    <h2>导入 CLI 历史</h2>
    <p>{state.projects.find(p => p.id === draft.projectId)?.name} · 最近的本地会话</p>
    <PermissionModeField label="导入会话权限模式" value={draft.permissionMode ?? 'default'} disabled={busy} onChange={permissionMode => setDraft({ ...draft, permissionMode })} />
    <input aria-label="搜索历史全文" placeholder="搜索标题和对话内容…" value={historyQuery} onChange={e => setHistoryQuery(e.target.value)} />
    <div className="history-list">{historyBusy ? <p>正在读取 Claude 历史…</p> : history.length ? history.map(h =>
      <button key={h.id} disabled={busy} onClick={() => void importHistory(h.id, h.title)}>
        <div>
          <strong>{h.title}</strong>
          <small>{time(h.modifiedAt)} · {h.id.slice(0, 8)}</small>
        </div>
        <ArrowUpRight size={16} />
      </button>) : <p>没有找到可导入的记录。也可以使用会话 UUID。</p>}</div>{historyNext !== null && !historyBusy && <button className="secondary compact full" disabled={busy} onClick={() => void moreHistory()}>加载更多历史</button>}<form onSubmit={event => { event.preventDefault(); void importHistory(draft.conversationId || '', `导入会话 · ${(draft.conversationId || '').slice(0, 8)}`); }}>
      <label>通过 UUID 导入<input aria-label="历史会话 UUID" placeholder="00000000-0000-0000-0000-000000000000" value={draft.conversationId || ''} onChange={e => setDraft({ ...draft, conversationId: e.target.value })} />
      </label>
      <button className="primary full" disabled={busy || !draft.conversationId}>
        <History size={15} />导入会话</button>
    </form>
    <p className="hint">只读扫描 CLI 记录。导入不会修改原始历史；首次恢复时会由 Claude Code 校验。</p>
  </>;
}
