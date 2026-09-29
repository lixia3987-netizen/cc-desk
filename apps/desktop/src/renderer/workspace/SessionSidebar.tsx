import { Archive, ChevronRight, Command, Folder, GitBranch, History, Plus, Search, Settings2, TerminalSquare } from 'lucide-react';
import { useCallback, useState } from 'react';
import { SessionActions, type SessionActionHandlers, type SessionMenuTarget } from './SessionActions';
import type { AppState, Capabilities, Session } from '../../shared/types';

import { sessionColor, sessionLabel, time } from './presentation';
import type { OpenNew } from './types';
import { ProjectFilter } from './ProjectFilter';

interface Props extends SessionActionHandlers {
  state: AppState; cap: Capabilities; historyAvailable: boolean; chooseProject?: () => Promise<void>; activeId: string; projectId: string;
  archived: boolean; search: string; collapsedGroups: Set<string>;
  openNew: OpenNew; selectSession: (id: string) => void;
  onSearch: (value: string) => void; onProject: (id: string) => void;
  toggleGroup: (id: string) => void; setArchived: (value: boolean) => void;
  openHistory: () => Promise<void>; onSettings: () => void;
}

export function SessionSidebar({ state, cap, historyAvailable, chooseProject: _chooseProject, activeId, projectId, archived, search, collapsedGroups, openNew, selectSession, onSearch, onProject, toggleGroup, setArchived, openHistory, onSettings, ...actions }: Props) {
  const [menu, setMenu] = useState<SessionMenuTarget>();
  const closeMenu = useCallback(() => setMenu(undefined), []);
  const projectsById = new Map(state.projects.map(project => [project.id, project]));
  const query = search.trim().toLowerCase();
  const sessions = state.sessions.filter(s => s.archived === archived && (projectId === 'all' || s.projectId === projectId) && `${s.title} ${s.cwd} ${projectsById.get(s.projectId)?.name ?? ''}`.toLowerCase().includes(query)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const groupedSessions = new Map<string, Session[]>();
  for (const session of sessions) { const group = groupedSessions.get(session.projectId) ?? []; group.push(session); groupedSessions.set(session.projectId, group); }
  const groupIds = [...projectsById.keys(), ...Array.from(groupedSessions.keys()).filter(id => !projectsById.has(id))];
  const sessionGroups = groupIds.filter(id => (projectId === 'all' || projectId === id) && groupedSessions.has(id)).map(id => ({ id, project: projectsById.get(id), sessions: groupedSessions.get(id) ?? [] }));

  return <aside className="sidebar">
    <div className="brand">
      <div className="brand-icon">
        <Command size={21} />
      </div>
      <div>Claude Workbench<small>你的本地开发工作台</small>
      </div>
      <span className="version">02</span>
    </div>
    <button className="primary new-button" onClick={() => openNew()}>
      <Plus size={16} />新建会话<span>＋</span>
    </button>
    <div className="search">
      <Search size={15} />
      <input aria-label="搜索会话" placeholder="搜索项目或会话…" value={search} onChange={e => { onSearch(e.target.value); }} />
    </div>
    <div className="section-label">工作空间</div>
    {!!state.projects.length && <ProjectFilter projects={state.projects} value={projectId} onChange={onProject} />}
    <div className="section-label sessions-label">
      <span>{archived ? '归档会话' : '最近会话'} <small>{sessions.length}</small>
      </span>
      <button className={`icon-button ${archived ? 'mint' : ''}`} title={archived ? '查看活跃会话' : '查看归档'} onClick={() => setArchived(!archived)}>
        <Archive size={15} />
      </button>
    </div>
    <div className="session-list">
      {sessionGroups.map(group => {
        const name = group.project?.name ?? '原项目已移除', expanded = !collapsedGroups.has(group.id); return <section key={group.id} className="session-group" data-project-id={group.id} aria-label={name + '的会话'}>
          <div className="project-group-header">
            <button className="project-group-toggle" title={group.project?.path ?? group.sessions[0]?.cwd} aria-expanded={expanded} aria-controls={'sessions-' + group.id} onClick={() => toggleGroup(group.id)}>
              <ChevronRight size={13} className="group-chevron" />
              <Folder size={14} />
              <span>{name}</span>
              <small>{group.sessions.length}</small>
            </button>{group.project && <button className="icon-button group-create" aria-label={'在「' + name + '」中创建会话'} title="在此项目创建会话" onClick={() => openNew('agent', undefined, group.id)}>
              <Plus size={14} />
            </button>}</div>
          <div id={'sessions-' + group.id} className="project-sessions" hidden={!expanded}>
            {group.sessions.map(s =>
              <button key={s.id} data-session-id={s.id} title={s.title} aria-current={activeId === s.id ? 'page' : undefined}
                aria-haspopup="menu" aria-expanded={menu?.sessionId === s.id} className={`session-row ${activeId === s.id ? 'active' : ''}`}
                onClick={() => selectSession(s.id)}
                onContextMenu={event => {
                  event.preventDefault(); event.stopPropagation();
                  setMenu({ sessionId: s.id, archived: s.archived, worktreePath: s.worktree, x: event.clientX, y: event.clientY, opener: event.currentTarget });
                }}
                onKeyDown={event => {
                  if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
                  event.preventDefault(); event.stopPropagation();
                  const bounds = event.currentTarget.getBoundingClientRect();
                  setMenu({ sessionId: s.id, archived: s.archived, worktreePath: s.worktree, x: bounds.left + 16, y: bounds.bottom, opener: event.currentTarget });
                }}>
                <div className="session-row-icon">{s.kind === 'shell' ? <TerminalSquare size={15} /> : <span className={`dot ${sessionColor(s)}`} />}</div>
                <div>
                  <strong>{s.title}</strong>
                  <small>{actions.executors.find(item => item.providerId === s.execution.providerId && item.mode === s.execution.mode)?.displayName ?? s.execution.providerId}<span>·</span>{sessionLabel(s)}<span>·</span>{time(s.updatedAt)}</small>
                </div>{s.worktree && <GitBranch size={13} />}
              </button>)}
          </div>
        </section>;
      })}
      {!sessionGroups.length && <div className="list-empty">{query ? '没有匹配的会话' : archived ? '暂无归档会话' : '从一个新会话开始。'}</div>}
    </div>
    <div className="sidebar-bottom">
      <button disabled={!historyAvailable} onClick={() => void openHistory()}>
        <History size={16} />{actions.executors.some(item => item.history && item.providerId !== 'claude') ? '导入引擎历史' : '导入 CLI 历史'}<ChevronRight size={14} />
      </button>
      <button onClick={() => { onSettings(); }}>
        <Settings2 size={16} />设置与连接<ChevronRight size={14} />
      </button>
      <div className="local-status">
        <span className={`dot ${cap.available ? 'running' : 'stopped'}`} />{cap.available ? 'Claude Code 已安装' : '未检测到 Claude Code'}<span>本地</span>
      </div>
    </div>
    <SessionActions {...actions} sessions={state.sessions} projects={state.projects} menu={menu} onCloseMenu={closeMenu} openNew={openNew} />
  </aside>;
}
