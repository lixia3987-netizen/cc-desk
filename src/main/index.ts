import { app, BrowserWindow, dialog, ipcMain, shell, Tray, Menu, nativeImage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StateStore } from './store';
import { Runtime } from './runtime';
import { SessionService } from './session-service';
import { detectCLI } from './commands';
import { createWorktree, gitInfo } from './git';
import { readHistory } from './history';
import { idSchema, sessionInputSchema, settingsSchema } from '../shared/schema';
import type { Capabilities, Project, Session } from '../shared/types';

if (!app.isPackaged && process.env.WORKBENCH_DATA_DIR) app.setPath('userData', path.resolve(process.env.WORKBENCH_DATA_DIR));
let window: BrowserWindow | null = null;
let runtime: Runtime;
let services: SessionService;
let tray: Tray | undefined;
let store: StateStore;
let closing = false;
let allowQuit = false;
let capabilities: Capabilities = { available:false, executable:'', version:'', flags:[], efforts:['default'] };
let detectionEpoch=0;
const rendererFile = path.join(__dirname, '../renderer/index.html');
const devUrl = !app.isPackaged ? process.env.WORKBENCH_DEV_URL : undefined;
if (devUrl && devUrl !== 'http://127.0.0.1:5173') throw new Error('Invalid development origin');

function notify() { if (window && !window.isDestroyed()) { window.webContents.send('workspace:state', store.state); window.webContents.send('workspace:capabilities',capabilities); } }
async function refreshCapabilities() { const epoch=++detectionEpoch; const value=await detectCLI(store.state.settings); if(epoch===detectionEpoch){capabilities=value;notify();}return capabilities; }
function assertSender(event: Electron.IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted IPC sender');
  const url = event.senderFrame.url;
  if (devUrl ? new URL(url).origin !== devUrl : !url.startsWith('file:') || path.resolve(fileURLToPath(url.split('#')[0])) !== path.resolve(rendererFile)) throw new Error('Invalid IPC origin');
}
function handle<T>(name: string, schema: z.ZodType<T>, action: (data: T) => unknown) {
  ipcMain.handle(name, (event, input) => { assertSender(event); return action(schema.parse(input)); });
}
async function addProject(value: string): Promise<Project> {
  if (!path.isAbsolute(value)) throw new Error('请选择绝对路径。');
  const canonical = await fs.realpath(value);
  if (!(await fs.stat(canonical)).isDirectory()) throw new Error('请选择文件夹。');
  const existing = store.state.projects.find(p => process.platform === 'win32' ? p.path.toLowerCase() === canonical.toLowerCase() : p.path === canonical);
  if (existing) return existing;
  const project: Project = { id: randomUUID(), name: path.basename(canonical) || canonical, path: canonical, createdAt: new Date().toISOString() };
  store.change(s => s.projects.push(project)); notify(); return project;
}
function registerIPC() {
  handle('workspace:snapshot',z.undefined(), () => ({ state:store.state, capabilities, platform:process.platform, dataPath:store.directory }));
  handle('project:choose',z.undefined(), async () => {
    const result = await dialog.showOpenDialog(window!,{ properties:['openDirectory'],title:'添加项目文件夹' });
    return result.canceled ? null : addProject(result.filePaths[0]);
  });
  handle('project:add',z.string().min(1).max(4096),addProject);
  handle('project:remove',idSchema,id => {
    if (store.state.sessions.some(s => s.projectId === id)) throw new Error('项目包含会话，请保留项目以便恢复历史。');
    store.change(s => { s.projects = s.projects.filter(p => p.id !== id); }); notify();
  });
  handle('session:create',sessionInputSchema,async input => {
    const project = store.state.projects.find(p => p.id === input.projectId);
    if (!project) throw new Error('项目不存在。');
    if (input.kind === 'shell' && (input.resumeFrom || input.fork)) throw new Error('Shell 会话不能导入 Claude 历史。');
    if (input.fork && !input.resumeFrom) throw new Error('请指定要分支的会话。');
    if (input.resumeFrom && !input.fork) {
      const existing = store.state.sessions.find(s => s.claudeId === input.resumeFrom);
      if (existing) { store.change(s => { s.sessions.find(x => x.id === existing.id)!.archived = false; }); notify(); return store.state.sessions.find(s => s.id === existing.id)!; }
    }
    const id = randomUUID();
    const source = input.fork ? store.state.sessions.find(s => s.claudeId === input.resumeFrom && s.projectId === project.id) : undefined;
    const sourcePath = source?.cwd ?? project.path;
    const worktree = input.isolated ? await createWorktree(sourcePath,store.directory,id) : undefined;
    const now = new Date().toISOString();
    const session: Session = { id, projectId:project.id, title:input.title, cwd:worktree || sourcePath,
      kind:input.kind, claudeId:input.resumeFrom && !input.fork ? input.resumeFrom : randomUUID(),
      resumeFrom:input.fork ? input.resumeFrom : undefined, imported:!!input.resumeFrom && !input.fork, started:!!input.resumeFrom && !input.fork,
      model:input.model, effort:input.effort, permissionMode:input.permissionMode,
      adapter:input.kind==='shell'?'terminal':input.adapter ?? 'terminal',taskState:'idle',draft:'',
      status:'idle',archived:false,createdAt:now,updatedAt:now,worktree,worktreeBase:worktree?sourcePath:undefined };
    store.change(s => s.sessions.unshift(session)); notify(); return session;
  });
  services.register(handle);
  handle('session:start',idSchema,id => services.start(id));
  handle('session:stop',idSchema,id => services.stop(id));
  handle('session:interrupt',idSchema,id => services.interrupt(id));
  handle('terminal:snapshot',idSchema,id => runtime.snapshot(id));
  handle('terminal:write',z.object({id:idSchema,data:z.string().max(128*1024)}),({id,data}) => runtime.write(id,data));
  handle('terminal:resize',z.object({id:idSchema,cols:z.number().int().min(2).max(500),rows:z.number().int().min(1).max(300)}),({id,cols,rows}) => runtime.resize(id,cols,rows));
  handle('settings:save',settingsSchema,async settings => { store.change(s => { s.settings = settings; }); notify(); await refreshCapabilities(); return undefined; });
  handle('cli:detect',z.undefined(),refreshCapabilities);
  handle('history:list',idSchema,async id => {
    const project = store.state.projects.find(p => p.id === id);
    if (!project) throw new Error('项目不存在。');
    return readHistory(project.path);
  });
  handle('git:info',idSchema,id => gitInfo(runtime.getSession(id).cwd));
  handle('folder:open',idSchema,async id => {
    const cwd = store.state.projects.find(p => p.id === id)?.path ?? runtime.getSession(id).cwd;
    const error = await shell.openPath(cwd);
    if (error) throw new Error(error);
  });
}

