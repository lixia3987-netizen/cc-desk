import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';
import { StateStore } from './store';
import { Runtime } from './runtime';
import { detectCLI } from './commands';
import { createWorktree, gitInfo } from './git';
import { readHistory } from './history';
import { idSchema, sessionInputSchema, settingsSchema } from '../shared/schema';
import type { Capabilities, Project, Session } from '../shared/types';

if (!app.isPackaged && process.env.WORKBENCH_DATA_DIR) app.setPath('userData', path.resolve(process.env.WORKBENCH_DATA_DIR));
let window: BrowserWindow | null = null;
let runtime: Runtime;
let store: StateStore;
let closing = false;
let allowQuit = false;
let capabilities: Capabilities = { available:false, executable:'', version:'', flags:[], efforts:['default'] };
const rendererFile = path.join(__dirname, '../renderer/index.html');
const devUrl = !app.isPackaged ? process.env.WORKBENCH_DEV_URL : undefined;
if (devUrl && devUrl !== 'http://127.0.0.1:5173') throw new Error('Invalid development origin');

function notify() { if (window && !window.isDestroyed()) window.webContents.send('workspace:state', store.state); }
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
      status:'idle',archived:false,createdAt:now,updatedAt:now,worktree };
    store.change(s => s.sessions.unshift(session)); notify(); return session;
  });
  handle('session:update',z.object({ id:idSchema,title:z.string().trim().min(1).max(120).optional(),archived:z.boolean().optional() }),input => {
    const current = runtime.getSession(input.id);
    if (input.archived && ['running','stopping'].includes(current.status)) throw new Error('请先停止会话，再归档。');
    store.change(s => Object.assign(s.sessions.find(x => x.id === input.id)!,input,{updatedAt:new Date().toISOString()})); notify();
  });
  handle('session:start',idSchema,id => runtime.start(id,capabilities));
  handle('session:stop',idSchema,id => runtime.stop(id));
  handle('session:interrupt',idSchema,id => runtime.interrupt(id));
  handle('terminal:snapshot',idSchema,id => runtime.snapshot(id));
  handle('terminal:write',z.object({id:idSchema,data:z.string().max(128*1024)}),({id,data}) => runtime.write(id,data));
  handle('terminal:resize',z.object({id:idSchema,cols:z.number().int().min(2).max(500),rows:z.number().int().min(1).max(300)}),({id,cols,rows}) => runtime.resize(id,cols,rows));
  handle('settings:save',settingsSchema,async settings => { store.change(s => { s.settings = settings; }); notify(); capabilities = await detectCLI(settings); return undefined; });
  handle('cli:detect',z.undefined(),async () => { capabilities = await detectCLI(store.state.settings); return capabilities; });
  handle('history:list',idSchema,async id => {
    const project = store.state.projects.find(p => p.id === id);
    if (!project) throw new Error('项目不存在。');
    return readHistory(project.path);
  });
  handle('git:info',idSchema,id => gitInfo(runtime.getSession(id).cwd));
  handle('session:export',idSchema,async id => {
    runtime.getSession(id);
    const target = await dialog.showSaveDialog(window!,{defaultPath:`session-${id.slice(0,8)}.txt`,filters:[{name:'Text',extensions:['txt']}]});
    if (target.canceled || !target.filePath) return null;
    runtime.snapshot(id);
    let text = '';
    try { text = await fs.readFile(runtime.logPath(id),'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await fs.writeFile(target.filePath,stripVTControlCharacters(text),{mode:0o600});
    return target.filePath;
  });
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
  window.on('close',event => { if (!allowQuit) { event.preventDefault(); void requestQuit(); } });
  window.on('closed',() => {window=null;});
  if (devUrl) void window.loadURL(devUrl); else void window.loadFile(rendererFile);
}
async function requestQuit() {
  if (closing) return;
  closing = true;
  if (runtime?.activeCount && window) {
    const result = await dialog.showMessageBox(window,{type:'question',buttons:['保留窗口','停止会话并退出'],defaultId:0,cancelId:0,title:'退出工作台',message:`仍有 ${runtime.activeCount} 个会话进程运行。`,detail:'退出会停止这些进程。已保存的 Claude 对话可以在下次启动时恢复。'});
    if (result.response === 0) { closing=false; return; }
  }
  await runtime?.shutdown();
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
      registerIPC(); createWindow();
      capabilities = await detectCLI(store.state.settings);
      notify();
    } catch (error) { dialog.showErrorBox('启动失败',String((error as Error).message));allowQuit=true;app.quit(); }
  });
}
