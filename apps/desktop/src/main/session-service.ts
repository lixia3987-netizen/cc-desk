import { randomUUID } from 'node:crypto';
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
import { ChatQueue } from './chat-queue';
import type { WorkspaceQueries } from './workspace-queries';
import { gitWorktreeRoot } from './git';
import { isSessionBusy } from '../shared/session-activity';
import { canonicalDirectory, DirectoryExecutionCoordinator, type DirectoryLease } from './directory-execution';
import type { ExecutionSubmission } from './execution/ports';

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
  readonly queue: ChatQueue;
  private attachments: Attachments;
  private admissions = new Set<string>();
  private cancellations = new Map<string, number>();
  private lifecycle = new Set<string>();
  private directoryLocks = new Set<string>();
  private directoryExecution = new DirectoryExecutionCoordinator();
  private executionLeases = new Map<string, DirectoryLease>();
  private releaseOperations = new Map<string, Promise<void>>();
  private notified = new Map<string,string>();
  private workflowStates = new Map<string,string>();
  private stopping = false;
  private maintenance = false;
  private maintainedEngines = new Set<string>();
  private maintenanceOperation = false;
  private maintenanceEpochs = new Map<string, number>();
  private globalAdmissionEpoch = 0;
  constructor(private store: StateStore, readonly execution: ExecutionRegistry,
    private onState: () => void, private getWindow: () => BrowserWindow | null, private queries: WorkspaceQueries) {
    this.attachments = new Attachments(store.directory);
    this.chat = new StructuredExecutions(execution, store.directory);
    this.runtime = new TerminalExecutions(execution);
    execution.events.subscribe(event => {
      const window = this.getWindow();
      // Large message bodies stay in the paginated journal, not in renderer event queues.
      if (event.type !== 'journal' || !['message', 'text_delta'].includes(event.event.type)) window?.webContents.send('execution:event', event);
      if (event.type === 'session.changed' || event.type === 'identity.changed') this.onState();
      if (event.type === 'terminal.data') window?.webContents.send('terminal:data', event.chunk);
      if (event.type !== 'conversation.changed') return;
      const id = event.identity.sessionId, state = event.taskState;
      this.queue?.wake(id);
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
      runStage:(id,prompt,titlePrompt,submission) => this.runChat(id,prompt,[],titlePrompt,false,submission),
      settled:id => this.refreshDirectoryRelease(id),
      cancelSession:id => {
        this.cancellations.set(id, (this.cancellations.get(id) ?? 0) + 1);
        return this.chat.interrupt(id);
      },
      onChange:runs => {
        this.getWindow()?.webContents.send('workflow:changed');
        for (const run of runs) {
          const previous = this.workflowStates.get(run.id); this.workflowStates.set(run.id, run.status);
          if (previous !== run.status && ['failed', 'interrupted', 'cancelled'].includes(run.status) && this.queue && !this.queue.isPrioritizing(run.sessionId)) {
            try { this.queue.pause(run.sessionId, '工作流已停止，待发送消息需要手动继续。'); }
            catch { /* Keep the in-memory pause without preventing workflow cancellation. */ }
          }
          this.queue?.wake(run.sessionId);
        }
      }
    });
    for (const run of this.workflows.list()) this.workflowStates.set(run.id, run.status);
    this.queue = new ChatQueue(store.directory, {
      captureAdmission: id => this.captureEngineAdmission(this.session(id).execution.providerId),
      assertAvailable: id => {
        const session = this.structured(id); this.assertUnlocked(session);
        if (session.archived) throw new Error('请先取消会话归档。');
        if (this.runtime.has(id)) throw new Error('此会话已有终端进程。');
      },
      blocked: id => this.admissions.has(id) || this.chat.isBusy(id) || this.workflows.isSessionBusy(id),
      acceptAttachments: (id, files, commit) => this.attachments.acceptQueued(id, files, commit),
      run: (id, item) => this.runChat(id, item.text, item.attachments, undefined, true, { requestId: item.id, source: 'queue' }),
      settled:id => this.refreshDirectoryRelease(id),
      interrupt: id => this.interruptForQueue(id),
      changed: id => this.getWindow()?.webContents.send('chat:changed', id, this.chat.taskState(id)),
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
  activeCountForEngine(providerId: string) {
    return this.store.state.sessions.filter(session => session.execution.providerId === providerId && this.execution.has(session.id)).length;
  }
  private session(id: string) { return this.execution.getSession(id); }
  private structured(id: string) {
    const s = this.session(id);
    if (s.execution.mode !== 'structured') throw new Error('此功能需要图形化会话。');
    return s;
  }
  private project(id: string) {
    const p = this.store.state.projects.find(p => p.id === id);
    if(!p) throw new Error('项目不存在。'); return p;
  }
  private occupied(id: string) { return this.runtime.has(id) || this.chat.has(id) || this.admissions.has(id); }
  private recoveryRequired(id: string) {
    // Missing-provider records are retained for offline history; they cannot
    // make an unrelated registered provider's admission fail globally.
    return this.execution.executors().some(executor => executor.recoveryRequired?.(id));
  }
  private taskOccupied(id: string) { return this.runtime.has(id) || this.chat.isBusy(id) || this.admissions.has(id) || this.releaseOperations.has(id) || this.workflows.isSessionBusy(id) || this.queue.hasActive(id) || this.recoveryRequired(id); }
  private pathKey(value: string): string { return canonicalDirectory(value); }
  private contains(root: string, target: string) {
    const relative = path.relative(root, target);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  }
  private overlaps(a: string, b: string) { return this.contains(a,b) || this.contains(b,a); }
  private async executionRoots(session: Session): Promise<string[]> {
    const cwd = this.pathKey(session.cwd);
    const root = await gitWorktreeRoot(session.cwd).catch(() => this.project(session.projectId).path);
    // A linked worktree has its own root; git-common-dir is deliberately not a lock key.
    return [...new Set([this.pathKey(root), cwd])];
  }
  private async assertRecoveryDirectories(keys: readonly string[]): Promise<void> {
    for (const session of this.store.state.sessions) {
      if (!this.recoveryRequired(session.id)) continue;
      const roots = await this.executionRoots(session);
      if (keys.some(key => roots.some(root => this.overlaps(key, root)))) {
        throw new Error(`工作目录存在需要核查的操作（会话 ${session.id}），请先确认未知副作用和进程清理结果。`);
      }
    }
  }
  private async acquireExecution(id: string, checkAdmission: () => void): Promise<void> {
    const session = this.session(id);
    const original = JSON.stringify([session.cwd, session.projectId, session.execution]);
    const keys = await this.executionRoots(session);
    checkAdmission();
    await this.assertRecoveryDirectories(keys);
    checkAdmission();
    this.assertDirectoriesUnlocked(keys);
    // Reusable idle Claude connections may be drained; queue/workflow ownership must win.
    for (const conflict of this.directoryExecution.conflicts(keys, id)) {
      const other = this.store.state.sessions.find(value => value.id === conflict.owner.sessionId);
      if (other?.execution.mode === 'structured' && !this.taskOccupied(other.id) && !this.lifecycle.has(other.id)) {
        this.lifecycle.add(other.id);
        try {
          await this.chat.stopIdle(other.id);
          checkAdmission();
          await this.chat.whenReleased(other.id);
          checkAdmission();
          await this.refreshDirectoryRelease(other.id);
        } finally { this.lifecycle.delete(other.id); }
        checkAdmission(); this.assertDirectoriesUnlocked(keys);
      }
    }
    const refreshedRoots = await this.executionRoots(this.session(id));
    await this.assertRecoveryDirectories(keys);
    if (original !== JSON.stringify([this.session(id).cwd, this.session(id).projectId, this.session(id).execution]) ||
        JSON.stringify(keys) !== JSON.stringify(refreshedRoots)) {
      throw new Error('工作目录或会话身份在准入期间发生改变，请重新尝试。');
    }
    checkAdmission(); this.assertDirectoriesUnlocked(keys);
    const lease = this.directoryExecution.acquire({ sessionId: id, providerId: session.execution.providerId,
      generation: this.cancellations.get(id) ?? 0 }, keys);
    this.executionLeases.set(id, lease);
  }
  /** Revalidated by the native host immediately before/after tool-related awaits. */
  assertExecutionOwnership(id: string): void {
    const session = this.session(id);
    this.assertEngineAvailable(session.execution.providerId);
    const lease = this.executionLeases.get(id);
    if (!lease || !this.directoryExecution.owns(lease) || lease.owner.sessionId !== id ||
        lease.owner.providerId !== session.execution.providerId ||
        lease.owner.generation !== (this.cancellations.get(id) ?? 0) ||
        !this.admissions.has(id) || this.lifecycle.has(id) || this.recoveryRequired(id) ||
        !lease.roots.includes(this.pathKey(session.cwd))) {
      throw new Error('工具所属执行代次或工作目录授权已失效。');
    }
    this.assertDirectoriesUnlocked([...lease.roots]);
  }
  /** Outer orchestration calls this only after its durable ACK/terminal commit. */
  async refreshDirectoryRelease(id: string): Promise<void> {
    const inProgress = this.releaseOperations.get(id);
    if (inProgress) return inProgress;
    const lease = this.executionLeases.get(id);
    if (!lease || this.admissions.has(id) || this.queue?.hasActive(id) || this.workflows?.isSessionBusy(id) || this.recoveryRequired(id)) return;
    const operation = (async () => {
      const session = this.store.state.sessions.find(value => value.id === id);
      if (!session) throw new Error('仍持有目录的会话记录已移除，无法确认释放。');
      if (session.execution.mode === 'structured') {
        if (this.chat.isBusy(id)) return;
        // Claude keeps its reusable CLI and live configuration between turns.
        // A competing admission, management action or capacity eviction drains it.
        if (session.execution.providerId === 'claude' && this.chat.has(id)) return;
        await this.chat.stopIdle(id);
        await this.chat.whenReleased(id);
      } else await this.runtime.whenReleased(id);
      if (this.executionLeases.get(id) !== lease || this.admissions.has(id) || this.queue?.hasActive(id) || this.workflows?.isSessionBusy(id) || this.recoveryRequired(id)) return;
      this.directoryExecution.release(lease);
      this.executionLeases.delete(id);
    })();
    this.releaseOperations.set(id, operation);
    try { await operation; } finally { if (this.releaseOperations.get(id) === operation) this.releaseOperations.delete(id); }
  }
  private assertDirectoriesUnlocked(keys: string[]) {
    if (keys.some(key => [...this.directoryLocks].some(lock => this.overlaps(key,lock)))) throw new Error('会话或工作目录正在执行管理操作，请稍后重试。');
  }
  private assertUnlocked(session: Session) {
    this.assertEngineAvailable(session.execution.providerId);
    this.execution.validateSession(session);
    if(this.lifecycle.has(session.id)) throw new Error('会话或工作目录正在执行管理操作，请稍后重试。');
    this.assertDirectoriesUnlocked([this.pathKey(session.cwd)]);
  }
  private assertAvailable() {
    if (this.stopping) throw new Error('工作台正在退出。');
    if (this.maintenance) throw new Error('Claude Code 正在更新，所有工作区暂时断开，请等待更新完成。');
  }
  assertEngineAvailable(providerId: string) {
    this.assertAvailable();
    if (this.maintainedEngines.has(providerId)) throw new Error(`${providerId === 'claude' ? 'Claude Code 正在更新' : '会话执行引擎正在维护'}，请等待完成后重试。`);
  }
  captureEngineAdmission(providerId: string): () => void {
    this.assertEngineAvailable(providerId);
    const epoch = this.maintenanceEpochs.get(providerId) ?? 0;
    const globalEpoch = this.globalAdmissionEpoch;
    return () => {
      this.assertEngineAvailable(providerId);
      if (globalEpoch !== this.globalAdmissionEpoch || epoch !== (this.maintenanceEpochs.get(providerId) ?? 0)) {
        throw new Error('执行引擎维护已取消此前操作，请重新尝试。');
      }
    };
  }
  private async manage<T>(id: string, action: () => T | Promise<T>): Promise<T> {
    this.assertUnlocked(this.session(id));
    if(this.admissions.has(id) || this.workflows.isSessionBusy(id) || this.queue.hasActive(id) || this.recoveryRequired(id)) throw new Error('请先停止正在执行的任务并核查未知副作用。');
    if (this.session(id).execution.mode === 'structured') this.queue.pause(id);
    this.lifecycle.add(id);
    // Capture the driver before a record deletion. Its explicit barrier remains usable afterward.
    const driver = this.execution.registration(this.session(id)).executor;
    try { return await action(); } finally {
      this.lifecycle.delete(id);
      // Deleted records must already have passed the explicit idle release barrier.
      if (this.store.state.sessions.some(session => session.id === id)) await this.refreshDirectoryRelease(id);
      else {
        const lease = this.executionLeases.get(id);
        if (lease) {
          if (!driver.whenReleased) throw new Error('执行器缺少删除后的物理释放证明。');
          await driver.whenReleased(id);
          this.directoryExecution.release(lease); this.executionLeases.delete(id);
        }
      }
    }
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
    await this.assertRecoveryDirectories(keys);
    if (this.directoriesBusy(keys)) throw new Error(this.idleTerminalBlock(keys) ? '原生 Claude 终端仍打开，请先关闭终端释放工作目录，再创建或管理 worktree。' : message);
    const releases = await Promise.allSettled(this.directorySessions(keys).filter(session=>this.chat.has(session.id)).map(session=>this.chat.stopIdle(session.id)));
    for (const result of releases) if (result.status === 'rejected') throw result.reason;
    for (const lease of this.directoryExecution.conflicts(keys)) await this.refreshDirectoryRelease(lease.owner.sessionId);
    // Locks prevent new admissions while exits are pending. Keep a final process
    // check: no Git mutation may run merely because a UI task badge is complete.
    if (this.directoryExecution.conflicts(keys).length || this.directorySessions(keys).some(s => this.occupied(s.id) || this.workflows.isSessionBusy(s.id) || this.queue.hasActive(s.id))) throw new Error(message);
  }
  private async worktreeDirectories(s: Session) {
    return [...new Set((await Promise.all([gitWorktreeRoot(this.worktreeBase(s)),gitWorktreeRoot(s.worktree ?? s.cwd)])).map(dir => this.pathKey(dir)))];
  }
  private async worktreeDeletionDirectories(s: Session) {
    const recorded = [this.worktreeBase(s), s.worktree!];
    // Damaged or already removed worktrees cannot report their Git root. Keep
    // the recorded paths locked as well as every root Git can still resolve;
    // only the force-cleanup helper may decide whether deletion is safe.
    const roots = await Promise.all(recorded.map(directory => gitWorktreeRoot(directory).catch(() => undefined)));
    return [...new Set([...recorded, ...roots.filter((root): root is string => !!root)].map(directory => this.pathKey(directory)))];
  }
  private cleanupDependencies(s: Session) {
    const target = this.pathKey(s.worktree ?? s.cwd);
    return this.store.state.sessions.some(other => other.id !== s.id &&
      (this.contains(target,this.pathKey(other.cwd)) || (other.worktree && other.worktreeBase && this.contains(target,this.pathKey(other.worktreeBase)))));
  }
  /** Keep source and project-local destination locked until the dependent session is saved. */
  async withSessionCreation<T>(cwd: string, isolated: boolean, action: () => Promise<T>, destinationProjectPath?: string): Promise<T> {
    const epoch = this.globalAdmissionEpoch;
    this.assertAvailable();
    const roots = isolated ? await Promise.all([gitWorktreeRoot(cwd), ...(destinationProjectPath ? [gitWorktreeRoot(destinationProjectPath)] : [])]) : [cwd];
    const keys = [...new Set(roots.map(root => this.pathKey(root)))];
    this.assertAvailable();
    if (epoch !== this.globalAdmissionEpoch) throw new Error('工作目录管理已取消，请重新尝试。');
    this.assertDirectoriesUnlocked(keys);
    keys.forEach(key => this.directoryLocks.add(key));
    try {
      if (isolated) await this.releaseIdleDirectories(keys,'请先停止来源工作目录及目标项目目录中的全部会话，再创建独立 worktree。');
      this.assertAvailable();
      if (epoch !== this.globalAdmissionEpoch) throw new Error('工作目录管理已取消，请重新尝试。');
      return await action();
    } finally { keys.forEach(key => this.directoryLocks.delete(key)); }
  }
  private async manageWorktree<T>(id:string,action:(s:Session)=>Promise<T>,confirmedPath?:string) {
    const checkAdmission = this.captureEngineAdmission(this.session(id).execution.providerId);
    return this.manage(id,async()=>{
      const s=this.session(id); if(!s.worktree)throw new Error('此会话没有独立 worktree。');
      if(confirmedPath!==undefined&&s.worktree!==confirmedPath)throw new Error('隔离目录已改变，请重新打开删除确认后重试。');
      const keys = confirmedPath===undefined ? await this.worktreeDirectories(s) : await this.worktreeDeletionDirectories(s);
      checkAdmission();
      this.assertDirectoriesUnlocked(keys);
      keys.forEach(k=>this.directoryLocks.add(k));
      try{await this.releaseIdleDirectories(keys,'请先停止此 worktree 和来源目录中的全部会话。');checkAdmission();return await action(s);}finally{keys.forEach(k=>this.directoryLocks.delete(k));}
    });
  }
  private async reserve(id: string) {
    const providerId = this.session(id).execution.providerId;
    const checkAdmission = this.captureEngineAdmission(providerId);
    const epoch = this.cancellations.get(id) ?? 0;
    let claimed = false;
    const assertReady = () => {
      checkAdmission();
      if (epoch !== (this.cancellations.get(id) ?? 0)) throw new Error('会话操作已取消。');
      if(this.stopping) throw new Error('工作台正在退出。');
      const session=this.session(id);this.assertUnlocked(session);
      if(session.archived) throw new Error('请先取消会话归档。');
      if(this.store.state.sessions.some(s=>s.id!==id&&sameConversation(s.execution,session.execution)&&this.occupied(s.id)))throw new Error('同一提供方的对话已在另一个会话中运行，请先停止它或创建会话分支。');
      if(this.admissions.has(id) && !claimed) throw new Error('当前会话操作尚未完成。');
    };
    assertReady();
    this.admissions.add(id); claimed = true;
    try {
    const releasing = this.releaseOperations.get(id);
    if (releasing) { await releasing; assertReady(); }
    await this.acquireExecution(id, assertReady);
    assertReady();
    const occupiedIds = () => new Set(this.store.state.sessions.filter(s => this.occupied(s.id)).map(s => s.id));
    while (occupiedIds().size > this.store.state.settings.maxSessions) {
      const idle = this.store.state.sessions.filter(s => s.id !== id && s.kind === 'agent' && s.execution.mode === 'structured' &&
        this.chat.has(s.id) && !this.taskOccupied(s.id) && !this.lifecycle.has(s.id) &&
        ![...this.directoryLocks].some(key => this.overlaps(key,this.pathKey(s.cwd))))
        .sort((a,b) => a.updatedAt.localeCompare(b.updatedAt))[0];
      if (!idle) throw new Error('已达到最大并发会话数。');
      this.lifecycle.add(idle.id);
      try {
        await this.chat.stopIdle(idle.id);
        assertReady();
        await this.chat.whenReleased(idle.id);
        assertReady();
        await this.refreshDirectoryRelease(idle.id);
      } finally { this.lifecycle.delete(idle.id); }
      assertReady();
    }
    // Idle eviction awaits process-tree shutdown; another session may have
    // claimed the same native transcript while that wait was in progress.
    assertReady();
    } catch (error) {
      this.admissions.delete(id);
      await this.refreshDirectoryRelease(id);
      throw error;
    }
  }
  async start(id: string) {
    const s = this.session(id);
    const checkAdmission = this.captureEngineAdmission(s.execution.providerId);
    const epoch = this.cancellations.get(id) ?? 0;
    if(s.execution.mode === 'structured') return; // Started by first message; no empty model request.
    if(this.runtime.has(id)) return;
    if(this.chat.has(id)) throw new Error('此会话已由图形化运行器占用。');
    await this.reserve(id);
    try {
      checkAdmission();
      if (epoch !== (this.cancellations.get(id) ?? 0)) throw new Error('会话启动已取消。');
      await this.runtime.start(id);
    } finally {
      this.admissions.delete(id);
      // Terminal ownership spans the whole process lifetime, including natural exit.
      void this.refreshDirectoryRelease(id).catch(() => { this.onState(); });
    }
  }
  async stop(id: string) {
    this.cancellations.set(id, (this.cancellations.get(id) ?? 0) + 1);
    const errors: unknown[] = [];
    if (this.session(id).execution.mode === 'structured') { try { this.queue.pause(id); } catch (error) { errors.push(error); } }
    for(const run of this.workflows.list(id)) if(run.status==='running') { try { await this.workflows.cancel(run.id); } catch (error) { errors.push(error); } }
    try { if(this.session(id).execution.mode==='structured') await this.chat.stopAndWait(id); else await this.runtime.stopAndWait(id); } catch (error) { errors.push(error); }
    try { await this.refreshDirectoryRelease(id); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('\n'));
  }
  async interrupt(id: string) {
    this.cancellations.set(id, (this.cancellations.get(id) ?? 0) + 1);
    const errors: unknown[] = [];
    if (this.session(id).execution.mode === 'structured') { try { this.queue.pause(id); } catch (error) { errors.push(error); } }
    for(const run of this.workflows.list(id)) if(run.status === 'running') { try { await this.workflows.cancel(run.id); } catch (error) { errors.push(error); } }
    try { if(this.session(id).execution.mode === 'structured') await this.chat.interrupt(id); else await this.runtime.interrupt(id); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('\n'));
  }
  private async interruptForQueue(id: string) {
    this.cancellations.set(id, (this.cancellations.get(id) ?? 0) + 1);
    const owned = this.workflows.list(id).filter(run => ['running', 'cancelled'].includes(run.status));
    for (const run of owned) if (run.status === 'running') await this.workflows.cancel(run.id);
    await this.chat.interruptAndWait(id);
    await Promise.all(owned.map(run => this.workflows.wait(run.id)));
    const deadline = Date.now() + 10_000;
    while (this.admissions.has(id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (this.admissions.has(id) || this.workflows.isSessionBusy(id)) throw new Error('上一轮任务尚未完全释放会话，请稍后重试。');
  }
  private async runChat(id: string, text: string, attachments: string[] = [], titlePrompt?: string, queued = false, submission: ExecutionSubmission = { requestId: randomUUID(), source: 'direct' }) {
    const epoch = this.cancellations.get(id) ?? 0;
    const s = this.structured(id);
    const checkAdmission = this.captureEngineAdmission(s.execution.providerId);
    if(s.archived) throw new Error('请先取消会话归档。');
    if(this.runtime.has(id)) throw new Error('此会话已有终端进程。');
    if (!queued && titlePrompt === undefined && this.queue.hasPending(id)) throw new Error('请先处理排队消息，再直接发送。');
    if (queued && this.queue.snapshot(id).paused) throw new Error('队列已暂停，消息没有发送。');
    if(BUSY.has(this.chat.taskState(id))) throw new Error('请等待当前回合完成，或先中断。');
    await this.reserve(id);
    try {
      await this.attachments.retain(id,attachments);
      checkAdmission();
      if (epoch !== (this.cancellations.get(id) ?? 0)) throw new Error('消息发送已取消。');
      if (queued) await this.attachments.markSent(id, attachments);
      checkAdmission();
      if (epoch !== (this.cancellations.get(id) ?? 0)) throw new Error('消息发送已取消。');
      if (queued && this.queue.snapshot(id).paused) throw new Error('队列已暂停，消息没有发送。');
      const result=await this.chat.send(id,text,attachments,titlePrompt,submission);
      if (s.execution.providerId !== 'claude') await this.chat.whenReleased(id);
      if(result.success && !queued) {
        try { await this.attachments.markSent(id,attachments); }
        catch (error) { throw new Error(`本轮任务已完成，但附件草稿状态保存失败；附件副本仍保留，请勿重复执行本轮任务。${error instanceof Error?error.message:String(error)}`); }
      }
      return result;
    }
    finally { this.admissions.delete(id); await this.refreshDirectoryRelease(id); this.queue.wake(id); }
  }
  select(id: string) { if(id) this.session(id); this.store.change(s => {s.selectedSessionId=id;}); this.onState(); }
  register(handle: Register) {
    registerSessionHandlers(handle, {
      store: this.store, chat: this.chat, runtime: this.runtime, workflows: this.workflows, attachments: this.attachments,
      session: id => this.session(id), taskOccupied: id => this.taskOccupied(id), admissionPending: id => this.admissions.has(id),
      manage: (id, action) => this.manage(id, action), select: id => this.select(id), export: id => this.export(id), onState: this.onState,
      manageWorktreeDeletion: (id, confirmedPath, action) => this.manageWorktree(id, action, confirmedPath), worktreeBase: session => this.worktreeBase(session),
      cleanupDependencies: session => this.cleanupDependencies(session),
      forgetQueue: id => this.queue.delete(id),
      validateConfig: (id, config) => this.execution.validateConfig(id, config),
    });
    registerChatHandlers(handle, {
      chat: this.chat, runtime: this.runtime, workflows: this.workflows, attachments: this.attachments, queue: this.queue,
      structured: id => this.structured(id), assertUnlocked: session => this.assertUnlocked(session),
      captureAdmission: id => this.captureEngineAdmission(this.session(id).execution.providerId),
      requireCommands: id => { this.execution.require(id, 'commands'); },
      reserve: id => this.reserve(id), releaseAdmission: async id => { this.admissions.delete(id); await this.refreshDirectoryRelease(id); this.queue.wake(id); },
      manage: (id, action) => this.manage(id, action),
      runChat: (id, text, attachments, requestId) => this.runChat(id, text, attachments, undefined, false, { requestId: requestId ?? randomUUID(), source: 'direct' }), getWindow: this.getWindow,
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
      defaultWorkflowError: id => this.execution.defaultWorkflowError(id),
      hasPendingTask: id => this.admissions.has(id) || BUSY.has(this.chat.taskState(id)) || this.queue.hasPending(id),
      pauseQueue: id => this.queue.pause(id), getWindow: this.getWindow,
    });
  }
  private export(id: string) { return exportSession(this.execution, id, this.getWindow()); }
  async shutdown() {
    this.stopping=true;
    this.globalAdmissionEpoch++;
    const errors:unknown[]=[];
    try { this.queue.pauseAll('工作台已退出，待发送消息需要手动继续。'); } catch (error) { errors.push(error); }
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
    if (this.maintenanceOperation) throw new Error('执行引擎正在维护，请等待完成后重试。');
    this.maintenanceOperation = true;
    this.globalAdmissionEpoch++;
    this.maintenance = true;
    try {
      this.execution.setMaintenance(true);
      // Stop each runner even when another runner cannot save or terminate.
      const results = await Promise.allSettled([Promise.resolve().then(() => this.queue.pauseAll('CLI 更新已暂停队列，请手动继续。')), this.workflows.disconnectAll(), this.execution.disconnectAll()]);
      const deadline = Date.now() + 10_000;
      while (this.admissions.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      if (results.some(result => result.status === 'rejected') || this.activeCount || this.admissions.size) throw new Error('未能断开全部工作区或保存记录，已取消更新。请检查会话进程、磁盘空间和目录权限后重试。');
      this.store.flush();
      if (this.store.persistenceError) throw new Error('工作区记录尚未成功保存，已取消更新。请检查磁盘空间和目录权限。');
      if (this.stopping) throw new Error('工作台正在退出，已取消更新。');
      return await action();
    } finally {
      try { this.execution.setMaintenance(false); }
      finally { this.maintenance = false; this.maintenanceOperation = false; this.onState(); }
    }
  }
  async withEngineMaintenance<T>(providerId: string, action: () => Promise<T>): Promise<T> {
    this.assertEngineAvailable(providerId);
    if (this.maintenanceOperation) throw new Error('执行引擎正在维护，请等待完成后重试。');
    this.maintenanceOperation = true;
    this.maintainedEngines.add(providerId);
    this.maintenanceEpochs.set(providerId, (this.maintenanceEpochs.get(providerId) ?? 0) + 1);
    // Fix the scope only after closing admission. Existing asynchronous work is
    // cancelled even if it resumes after this maintenance operation has ended.
    const sessions = this.store.state.sessions.filter(session => session.execution.providerId === providerId);
    const ids = sessions.map(session => session.id);
    const targeted = new Set(ids);
    const workflowIds = [...new Set([...ids, ...this.workflows.list().filter(run => run.providerId === providerId).map(run => run.sessionId)])];
    for (const id of ids) this.cancellations.set(id, (this.cancellations.get(id) ?? 0) + 1);
    const pending = () => [...this.admissions, ...this.lifecycle].some(id => targeted.has(id)) ||
      ids.some(id => this.queue.hasActive(id)) || workflowIds.some(id => this.workflows.isSessionBusy(id));
    const errors: unknown[] = [];
    try {
      try { this.execution.setEngineMaintenance(providerId, ids, true); }
      catch (error) { errors.push(error); }
      try { this.onState(); } catch (error) { errors.push(error); }
      // Persistence or one driver's failure must not prevent independent target
      // cleanup. Surviving providers retain their queues, processes and owners.
      const results = await Promise.allSettled([
        Promise.resolve().then(() => this.queue.pauseSessions(sessions.filter(session => session.execution.mode === 'structured').map(session => session.id), '执行引擎维护已暂停队列，请手动继续。')),
        Promise.resolve().then(() => this.workflows.disconnectSessions(workflowIds, '执行引擎维护已中断工作流，请手动继续。')),
        Promise.resolve().then(() => this.execution.disconnectEngine(providerId, ids)),
      ]);
      for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
      const deadline = Date.now() + 10_000;
      while (pending() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      if (errors.length || pending() || ids.some(id => this.execution.has(id))) {
        throw new AggregateError(errors, '未能停止目标引擎的全部任务或保存记录，已取消更新。请检查会话进程、磁盘空间和目录权限后重试。');
      }
      this.store.flush();
      if (this.store.persistenceError) throw new Error('工作区记录尚未成功保存，已取消更新。请检查磁盘空间和目录权限。');
      if (this.stopping) throw new Error('工作台正在退出，已取消更新。');
      return await action();
    } finally {
      try { this.execution.setEngineMaintenance(providerId, ids, false); }
      finally {
        this.maintainedEngines.delete(providerId);
        this.maintenanceOperation = false;
        this.onState();
      }
    }
  }
}
