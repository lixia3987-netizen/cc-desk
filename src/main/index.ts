import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, Tray, Menu, nativeImage, nativeTheme } from 'electron';
import fs from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StateStore } from './store';
import { Runtime } from './runtime';
import { SessionService } from './session-service';
import { detectCLI } from './commands';
import { openIde } from './ide';
import { cleanupWorktree, createWorktree, gitInfo } from './git';
import { sanitizeWorktreeName } from './worktree-paths';
import { readHistory } from './history';
import { idSchema, sessionInputSchema, settingsSchema } from '../shared/schema';
import type { Capabilities, Project, Session } from '../shared/types';
import { normalizeThemeId, THEME_APPEARANCE } from '../shared/theme';

const profileDirectory=app.commandLine.getSwitchValue('user-data-dir');
if(profileDirectory) {
  if(!path.isAbsolute(profileDirectory)||profileDirectory.length>4096)throw new Error('自定义数据目录必须是有效的绝对路径。');
  mkdirSync(profileDirectory,{recursive:true,mode:0o700});app.setPath('userData',path.resolve(profileDirectory));
} else if (!app.isPackaged && process.env.WORKBENCH_DATA_DIR) app.setPath('userData', path.resolve(process.env.WORKBENCH_DATA_DIR));
let window: BrowserWindow | null = null;
let runtime: Runtime;
let services: SessionService;
let tray: Tray | undefined;
let store: StateStore;
let closing = false;
let allowQuit = false;
let capabilities: Capabilities = { available:false, executable:'', version:'', flags:[], efforts:['default'] };
let detectionEpoch=0;
const projectCreations=new Map<string,number>();
const rendererFile = path.join(__dirname, '../renderer/index.html');
const devUrl = !app.isPackaged ? process.env.WORKBENCH_DEV_URL : undefined;
if (devUrl && devUrl !== 'http://127.0.0.1:5173') throw new Error('Invalid development origin');

