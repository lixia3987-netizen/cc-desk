import { ArrowUpRight, History } from 'lucide-react';
import type { AppState, HistoryEntry } from '../../shared/types';
import type { ExecutionDescriptor } from '../../shared/execution';
import { EngineConfigFields, configurationSupported, engineDefaults } from '../EngineConfiguration';
import type { Dispatch, SetStateAction } from 'react';
import { time } from './presentation';
import type { SessionDraft } from './types';

interface Props {
  state: AppState; executors: ExecutionDescriptor[]; draft: SessionDraft; setDraft: Dispatch<SetStateAction<SessionDraft>>; busy: boolean;
  historyQuery: string; setHistoryQuery(value: string): void; history: HistoryEntry[]; historyBusy: boolean;
  historyNext: number | null; importHistory(id: string, title: string, providerId?: string): Promise<void>; moreHistory(): Promise<void>;
}

export function HistoryImport({ state, executors, draft, setDraft, busy, historyQuery, setHistoryQuery, history, historyBusy, historyNext, importHistory, moreHistory }: Props) {
  const sources = [...new Map(executors.filter(item => item.history).map(item => [item.providerId, item])).values()];
  const descriptor = executors.find(item => item.providerId === draft.providerId && item.mode === draft.mode && item.history);
  const claude = draft.providerId === 'claude';
  const blocked = busy || !descriptor || !!descriptor.maintenance || !configurationSupported(descriptor, draft.engineConfig);
  const name = descriptor?.displayName ?? draft.providerId;
  return <>
    <div className="eyebrow">CONTINUE YOUR WORK</div>
    <h2>{claude ? '导入 CLI 历史' : '导入引擎历史'}</h2>
    <p>{state.projects.find(p => p.id === draft.projectId)?.name} · 最近的本地会话</p>
    {sources.length > 1 && <label>历史来源<select aria-label="历史来源" disabled={busy} value={draft.providerId} onChange={event => {
      const source = executors.find(item => item.providerId === event.target.value && item.history && item.mode === 'structured') ?? sources.find(item => item.providerId === event.target.value);
      if (source) setDraft({ ...draft, providerId: source.providerId, mode: source.mode, conversationId: undefined, engineConfig: engineDefaults(source, state.settings) });
    }}>{sources.map(source => <option key={source.providerId} value={source.providerId}>{source.displayName ?? source.providerId}</option>)}</select></label>}
    <EngineConfigFields value={draft.engineConfig} fields={descriptor?.configuration?.fields ?? []} prefix="导入会话" disabled={blocked} onChange={engineConfig => setDraft({ ...draft, engineConfig })} />
    {descriptor?.maintenance && <p className="hint">{name} 正在维护，完成后可以导入。</p>}
    <input aria-label="搜索历史全文" placeholder="搜索标题和对话内容…" value={historyQuery} onChange={e => setHistoryQuery(e.target.value)} />
    <div className="history-list">{historyBusy && !history.length ? <p>正在读取 {name} 历史…</p> : history.length ? history.map(h =>
      <button key={JSON.stringify([h.providerId, h.id])} disabled={blocked || h.providerId !== draft.providerId} onClick={() => void importHistory(h.id, h.title, h.providerId)}>
        <div><strong>{h.title}</strong><small>{time(h.modifiedAt)} · {h.id.slice(0, 8)}</small></div><ArrowUpRight size={16} />
      </button>) : <p>没有找到可导入的记录。也可以使用会话{claude ? ' UUID' : ' ID'}。</p>}</div>
    {historyNext !== null && <button className="secondary compact full" disabled={busy || historyBusy} onClick={() => void moreHistory()}>加载更多历史</button>}
    <form onSubmit={event => { event.preventDefault(); if (!blocked) void importHistory(draft.conversationId || '', `导入会话 · ${(draft.conversationId || '').slice(0, 8)}`, draft.providerId); }}>
      <label>通过{claude ? ' UUID' : '会话 ID'}导入<input aria-label={claude ? '历史会话 UUID' : '历史会话 ID'} placeholder={claude ? '00000000-0000-0000-0000-000000000000' : '原始会话标识'} value={draft.conversationId || ''} onChange={e => setDraft({ ...draft, conversationId: e.target.value })} /></label>
      <button className="primary full" disabled={blocked || !draft.conversationId}><History size={15} />导入会话</button>
    </form>
    <p className="hint">只读扫描{name}记录。导入不会修改原始历史；首次恢复时会由{name}校验。</p>
  </>;
}
