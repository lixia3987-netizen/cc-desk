import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { dialog, Notification, type BrowserWindow } from 'electron';
import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';
import type { Capabilities, Session } from '../shared/types';
import { idSchema, panelDraftsSchema, sessionInputSchema } from '../shared/schema';
import { StateStore } from './store';
import { Runtime } from './runtime';
import { ChatRuntime } from './chat-runtime';
import { Attachments } from './attachments';
import { WorkflowEngine, newWorkflowSchema } from './workflows';
import { queryHistory, exportClaudeTranscript, findClaudeTranscript } from './history';
import { gitChanges, gitDiff, gitWorktreeRoot, worktreeInfo, mergeWorktree, cleanupWorktree } from './git';
import { listProjectFiles, readProjectFile } from './files';
import { diagnoseEnvironment } from './diagnostics';
import { isSessionBusy } from '../shared/session-activity';

type Register = <T>(name: string, schema: z.ZodType<T>, action: (data: T) => unknown) => void;
const BUSY = new Set(['starting','thinking','tool_running','waiting_approval','waiting_input']);
const relativePath = z.string().min(1).max(4096).refine(s => !/[\x00\r\n]/.test(s));
const shortId = z.string().min(1).max(200);

export class SessionService {
  readonly chat: ChatRuntime;
  readonly workflows: WorkflowEngine;
  private attachments: Attachments;
  private admissions = new Set<string>();
  private lifecycle = new Set<string>();
  private directoryLocks = new Set<string>();
  private notified = new Map<string,string>();
  private stopping = false;
  constructor(private store: StateStore, private runtime: Runtime, private capabilities: () => Capabilities,
    private onState: () => void, private getWindow: () => BrowserWindow | null) {
    this.attachments = new Attachments(store.directory);
    this.chat = new ChatRuntime(store,onState,id => {
      const state = this.chat.taskState(id);
      this.getWindow()?.webContents.send('chat:changed',id,state);
      const old = this.notified.get(id); this.notified.set(id,state);
      if (old !== state && store.state.settings.notifications && ['waiting_approval','waiting_input','completed','error'].includes(state) && Notification.isSupported()) {
        const session = store.state.sessions.find(s => s.id === id);
        const labels: Record<string,string> = {waiting_approval:'需要批准工具操作',waiting_input:'需要你的回答',completed:'本轮任务已完成',error:'任务遇到错误'};
        const notification = new Notification({title:session?.title ?? 'Claude Workbench',body:labels[state]});
        notification.on('click',() => this.navigateFromNotification(id));
        notification.show();
      }
    });
    this.workflows = new WorkflowEngine(store.directory,{
      getSession:id => { const s = this.structured(id); if(s.archived) throw new Error('请先取消会话归档。'); this.assertUnlocked(s); return {sessionId:s.id,projectId:s.projectId,cwd:s.cwd,worktree:s.worktree}; },
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
  get activeCount() { return this.runtime.activeCount + this.chat.activeCount; }
  private session(id: string) { return this.runtime.getSession(id); }
  private structured(id: string) {
    const s = this.session(id);
    if(s.kind !== 'claude' || s.adapter !== 'structured') throw new Error('此功能需要图形化 Claude 会话。');
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
    if(this.lifecycle.has(session.id)) throw new Error('会话或工作目录正在执行管理操作，请稍后重试。');
    this.assertDirectoriesUnlocked([this.pathKey(session.cwd)]);
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
    return occupied.length > 0 && occupied.every(s => this.runtime.has(s.id) && s.kind === 'claude' &&
      s.adapter === 'terminal' && s.terminalSync === 'synced' && !isSessionBusy(s) && !this.admissions.has(s.id) && !this.workflows.isSessionBusy(s.id));
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
      if(session.kind==='claude'&&this.store.state.sessions.some(s=>s.id!==id&&s.kind==='claude'&&s.claudeId===session.claudeId&&this.occupied(s.id)))throw new Error('同一 Claude 对话已在另一个会话中运行，请先停止它或创建会话分支。');
      if(this.admissions.has(id)) throw new Error('当前会话操作尚未完成。');
    };
    assertReady();
    const occupiedIds = () => new Set(this.store.state.sessions.filter(s => this.occupied(s.id)).map(s => s.id));
    while (!occupiedIds().has(id) && occupiedIds().size >= this.store.state.settings.maxSessions) {
      const idle = this.store.state.sessions.filter(s => s.id !== id && s.kind === 'claude' && s.adapter === 'structured' &&
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
    const s = this.session(id);
    if(s.adapter === 'structured' && s.kind === 'claude') return; // Started by first message; no empty model request.
    if(this.chat.has(id)) throw new Error('此会话已由图形化运行器占用。');
    await this.reserve(id);
    try { await this.runtime.start(id,this.capabilities()); } finally { this.admissions.delete(id); }
  }
  async stop(id: string) {
    if(this.workflows.isSessionBusy(id)) {
      for(const run of this.workflows.list(id)) if(run.status==='running') await this.workflows.cancel(run.id);
    }
    if(this.session(id).kind==='claude' && this.session(id).adapter==='structured') await this.chat.stop(id); else this.runtime.stop(id);
  }
  async interrupt(id: string) {
    if(this.workflows.isSessionBusy(id)) {
      for(const run of this.workflows.list(id)) if(run.status === 'running') await this.workflows.cancel(run.id);
      return;
    }
    if(this.session(id).adapter === 'structured') await this.chat.interrupt(id); else this.runtime.interrupt(id);
  }
  private async runChat(id: string, text: string, attachments: string[] = [], titlePrompt?: string) {
    const s = this.structured(id);
    if(s.archived) throw new Error('请先取消会话归档。');
    if(this.runtime.has(id)) throw new Error('此会话已有终端进程。');
    if(BUSY.has(this.chat.taskState(id))) throw new Error('请等待当前回合完成，或先中断。');
    await this.reserve(id);
    try {
      await this.attachments.retain(id,attachments);
      const result=await this.chat.send(id,text,this.capabilities(),attachments,titlePrompt);
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
    handle('session:panel-drafts',z.object({id:idSchema,patch:panelDraftsSchema}),({id,patch}) => {
      this.session(id);
      const changed=this.store.change(state=>{
        const session=state.sessions.find(session=>session.id===id)!;
        session.panelDrafts={...session.panelDrafts,...patch};
      },{defer:true});
      if(changed)this.onState();
    });
    handle('session:draft',z.object({id:idSchema,text:z.string().max(128*1024)}),({id,text}) => {
      if(this.session(id).draft===text)return;
      this.store.change(s => {s.sessions.find(s => s.id===id)!.draft=text;},{defer:true}); this.onState();
    });
    handle('session:select',z.union([idSchema,z.literal('')]),id => this.select(id));
    handle('session:update',z.object({id:idSchema,title:z.string().trim().min(1).max(120).optional(),archived:z.boolean().optional(),model:sessionInputSchema.shape.model.optional(),effort:sessionInputSchema.shape.effort.optional(),permissionMode:sessionInputSchema.shape.permissionMode.optional()}),async input => {
      const s = this.session(input.id);
      if(input.archived && this.taskOccupied(s.id)) throw new Error('请先停止会话和工作流，再归档。');
      const save = () => this.store.change(state => Object.assign(state.sessions.find(x=>x.id===s.id)!,input,
        input.title !== undefined ? {titleSource:'manual'} : {}, input.permissionMode ? {observedPermissionMode:input.permissionMode} : {}, {updatedAt:new Date().toISOString()}));
      const config = input.model !== undefined || input.effort !== undefined || input.permissionMode !== undefined;
      if(config) {
        if(this.workflows.isSessionBusy(s.id) || this.admissions.has(s.id)) throw new Error('请等待当前任务完成后再修改配置。');
        if(this.runtime.has(s.id)) throw new Error('终端模式请停止会话后修改启动配置。');
        await this.manage(s.id,async()=>{
          if(input.archived && this.chat.has(s.id)) await this.chat.stopIdle(s.id);
          if(this.chat.has(s.id)) await this.chat.updateConfig(s.id,{model:input.model,effort:input.effort,permissionMode:input.permissionMode});
          save();
        });
        this.onState(); return;
      }
      if(input.archived) await this.manage(s.id,async()=>{await this.chat.stopIdle(s.id);save();});
      else save();
      this.onState();
    });
    handle('session:delete',idSchema,id => this.manage(id,async () => {
      const s = this.session(id);
      if(this.taskOccupied(id)) throw new Error('请先停止会话及工作流，再删除。');
      if(s.worktree) throw new Error('请先在 Git 面板检查并清理独立 worktree。');
      await this.chat.stopIdle(id);
      this.workflows.removeSession(id);
      this.runtime.forget(id,{deleteLogs:true}); this.chat.forget(id); await this.attachments.remove(id);
      this.store.change(state => {state.sessions=state.sessions.filter(s=>s.id!==id);if(state.selectedSessionId===id)state.selectedSessionId='';}); this.onState();
    }));
    handle('chat:snapshot',idSchema,async id => {this.structured(id);await this.chat.hydrate(id);return this.chat.snapshot(id);});
    handle('chat:commands',idSchema,async id => {
      const session=this.structured(id);
      if(session.archived)throw new Error('请先取消会话归档。');
      this.assertUnlocked(session);
      if(this.chat.has(id))return this.chat.snapshot(id);
      if(this.runtime.has(id)||this.workflows.isSessionBusy(id))throw new Error('请先结束当前会话任务。');
      await this.reserve(id);
      try{return await this.chat.prepareCommands(id,this.capabilities());}
      finally{this.admissions.delete(id);}
    });
    const messageId=z.string().min(1).max(4096);
    handle('chat:page',z.object({id:idSchema,before:messageId.optional(),after:messageId.optional(),around:messageId.optional(),query:z.string().max(500).optional()}).refine(value=>[value.before,value.after,value.around].filter(Boolean).length<=1),({id,...options})=>{this.structured(id);return this.chat.page(id,options);});
    handle('chat:search',z.object({id:idSchema,query:z.string().trim().min(1).max(500),before:messageId.optional()}),({id,query,before})=>{this.structured(id);return this.chat.search(id,query,before);});
    handle('chat:attention',z.undefined(),()=>this.chat.attention());
    handle('chat:send',z.object({id:idSchema,text:z.string().max(128*1024),attachments:z.array(z.string().max(4096)).max(8).optional()}),async ({id,text,attachments}) => {
      this.structured(id);
      if(!text.trim() && !attachments?.length) throw new Error('请输入消息或选择附件。');
      if(this.workflows.isSessionBusy(id)) throw new Error('工作流正在执行，请先取消后再手动发送。');
      const approved=await this.attachments.validate(id,attachments);
      if(this.workflows.isSessionBusy(id))throw new Error('工作流已开始，请先取消后再发送。');
      return this.runChat(id,text,approved);
    });
    handle('chat:respond',z.object({id:idSchema,requestId:shortId,decision:z.object({behavior:z.enum(['allow','deny']),message:z.string().max(10000).optional(),answers:z.record(z.string().max(2000),z.string().max(10000)).optional()})}),({id,requestId,decision}) => {this.structured(id);return this.chat.respond(id,requestId,decision);});
    handle('files:pick',idSchema,async id => {
      this.structured(id);
      const result=await dialog.showOpenDialog(this.getWindow()!,{title:'添加上下文附件',properties:['openFile','multiSelections'],filters:[{name:'文本、图片与 PDF',extensions:['png','jpg','jpeg','gif','webp','pdf','txt','md','json','csv','ts','tsx','js','py','yaml','yml','html','css','xml','log']}]});
      return result.canceled ? [] : this.attachments.add(id,result.filePaths);
    });
    handle('files:attachments',idSchema,id => { this.structured(id); return this.attachments.list(id); });
    handle('files:remove-attachment',z.object({id:idSchema,path:z.string().min(1).max(4096)}),({id,path}) => { this.structured(id); return this.attachments.removeFile(id,path); });
    handle('history:query',z.object({projectId:idSchema,query:z.string().max(500).optional(),offset:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(100).optional()}),({projectId,...options}) => queryHistory(this.project(projectId).path,options));
    handle('git:changes',idSchema,id => {
      const s=this.session(id);
      if(s.archived && !s.worktree && s.worktreeBase)return {available:false,changes:[],truncated:false,error:'工作目录已清理，此记录仅保留历史。'};
      return gitChanges(s.cwd);
    });
    handle('git:diff',z.object({id:idSchema,path:relativePath,staged:z.boolean()}),({id,path,staged}) => gitDiff(this.session(id).cwd,path,staged));
    handle('files:list',z.object({id:idSchema,query:z.string().max(500)}),({id,query}) => listProjectFiles(this.session(id).cwd,query));
    handle('files:read',z.object({id:idSchema,path:relativePath}),({id,path}) => readProjectFile(this.session(id).cwd,path));
    handle('worktree:info',idSchema,async id => {
      const s=this.session(id);
      // Read-only refreshes can outlive cleanup. Missing Git roots should produce
      // unavailable metadata, while all mutation paths keep their strict checks.
      const directories = await this.worktreeDirectories(s).catch(()=>undefined);
      const blocked = directories ? this.directoriesBusy(directories) : true;
      const info=await worktreeInfo(this.worktreeBase(s),s.worktree ?? s.cwd,id,blocked);
      if(directories && this.idleTerminalBlock(directories))info.reasons.push('原生 Claude 终端仍打开，请先关闭终端释放工作目录。');
      if(this.cleanupDependencies(s)) { info.canCleanup=false; info.reasons.push('其他会话的工作目录或 worktree 来源依赖此目录，请先处理这些会话。'); }
      return info;
    });
    handle('worktree:merge',idSchema,id => this.manageWorktree(id,s=>mergeWorktree(this.worktreeBase(s),s.worktree!,id,false)));
    handle('worktree:cleanup',idSchema,id => this.manageWorktree(id,async s => {
      if(this.cleanupDependencies(s))throw new Error('其他会话的工作目录或 worktree 来源依赖此目录，请先处理这些会话。');
      const result=await cleanupWorktree(this.worktreeBase(s),s.worktree!,id,false);
      if(result.ok) { this.store.change(state => {const item=state.sessions.find(x=>x.id===id)!;item.worktree=undefined;item.archived=true;item.error='工作目录已清理，此记录仅保留历史。请在来源项目中创建新会话。';}); this.onState(); }
      return result;
    }));
    handle('cli:diagnostics',idSchema.optional(),async id => {
      const cwd=id?this.session(id).cwd:undefined;
      return { ...await diagnoseEnvironment(cwd,this.store.state.settings.claudePath),cwd };
    });
    handle('workflow:list',idSchema.optional(),id => this.workflows.list(id));
    handle('workflow:create',newWorkflowSchema,input => {if(this.structured(input.sessionId).permissionMode==='plan'&&!input.stages)throw new Error('默认工作流包含实现阶段，请先手动将权限切换为默认审批，或创建仅规划的自定义阶段。');return this.workflows.create(input);});
    const workflowReady=(id:string) => {const run=this.workflows.list().find(r=>r.id===id);if(!run)throw new Error('工作流不存在。');const s=this.structured(run.sessionId);this.assertUnlocked(s);if(this.admissions.has(s.id)||BUSY.has(this.chat.taskState(s.id)))throw new Error('当前会话仍有任务，请等待完成后再开始工作流。');};
    handle('workflow:start',idSchema,id => {workflowReady(id);return this.workflows.start(id);});
    handle('workflow:continue',idSchema,id => {workflowReady(id);return this.workflows.continue(id);});
    handle('workflow:retry',idSchema,id => {workflowReady(id);return this.workflows.retry(id);});
    handle('workflow:cancel',idSchema,id => this.workflows.cancel(id));
    handle('workflow:delete',idSchema,id => this.workflows.remove(id));
    handle('workflow:export',idSchema,async id => {
      // Capture a stable, inactive record before showing a modal save dialog.
      const content=this.workflows.exportRun(id);
      const target=await dialog.showSaveDialog(this.getWindow()!,{title:'导出工作流记录',defaultPath:`workflow-${id.slice(0,8)}.json`,filters:[{name:'工作流记录 JSON',extensions:['json']}]});
      if(target.canceled || !target.filePath)return null;
      await fs.writeFile(target.filePath,content,{mode:0o600}); return target.filePath;
    });
    handle('workflow:revise',z.object({id:idSchema,stageId:shortId,instruction:z.string().min(1).max(20000)}),({id,stageId,instruction}) => this.workflows.reviseStage(id,stageId,instruction));
    handle('session:export',idSchema,id => this.export(id));
  }
  private async export(id: string) {
    const session=this.session(id);
    const isClaude=session.kind==='claude';
    const transcript=isClaude?await findClaudeTranscript(session.cwd,session.claudeId):undefined;
    const eventOnly=isClaude&&!transcript&&session.adapter==='structured';
    const target=await dialog.showSaveDialog(this.getWindow()!,{title:eventOnly?'未找到原始 CLI 对话，导出本工作台记录的事件':'导出可用会话记录',defaultPath:`session-${id.slice(0,8)}.${eventOnly?'events.jsonl':isClaude?'jsonl':'txt'}`,filters:isClaude?[{name:eventOnly?'本工作台事件（不含导入前原文）':'完整可用 CLI 对话 JSONL',extensions:['jsonl']},{name:'保留的终端日志',extensions:['txt']}]:[{name:'保留的终端日志',extensions:['txt']}]});
    if(target.canceled || !target.filePath)return null;
    if(isClaude && path.extname(target.filePath).toLowerCase()!=='.txt') {
      if(transcript) await exportClaudeTranscript(session.cwd,session.claudeId,target.filePath);
      else if(eventOnly) { const journal=this.chat.exportPath(id); await fs.copyFile(journal,target.filePath); await fs.chmod(target.filePath,0o600); }
      else throw new Error('未找到原始 CLI 对话。可重新选择导出保留的终端日志。');
    } else await fs.writeFile(target.filePath,stripVTControlCharacters(this.runtime.exportLogs(id)),{mode:0o600});
    return target.filePath;
  }
  async shutdown() {
    this.stopping=true;
    const errors:unknown[]=[];
    try { await this.workflows.shutdown(); } catch(error) { errors.push(error); }
    // A persistence failure must not prevent another runtime from terminating.
    // Keep retries live: a later quit attempt must be able to flush after recovery.
    for(const result of await Promise.allSettled([this.chat.shutdown(),this.runtime.shutdown()])) {
      if(result.status==='rejected')errors.push(result.reason);
    }
    if(errors.length)throw new AggregateError(errors,errors.map(error=>error instanceof Error?error.message:String(error)).join('\n'));
  }
}