let notifyTimer:NodeJS.Timeout|undefined;
let sentCapabilities:Capabilities|undefined;
function notify() {
  if(notifyTimer)return;
  notifyTimer=setTimeout(()=>{
    notifyTimer=undefined;
    if(window&&!window.isDestroyed()) {
      window.webContents.send('workspace:state',store.state);
      if(sentCapabilities!==capabilities){sentCapabilities=capabilities;window.webContents.send('workspace:capabilities',capabilities);}
    }
  },40);
}
function reportPersistenceError() { if(window&&!window.isDestroyed())window.webContents.send('workspace:error','工作区保存失败，请检查磁盘空间和目录权限；退出前请重试保存。'); }
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
  // Explicit write-only bridge; web permission requests remain denied.
  handle('clipboard:write-text',z.string().max(4*1024*1024).refine(text=>Buffer.byteLength(text,'utf8')<=4*1024*1024,'复制内容不能超过 4 MiB。'),text=>clipboard.writeText(text));
  handle('project:choose',z.undefined(), async () => {
    const result = await dialog.showOpenDialog(window!,{ properties:['openDirectory'],title:'添加项目文件夹' });
    return result.canceled ? null : addProject(result.filePaths[0]);
  });
  handle('project:add',z.string().min(1).max(4096),addProject);
  handle('project:remove',idSchema,id => {
    if(projectCreations.has(id))throw new Error('项目正在创建会话，请稍后重试。');
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
    // Capture placement before asynchronous creation; later settings changes affect the next session.
    const location = store.state.settings.worktreeLocation ?? 'project';
    const customRoot = store.state.settings.worktreeRoot;
    projectCreations.set(project.id,(projectCreations.get(project.id)??0)+1);
    try { return await services.withSessionCreation(sourcePath,input.isolated,async()=>{
    const worktree = input.isolated ? await createWorktree(sourcePath,store.directory,id,{
      location, customRoot, projectPath:project.path, projectName:project.name,
      name:input.worktreeName?.trim() || sanitizeWorktreeName(input.title),
    }) : undefined;
    const now = new Date().toISOString();
    const session: Session = { id, projectId:project.id, title:input.title, cwd:worktree || sourcePath,
      kind:input.kind, claudeId:input.resumeFrom && !input.fork ? input.resumeFrom : randomUUID(),
      resumeFrom:input.fork ? input.resumeFrom : undefined, imported:!!input.resumeFrom && !input.fork, started:!!input.resumeFrom && !input.fork,
      model:input.model, effort:input.effort, permissionMode:input.permissionMode ?? source?.permissionMode ?? (input.kind==='claude'?store.state.settings.defaultPermissionMode ?? 'default':'default'),
      adapter:input.kind==='shell'?'terminal':input.adapter ?? 'terminal',taskState:'idle',draft:'',
      status:'idle',archived:false,createdAt:now,updatedAt:now,worktree,worktreeBase:worktree?sourcePath:undefined };
    try {store.change(s => s.sessions.unshift(session));}
    catch(error) {
      if(worktree) {
        const cleanup=await cleanupWorktree(sourcePath,worktree,id,false).catch(()=>undefined);
        if(!cleanup?.ok)throw new Error('会话保存失败；新建的工作目录已保留，请检查磁盘后处理：'+worktree);
      }
      throw error;
    }
    notify(); return session;
    },input.isolated && location === 'project' ? project.path : undefined); } finally {
      const count=(projectCreations.get(project.id)??1)-1;
      if(count)projectCreations.set(project.id,count);else projectCreations.delete(project.id);
    }
  });
  services.register(handle);
  handle('session:start',idSchema,id => services.start(id));
  handle('session:stop',idSchema,id => services.stop(id));
  handle('session:interrupt',idSchema,id => services.interrupt(id));
  handle('terminal:snapshot',idSchema,id => runtime.snapshot(id));
  handle('terminal:write',z.object({id:idSchema,data:z.string().max(128*1024)}),({id,data}) => runtime.write(id,data));
  handle('terminal:resize',z.object({id:idSchema,cols:z.number().int().min(2).max(500),rows:z.number().int().min(1).max(300)}),({id,cols,rows}) => runtime.resize(id,cols,rows));
  handle('settings:save',settingsSchema,async settings => {
    if(settings.worktreeLocation === 'custom' && !path.isAbsolute(settings.worktreeRoot))throw new Error('统一 Worktree 根目录必须是绝对路径。');
    const cliChanged=settings.claudePath!==store.state.settings.claudePath;
    store.change(s => { s.settings = settings; });
    const appearance=THEME_APPEARANCE[normalizeThemeId(settings.theme)];nativeTheme.themeSource=appearance.scheme;
    if(window&&!window.isDestroyed())window.setBackgroundColor(appearance.background);
    notify();if(cliChanged)await refreshCapabilities();return undefined;
  });
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
  handle('ide:choose',z.undefined(),async () => {
    const filters = process.platform === 'win32' ? [{name:'IDE 应用',extensions:['exe']}]
      : process.platform === 'darwin' ? [{name:'IDE 应用',extensions:['app']},{name:'所有文件',extensions:['*']}] : undefined;
    // On macOS, .app packages remain selectable applications, not navigable folders.
    const result = await dialog.showOpenDialog(window!,{properties:['openFile'],title:'选择 IDE 应用',buttonLabel:'选择应用',filters});
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle('worktree:choose-root',z.undefined(),async () => {
    const result = await dialog.showOpenDialog(window!,{properties:['openDirectory','createDirectory'],title:'选择统一 Worktree 根目录',buttonLabel:'选择目录',defaultPath:store.state.settings.worktreeRoot || undefined});
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle('ide:open',idSchema,id => {
    const cwd = store.state.projects.find(p => p.id === id)?.path ?? runtime.getSession(id).cwd;
    return openIde(store.state.settings.idePath,cwd);
  });
}

function createWindow() {
  nativeTheme.themeSource=THEME_APPEARANCE[normalizeThemeId(store.state.settings.theme)].scheme;
  window = new BrowserWindow({ width:1460,height:920,minWidth:980,minHeight:680,backgroundColor:THEME_APPEARANCE[normalizeThemeId(store.state.settings.theme)].background,title:'Claude Workbench',
    autoHideMenuBar:true,webPreferences:{ preload:path.join(__dirname,'../preload/index.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true } });
  window.webContents.setWindowOpenHandler(({url}) => {
    try { const parsed=new URL(url);if(['https:','http:'].includes(parsed.protocol)&&!parsed.username&&!parsed.password)void shell.openExternal(parsed.href).catch(()=>{}); } catch { /* Ignore invalid links. */ }
    return {action:'deny'};
  });
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
      tray.setContextMenu(Menu.buildFromTemplate([{label:'打开工作台',click:showWindow},{label:'退出工作台',click:()=>void requestQuit()}]));
      tray.on('click',showWindow);
    } catch { tray=undefined; }
  }
}
function showWindow() {
  if(!window&&store&&app.isReady())createWindow();
  if(window&&!window.isDestroyed()){if(window.isMinimized())window.restore();window.show();window.focus();}
}
async function requestQuit() {
  if (closing) return;
  closing = true;
  if (services?.activeCount && window) {
    const result = await dialog.showMessageBox(window,{type:'question',buttons:['保留窗口','停止会话并退出'],defaultId:0,cancelId:0,title:'退出工作台',message:`仍有 ${services.activeCount} 个会话进程运行。`,detail:'退出会停止这些进程。已保存的 Claude 对话可以在下次启动时恢复。'});
    if (result.response === 0) { closing=false; return; }
  }
  try {
    await services?.shutdown();
    store?.flush();
    allowQuit = true; app.quit();
  } catch {
    closing=false;showWindow();reportPersistenceError();
    // Keep the app open so the user can fix storage and retry; resources have
    // already been stopped independently of the failing persistence operation.
  }
}
// Isolated E2E instances use a disposable data directory and do not acquire the OS singleton socket.
const isolatedTest = !app.isPackaged && process.env.WORKBENCH_TEST_MODE === '1' && !!process.env.WORKBENCH_DATA_DIR;
if (!isolatedTest && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',showWindow);
  app.on('activate',showWindow);
  app.on('before-quit',event => { if (!allowQuit) {event.preventDefault();void requestQuit();} });
  app.whenReady().then(async () => {
    try {
      store = new StateStore(app.getPath('userData'),{onError:reportPersistenceError});
      runtime = new Runtime(store,notify,chunk => { if(window && !window.isDestroyed()) window.webContents.send('terminal:data',chunk); },{onError:reportPersistenceError});
      services = new SessionService(store,runtime,()=>capabilities,notify,()=>window);
      registerIPC(); createWindow();
      await refreshCapabilities();
    } catch (error) { dialog.showErrorBox('启动失败',String((error as Error).message));allowQuit=true;app.quit(); }
  });
}
