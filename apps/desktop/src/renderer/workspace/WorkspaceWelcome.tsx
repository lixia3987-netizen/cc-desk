import { ArrowUpRight, GitBranch, History, Layers, Plus, ShieldCheck, TerminalSquare } from 'lucide-react';
import { version as appVersion } from '../../../package.json';

import type { OpenNew } from './types';

interface Props {
  hasProjects: boolean; historyAvailable: boolean; openNew: OpenNew; chooseProject: () => Promise<void>; openHistory: () => Promise<void>;
}

export function WorkspaceWelcome({ hasProjects, historyAvailable, openNew, chooseProject, openHistory }: Props) {
  return <div className="welcome">
    <div className="eyebrow">
      <span />LOCAL FIRST · BUILT FOR FOCUS</div>
    <h1>让每个想法，<br />
      <em>都有一个工作空间。</em>
    </h1>
    <p>在独立会话中运行 Claude Code。保留你的终端、工具和上下文，<br />把注意力放在正在构建的东西上。</p>
    <div className="welcome-actions">
      <button className="primary" onClick={() => hasProjects ? openNew() : void chooseProject()}>
        <Plus size={17} />{hasProjects ? '开始新会话' : '添加第一个项目'}<ArrowUpRight size={16} />
      </button>
      <button className="secondary" disabled={!historyAvailable} onClick={() => void openHistory()}>
        <History size={16} />恢复已有会话</button>
    </div>
    <div className="feature-grid">
      <article>
        <Layers size={23} />
        <h3>各有上下文</h3>
        <p>项目分组与多会话切换，<br />随时继续之前的工作。</p>
        <span>01 / SESSIONS</span>
      </article>
      <article>
        <TerminalSquare size={23} />
        <h3>熟悉的 Claude Code</h3>
        <p>真实交互式终端，保留审批、<br />MCP、命令与登录方式。</p>
        <span>02 / NATIVE CLI</span>
      </article>
      <article>
        <GitBranch size={23} />
        <h3>放心探索分支</h3>
        <p>可选 Git worktree，<br />让并行任务拥有独立目录。</p>
        <span>03 / ISOLATION</span>
      </article>
    </div>
    <div className="welcome-foot">
      <ShieldCheck size={15} />凭据和模型连接由本机 Claude Code 管理。<span>WORKBENCH / v{appVersion}</span>
    </div>
  </div>;
}