function createWindow() {
  window = new BrowserWindow({ width:1460,height:920,minWidth:980,minHeight:680,backgroundColor:'#101313',title:'Claude Workbench',
    autoHideMenuBar:true,webPreferences:{ preload:path.join(__dirname,'../preload/index.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true } });
  window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  window.webContents.on('will-navigate',event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_webContents,_permission,callback) => callback(false));
  window.on('close',event => { if (!allowQuit) { event.preventDefault(); if(store.state.settings.closeToTray && tray) window?.hide(); else void requestQuit(); } });
  window.on('closed',() => {window=null;});
  if (devUrl) void window.loadURL(devUrl); else void window.loadFile(rendererFile);
  if(!isolatedTest && !tray) {
    try {
      const pixels=Buffer.alloc(16*16*4); for(let y=3;y<13;y++) for(let x=3;x<13;x++) if(x<6||y<6||y>9){const p=(y*16+x)*4;pixels[p]=170;pixels[p+1]=200;pixels[p+2]=140;pixels[p+3]=255;}
      tray=new Tray(nativeImage.createFromBitmap(pixels,{width:16,height:16}));
      tray.setToolTip('Claude Workbench');
      tray.setContextMenu(Menu.buildFromTemplate([{label:'打开工作台',click:()=>{window?.show();window?.focus();}},{label:'退出工作台',click:()=>void requestQuit()}]));
      tray.on('click',()=>{window?.show();window?.focus();});
    } catch { tray=undefined; }
  }
}
async function requestQuit() {
  if (closing) return;
  closing = true;
  if (services?.activeCount && window) {
    const result = await dialog.showMessageBox(window,{type:'question',buttons:['保留窗口','停止会话并退出'],defaultId:0,cancelId:0,title:'退出工作台',message:`仍有 ${services.activeCount} 个会话进程运行。`,detail:'退出会停止这些进程。已保存的 Claude 对话可以在下次启动时恢复。'});
    if (result.response === 0) { closing=false; return; }
  }
  await services?.shutdown();
  allowQuit = true; app.quit();
}
// Isolated E2E instances use a disposable data directory and do not acquire the OS singleton socket.
const isolatedTest = !app.isPackaged && process.env.WORKBENCH_TEST_MODE === '1' && !!process.env.WORKBENCH_DATA_DIR;
if (!isolatedTest && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',() => { if(window?.isMinimized()) window.restore(); window?.focus(); });
  app.on('before-quit',event => { if (!allowQuit) {event.preventDefault();void requestQuit();} });
  app.whenReady().then(async () => {
    try {
      store = new StateStore(app.getPath('userData'));
      runtime = new Runtime(store,notify,chunk => { if(window && !window.isDestroyed()) window.webContents.send('terminal:data',chunk); });
      services = new SessionService(store,runtime,()=>capabilities,notify,()=>window);
      registerIPC(); createWindow();
      await refreshCapabilities();
    } catch (error) { dialog.showErrorBox('启动失败',String((error as Error).message));allowQuit=true;app.quit(); }
  });
}
