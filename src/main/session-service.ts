import { realpathSync } from 'node:fs';
import path from 'node:path';
import { Notification, type BrowserWindow } from 'electron';
import type { Session } from '../shared/types';
import { StateStore } from './store';
import { ExecutionRegistry } from './execution/registry';
import { StructuredExecutions, TerminalExecutions } from './execution/routers';
import { sameConversation } from '../shared/execution';
import { exportSession } from './execution/export-session';
import { Attachments } from './attachments';
import { WorkflowEngine } from './workflows';
import type { WorkspaceQueries } from './workspace-queries';
import { gitWorktreeRoot } from './git';
import { isSessionBusy } from '../shared/session-activity';

import type { Register } from './ipc/registration';
import { registerSessionHandlers } from './ipc/session-handlers';
import { registerChatHandlers } from './ipc/chat-handlers';
import { registerWorkspaceHandlers } from './ipc/workspace-handlers';
import { registerWorkflowHandlers } from './ipc/workflow-handlers';

const BUSY = new Set(['starting','thinking','tool_running','waiting_approval','waiting_input']);

export class SessionService {
  readonly chat: StructuredExecutions;
  readonly runtime: TerminalExecutions;
  readonly workflows: WorkflowEngine;
  private attachments: Attachments;
  private admissions = new Set<string>();
  private lifecycle = new Set<string>();
  private directoryLocks = new Set<string>();
  private notified = new Map<string,string>();
  private stopping = false;
  private maintenance = false;
  constructor(private store: StateStore, readonly execution: ExecutionRegistry,
    private onState: () => void, private getWindow: () => BrowserWindow | null, private queries: WorkspaceQueries) {
    this.attachments = new Attachments(store.directory);
    this.chat = new StructuredExecutions(execution);
    this.runtime = new TerminalExecutions(execution);
    execution.events.subscribe(event => {
      const window = this.getWindow();
      // Large message bodies stay in the paginated journal, not in renderer event queues.
      if (event.type !== 'journal' || !['message', 'text_delta'].includes(event.event.type)) window?.webContents.send('execution:event', event);
      if (event.type === 'session.changed' || event.type === 'identity.changed') this.onState();
      if (event.type === 'terminal.data') window?.webContents.send('terminal:data', event.chunk);
      if (event.type !== 'conversation.changed') return;
      const id = event.identity.sessionId, state = event.taskState;
      window?.webContents.send('chat:changed', id, state);
      const old = this.notified.get(id); this.notified.set(id,state);
      if (old !== state && store.state.settings.notifications && ['waiting_approval','waiting_input','completed','error'].includes(state) && Notification.isSupported()) {
        const session = store.state.sessions.find(s => s.id === id);
        const labels: Record<string,string> = {waiting_approval:'需要批准工具操作',waiting_input:'需要你的回答',completed:'本轮任务已完成',error:'任务遇到错误'};
        const notification = new Notification({title:session?.title ?? 'cc-desk',body:labels[state]});
        notification.on('click',() => this.navigateFromNotification(id));
        notification.show();
      }
    });
    this.workflows = new WorkflowEngine(store.directory,{
      getSession:id => { const s = this.structured(id); if(s.archived) throw new Error('请先取消会话归档。'); this.assertUnlocked(s); return {sessionId:s.id,projectId:s.projectId,cwd:s.cwd,worktree:s.worktree,providerId:s.execution.providerId,executionMode:'structured'}; },
      runStage:(id,prompt,titlePrompt) => this.runChat(id,prompt,[],titlePrompt),
      cancelSession:id => this.chat.interrupt(id),
      onChange:() => this.getWindow()?.webContents.send('workflow:changed')
    });
  }
  private navigateFromNotification(id:string) {
    const exists=this.store.state.sessions.some(session=>session.id===id);
    if(exists)this.select(id);
    const window=this.getWindow();
    if(!window || window.isDestroyed())return;
    // Selection may already equal id. A separate navigation event still clears
    // renderer filters and reveals the requested conversation on every click.
    if(exists && !window.webContents.isDestroyed())window.webContents.send('session:navigate',id);
    if(window.isMinimized())window.restore();
    window.show();window.focus();
  }
  get activeCount() { return this.execution.activeCount; }
  private session(id: string) { return this.execution.getSession(id); }
  private structured(id: string) {
    const s = this.session(id);
    this.execution.structured(id);
    return s;
  }
  private project(id: string) {
    const p = this.store.state.projects.find(p => p.id === id);
    if(!p) throw new Error('项目不存在。'); return p;
  }
  private occupied(id: string) { return this.runtime.has(id) || this.chat.has(id) || this.admissions.has(id); }
  private taskOccupied(id: string) { return this.runtime.has(id) || this.chat.isBusy(id) || this.admissions.has(id) || this.workflows.isSessionBusy(id); }
  private pathKey(value: string): string {
    let current = path.resolve(value);
    const missing: string[] = [];
    for (;;) {
      try {
        const key = path.join(realpathSync.native(current), ...missing);
        return process.platform === 'win32' ? key.toLowerCase() : key;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        const parent = path.dirname(current);
        if (parent === current) throw error;
        missing.unshift(path.basename(current)); current = parent;
      }
    }
  }
  private contains(root: string, target: string) {
    const relative = path.relative(root, target);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  }
  private overlaps(a: string, b: string) { return this.contains(a,b) || this.contains(b,a); }
  private assertDirectoriesUnlocked(keys: string[]) {
    if (keys.some(key => [...this.directoryLocks].some(lock => this.overlaps(key,lock)))) throw new Error('会话或工作目录正在执行管理操作，请稍后重试。');
  }
  private assertUnlocked(session: Session) {
    this.assertAvailable();
    if(this.lifecycle.has(session.id)) throw new Error('会话或工作目录正在执行管理操作，请稍后重试。');
    this.assertDirectoriesUnlocked([this.pathKey(session.cwd)]);
  }
  private assertAvailable() {
    if (this.stopping) throw new Error('工作台正在退出。');
    if (this.maintenance) throw new Error('Claude Code 正在更新，所有工作区暂时断开，请等待更新完成。');
  }
  private async manage<T>(id: string, action: () => T | Promise<T>): Promise<T> {
    this.assertUnlocked(this.session(id));
    if(this.admissions.has(id) || this.workflows.isSessionBusy(id)) throw new Error('请先停止正在执行的任务。');
    this.lifecycle.add(id);
    try { return await action(); } finally { this.lifecycle.delete(id); }
  }
  private worktreeBase(s: Session) { return s.worktreeBase ?? this.project(s.projectId).path; }
  private directorySessions(keys: string[]) {
    return this.store.state.sessions.filter(s => keys.some(key => this.overlaps(key,this.pathKey(s.cwd))));
  }
  private directoriesBusy(keys: string[]) {
    return this.directorySessions(keys).some(s => this.taskOccupied(s.id));
  }
  private idleTerminalBlock(keys: string[]) {
    const occupied = this.directorySessions(keys).filter(s => this.taskOccupied(s.id));
    return occupied.length > 0 && occupied.every(s => this.runtime.has(s.id) && s.kind === 'agent' &&
      s.execution.mode === 'terminal' && s.terminalSync === 'synced' && !isSessionBusy(s) && !this.admissions.has(s.id) && !this.workflows.isSessionBusy(s.id));
  }
  private async releaseIdleDirectories(keys: string[], message: string) {
    if (this.directoriesBusy(keys)) throw new Error(this.idleTerminalBlock(keys) ? '原生 Claude 终端仍打开，请先关闭终端释放工作目录，再创建或管理 worktree。' : message);
    const releases = await Promise.allSettled(this.directorySessions(keys).filter(session=>this.chat.has(session.id)).map(session=>this.chat.stopIdle(session.id)));
    for (const result of releases) if (result.status === 'rejected') throw result.reason;
    // Locks prevent new admissions while exits are pending. Keep a final process
    // check: no Git mutation may run merely because a UI task badge is complete.
    if (this.directorySessions(keys).some(s => this.occupied(s.id) || this.workflows.isSessionBusy(s.id))) throw new Error(message);
  }
  private async worktreeDirectories(s: Session) {
    return [...new Set((await Promise.all([gitWorktreeRoot(this.worktreeBase(s)),gitWorktreeRoot(s.worktree ?? s.cwd)])).map(dir => this.pathKey(dir)))];
  }
  private cleanupDependencies(s: Session) {
    const target = this.pathKey(s.worktree ?? s.cwd);
    return this.store.state.sessions.some(other => other.id !== s.id &&
      (this.contains(target,this.pathKey(other.cwd)) || (other.worktree && other.worktreeBase && this.contains(target,this.pathKey(other.worktreeBase)))));
  }
  /** Keep source and project-local destination locked until the dependent session is saved. */
  async withSessionCreation<T>(cwd: string, isolated: boolean, action: () => Promise<T>, destinationProjectPath?: string): Promise<T> {
    const roots = isolated ? await Promise.all([gitWorktreeRoot(cwd), ...(destinationProjectPath ? [gitWorktreeRoot(destinationProjectPath)] : [])]) : [cwd];
    const keys = [...new Set(roots.map(root => this.pathKey(root)))];
    this.assertDirectoriesUnlocked(keys);
    keys.forEach(key => this.directoryLocks.add(key));
    try {
      if (isolated) await this.releaseIdleDirectories(keys,'请先停止来源工作目录及目标项目目录中的全部会话，再创建独立 worktree。');
      return await action();
    } finally { keys.forEach(key => this.directoryLocks.delete(key)); }
  }
  private async manageWorktree<T>(id:string,action:(s:Session)=>Promise<T>) {
    return this.manage(id,async()=>{
      const s=this.session(id); if(!s.worktree)throw new Error('此会话没有独立 worktree。');
      const keys = await this.worktreeDirectories(s);
      this.assertDirectoriesUnlocked(keys);
      keys.forEach(k=>this.directoryLocks.add(k));
      try{await this.releaseIdleDirectories(keys,'请先停止此 worktree 和来源目录中的全部会话。');return await action(s);}finally{keys.forEach(k=>this.directoryLocks.delete(k));}
    });
  }
  private async reserve(id: string) {
    const assertReady = () => {
      if(this.stopping) throw new Error('工作台正在退出。');
      const session=this.session(id);this.assertUnlocked(session);
      if(session.archived) throw new Error('请先取消会话归档。');
      if(this.store.state.sessions.some(s=>s.id!==id&&sameConversation(s.execution,session.execution)&&this.occupied(s.id)))throw new Error('同一提供方的对话已在另一个会话中运行，请先停止它或创建会话分支。');
      if(this.admissions.has(id)) throw new Error('当前会话操作尚未完成。');
    };
    assertReady();
    const occupiedIds = () => new Set(this.store.state.sessions.filter(s => this.occupied(s.id)).map(s => s.id));
    while (!occupiedIds().has(id) && occupiedIds().size >= this.store.state.settings.maxSessions) {
      const idle = this.store.state.sessions.filter(s => s.id !== id && s.kind === 'agent' && s.execution.mode === 'structured' &&
        this.chat.has(s.id) && !this.taskOccupied(s.id) && !this.lifecycle.has(s.id) &&
        ![...this.directoryLocks].some(key => this.overlaps(key,this.pathKey(s.cwd))))
        .sort((a,b) => a.updatedAt.localeCompare(b.updatedAt))[0];
      if (!idle) throw new Error('已达到最大并发会话数。');
      this.lifecycle.add(idle.id);
      try { await this.chat.stopIdle(idle.id); } finally { this.lifecycle.delete(idle.id); }
      assertReady();
    }
    // Idle eviction awaits process-tree shutdown; another session may have
    // claimed the same native transcript while that wait was in progress.
    assertReady();
    this.admissions.add(id);
  }
  async start(id: string) {
    this.assertAvailable();
    const s = this.session(id);
    if(s.execution.mode === 'structured') return; // Started by first message; no empty model request.
    if(this.chat.has(id)) throw new Error('此会话已由图形化运行器占用。');
    await this.reserve(id);
    try { this.assertAvailable(); await this.runtime.start(id); } finally { this.admissions.delete(id); }
  }
  async stop(id: string) {
    if(this.workflows.isSessionBusy(id)) {
      for(const run of this.workflows.list(id)) if(run.status==='running') await this.workflows.cancel(run.id);
    }
    if(this.session(id).execution.mode==='structured') await this.chat.stop(id); else await this.runtime.stop(id);
  }
  async interrupt(id: string) {
    if(this.workflows.isSessionBusy(id)) {
      for(const run of this.workflows.list(id)) if(run.status === 'running') await this.workflows.cancel(run.id);
      return;
    }
    if(this.session(id).execution.mode === 'structured') await this.chat.interrupt(id); else await this.runtime.interrupt(id);
  }
  private async runChat(id: string, text: string, attachments: string[] = [], titlePrompt?: string) {
    const s = this.structured(id);
    if(s.archived) throw new Error('请先取消会话归档。');
    if(this.runtime.has(id)) throw new Error('此会话已有终端进程。');
    if(BUSY.has(this.chat.taskState(id))) throw new Error('请等待当前回合完成，或先中断。');
    await this.reserve(id);
    try {
      await this.attachments.retain(id,attachments);
      this.assertAvailable();
      const result=await this.chat.send(id,text,attachments,titlePrompt);
      if(result.success) {
        try { await this.attachments.markSent(id,attachments); }
        catch (error) { throw new Error(`本轮任务已完成，但附件草稿状态保存失败；附件副本仍保留，请勿重复执行本轮任务。${error instanceof Error?error.message:String(error)}`); }
      }
      return result;
    }
    finally { this.admissions.delete(id); }
  }
  select(id: string) { if(id) this.session(id); this.store.change(s => {s.selectedSessionId=id;}); this.onState(); }
  register(handle: Register) {
    registerSessionHandlers(handle, {
      store: this.store, chat: this.chat, runtime: this.runtime, workflows: this.workflows, attachments: this.attachments,
      session: id => this.session(id), taskOccupied: id => this.taskOccupied(id), admissionPending: id => this.admissions.has(id),
      manage: (id, action) => this.manage(id, action), select: id => this.select(id), export: id => this.export(id), onState: this.onState,
    });
    registerChatHandlers(handle, {
      chat: this.chat, runtime: this.runtime, workflows: this.workflows, attachments: this.attachments,
      structured: id => this.structured(id), assertUnlocked: session => this.assertUnlocked(session),
      requireCommands: id => { this.execution.require(id, 'commands'); },
      reserve: id => this.reserve(id), releaseAdmission: id => { this.admissions.delete(id); },
      runChat: (id, text, attachments) => this.runChat(id, text, attachments), getWindow: this.getWindow,
    });
    registerWorkspaceHandlers(handle, {
      store: this.store, queries: this.queries, session: id => this.session(id), project: id => this.project(id),
      worktreeDirectories: session => this.worktreeDirectories(session), worktreeBase: session => this.worktreeBase(session),
      directoriesBusy: keys => this.directoriesBusy(keys), idleTerminalBlock: keys => this.idleTerminalBlock(keys),
      cleanupDependencies: session => this.cleanupDependencies(session), manageWorktree: (id, action) => this.manageWorktree(id, action),
      onState: this.onState,
    });
    registerWorkflowHandlers(handle, {
      workflows: this.workflows, structured: id => this.structured(id), assertUnlocked: session => this.assertUnlocked(session),
      hasPendingTask: id => this.admissions.has(id) || BUSY.has(this.chat.taskState(id)), getWindow: this.getWindow,
    });
  }
  private export(id: string) { return exportSession(this.execution, id, this.getWindow()); }
  async shutdown() {
    this.stopping=true;
    const errors:unknown[]=[];
    try { await this.workflows.shutdown(); } catch(error) { errors.push(error); }
    // A persistence failure must not prevent another runtime from terminating.
    // Keep retries live: a later quit attempt must be able to flush after recovery.
    for(const result of await Promise.allSettled([this.execution.shutdown()])) {
      if(result.status==='rejected')errors.push(result.reason);
    }
    if(errors.length)throw new AggregateError(errors,errors.map(error=>error instanceof Error?error.message:String(error)).join('\n'));
  }
  async withDisconnectedWorkspaces<T>(action: () => Promise<T>): Promise<T> {
    this.assertAvailable();
    this.maintenance = true;
    try {
      this.execution.setMaintenance(true);
      // Stop each runner even when another runner cannot save or terminate.
      const results = await Promise.allSettled([this.workflows.disconnectAll(), this.execution.disconnectAll()]);
      const deadline = Date.now() + 10_000;
      while (this.admissions.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      if (results.some(result => result.status === 'rejected') || this.activeCount || this.admissions.size) throw new Error('未能断开全部工作区或保存记录，已取消更新。请检查会话进程、磁盘空间和目录权限后重试。');
      this.store.flush();
      if (this.store.persistenceError) throw new Error('工作区记录尚未成功保存，已取消更新。请检查磁盘空间和目录权限。');
      return await action();
    } finally {
      try { this.execution.setMaintenance(false); }
      finally { this.maintenance = false; this.onState(); }
    }
  }
}
