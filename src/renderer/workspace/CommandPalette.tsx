import { ChevronRight } from 'lucide-react';
import type { AppState, Session } from '../../shared/types';

import type { OpenNew } from './types';

interface Props {
  state: AppState; paletteQuery: string; setPaletteQuery: (value: string) => void;
  openNew: OpenNew; openHistory: () => Promise<void>; onSettings: () => void; onSelect: (session: Session) => void;
}

export function CommandPalette({ state, paletteQuery, setPaletteQuery, openNew, openHistory, onSettings, onSelect }: Props) {
  return <>
    <div className="eyebrow">COMMAND PALETTE</div>
    <h2>快速切换</h2>
    <input aria-label="查找命令与会话" autoFocus placeholder="查找会话或操作…" value={paletteQuery} onChange={e => setPaletteQuery(e.target.value)} />
    <div className="palette-results">{['新建会话', '导入 CLI 历史', '设置与连接'].filter(name => name.includes(paletteQuery)).map(name =>
      <button key={name} onClick={() => { if (name === '新建会话') openNew(); else if (name === '导入 CLI 历史') void openHistory(); else { onSettings(); } }}>{name}<ChevronRight size={14} />
      </button>)}{state.sessions.filter(s => (s.title + ' ' + s.cwd).toLowerCase().includes(paletteQuery.toLowerCase())).map(s =>
        <button key={s.id} onClick={() => { onSelect(s); }}>
          <span>{s.title}<small>{s.cwd}</small>
          </span>
          <ChevronRight size={14} />
        </button>)}</div>
  </>;
}
