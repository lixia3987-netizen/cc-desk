import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, Tray, Menu, nativeImage, nativeTheme, net } from 'electron';
import fs from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StateStore } from './store';
import { createExecutors } from './execution/create-executors';
import type { ExecutionRegistry } from './execution/registry';
import { SessionCreation } from './session-creation';
import { SessionService } from './session-service';
import { detectCLI } from './commands';
import { CLIUpdater } from './cli-updater';
import { CLIUpdateService } from './cli-update-service';
import { openIde } from './ide';
import { gitInfo } from './git';
import { diagnoseEnvironment } from './diagnostics';
import { queryHistory } from './history';
import { HistorySources } from './execution/history-sources';
import { idSchema, providerIdSchema, sessionInputSchema, settingsSchema } from '../shared/schema';
import type { Capabilities, Project } from '../shared/types';
import { normalizeThemeId, THEME_APPEARANCE } from '../shared/theme';
import { FontLibrary } from './font-library';
import { IMPORTED_FONT_ID } from '../shared/fonts';
import { allowsLocalFonts, isTrustedRendererUrl } from './renderer-permissions';

const profileDirectory=app.commandLine.getSwitchValue('user-data-dir');
if(profileDirectory) {
  if(!path.isAbsolute(profileDirectory)||profileDirectory.length>4096)throw new Error('自定义数据目录必须是有效的绝对路径。');
  mkdirSync(profileDirectory,{recursive:true,mode:0o700});app.setPath('userData',path.resolve(profileDirectory));
} else if (!app.isPackaged && process.env.WORKBENCH_DATA_DIR) app.setPath('userData', path.resolve(process.env.WORKBENCH_DATA_DIR));
let window: BrowserWindow | null = null;
let executors: ExecutionRegistry;
let sessionCreation: SessionCreation;
let services: SessionService;
const historySources = new HistorySources();
historySources.register('claude', queryHistory);
let tray: Tray | undefined;
let store: StateStore;
let fonts: FontLibrary;
let cliUpdates: CLIUpdateService;
let closing = false;
let allowQuit = false;
let capabilities: Capabilities = { available:false, executable:'', version:'', flags:[], efforts:['default'] };
let detectionEpoch=0;
const rendererFile = path.join(__dirname, '../renderer/index.html');
const devUrl = !app.isPackaged ? process.env.WORKBENCH_DEV_URL : undefined;
if (devUrl && devUrl !== 'http://127.0.0.1:5173') throw new Error('Invalid development origin');

let notifyTimer:NodeJS.Timeout|undefined;
let sentCapabilities:Capabilities|undefined;
let sentExecutors = '';
function notify() {
  if(notifyTimer)return;
  notifyTimer=setTimeout(()=>{
    notifyTimer=undefined;
    if(window&&!window.isDestroyed()) {
      window.webContents.send('workspace:state',store.state);
      if(sentCapabilities!==capabilities){sentCapabilities=capabilities;window.webContents.send('workspace:capabilities',capabilities);}
      const descriptions = executors.descriptors(), encoded = JSON.stringify(descriptions);
      if (encoded !== sentExecutors) { sentExecutors = encoded; window.webContents.send('workspace:executors', descriptions); }
    }
  },40);
}
function reportPersistenceError() { if(window&&!window.isDestroyed())window.webContents.send('workspace:error','工作区保存失败，请检查磁盘空间和目录权限；退出前请重试保存。'); }
async function refreshCapabilities() { const epoch=++detectionEpoch; const value=await detectCLI(store.state.settings); if(epoch===detectionEpoch){capabilities=value;notify();}return capabilities; }
function assertSender(event: Electron.IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted IPC sender');
  const url = event.senderFrame.url;
  if (!isTrustedRendererUrl(url, rendererFile, devUrl)) throw new Error('Invalid IPC origin');
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
  handle('workspace:snapshot',z.undefined(), () => ({ state:store.state, capabilities, executors:executors.descriptors(), cliUpdate:cliUpdates.state, platform:process.platform, dataPath:store.directory }));
  // Explicit write-only bridge; browser clipboard permissions remain denied.
  handle('clipboard:write-text',z.string().max(4*1024*1024).refine(text=>Buffer.byteLength(text,'utf8')<=4*1024*1024,'复制内容不能超过 4 MiB。'),text=>clipboard.writeText(text));
  handle('project:choose',z.undefined(), async () => {
    const result = await dialog.showOpenDialog(window!,{ properties:['openDirectory'],title:'添加项目文件夹' });
    return result.canceled ? null : addProject(result.filePaths[0]);
  });
  handle('project:add',z.string().min(1).max(4096),addProject);
  handle('project:remove',idSchema,id => {
    if(sessionCreation.pending(id))throw new Error('项目正在创建会话，请稍后重试。');
    if (store.state.sessions.some(s => s.projectId === id)) throw new Error('项目包含会话，请保留项目以便恢复历史。');
    store.change(s => { s.projects = s.projects.filter(p => p.id !== id); }); notify();
  });
  handle('session:create',sessionInputSchema,input => sessionCreation.create(input));
  services.register(handle);
  handle('session:start',idSchema,id => services.start(id));
  handle('session:stop',idSchema,id => services.stop(id));
  handle('session:interrupt',idSchema,id => services.interrupt(id));
  handle('terminal:snapshot',idSchema,id => services.runtime.snapshot(id));
  handle('terminal:write',z.object({id:idSchema,data:z.string().max(128*1024)}),({id,data}) => {services.assertEngineAvailable(executors.getSession(id).execution.providerId);services.runtime.write(id,data);});
  handle('terminal:resize',z.object({id:idSchema,cols:z.number().int().min(2).max(500),rows:z.number().int().min(1).max(300)}),({id,cols,rows}) => {services.assertEngineAvailable(executors.getSession(id).execution.providerId);services.runtime.resize(id,cols,rows);});
  handle('settings:save',settingsSchema,async settings => {
    for (const key of ['chatFontFamily', 'uiFontFamily'] as const) {
      if (IMPORTED_FONT_ID.test(settings[key]) && settings[key] !== store.state.settings[key] && !fonts.list().some(font => font.id === settings[key])) throw new Error('所选字体已被移除，请重新选择。');
    }
    if(settings.worktreeLocation === 'custom' && !path.isAbsolute(settings.worktreeRoot))throw new Error('统一 Worktree 根目录必须是绝对路径。');
    const cliChanged=settings.claudePath!==store.state.settings.claudePath;
    if(cliChanged)cliUpdates.assertIdle();
    for (const [providerId, config] of Object.entries(settings.engineDefaults)) {
      if (isDeepStrictEqual(config, store.state.settings.engineDefaults[providerId])) continue;
      const descriptor = executors.descriptors().find(item => item.providerId === providerId);
      if (descriptor) {
        services.assertEngineAvailable(providerId);
        settings.engineDefaults[providerId] = executors.defaultConfig(providerId, descriptor.mode, config);
      }
      // Unknown provider defaults are retained as opaque, bounded JSON.
    }
    store.change(s => { s.settings = settings; });
    const appearance=THEME_APPEARANCE[normalizeThemeId(settings.theme)];nativeTheme.themeSource=appearance.scheme;
    if(window&&!window.isDestroyed())window.setBackgroundColor(appearance.background);
    notify();if(cliChanged){cliUpdates.reset();await refreshCapabilities();void cliUpdates.check();}return undefined;
  });
  handle('cli:detect',z.undefined(),()=>{cliUpdates.assertIdle();return refreshCapabilities();});
  handle('cli-update:check',z.undefined(),()=>cliUpdates.check());
  handle('cli-update:dismiss',z.undefined(),()=>cliUpdates.dismiss());
  handle('cli-update:apply',z.undefined(),()=>{if(closing)throw new Error('工作台正在退出。');return cliUpdates.update();});
  handle('fonts:list',z.undefined(),() => fonts.list());
  handle('fonts:read',z.string().regex(IMPORTED_FONT_ID),id => fonts.read(id));
  handle('fonts:import',z.undefined(),async () => {
    const result = await dialog.showOpenDialog(window!,{title:'导入字体',buttonLabel:'导入',properties:['openFile'],filters:[{name:'字体文件',extensions:['ttf','otf','woff','woff2']}]});
    return result.canceled || !result.filePaths[0] ? null : fonts.importFile(result.filePaths[0]);
  });
  handle('fonts:remove',z.string().regex(IMPORTED_FONT_ID),id => {
    store.change(state => {
      if (state.settings.chatFontFamily === id) state.settings.chatFontFamily = 'system';
      if (state.settings.uiFontFamily === id) state.settings.uiFontFamily = 'system';
    });
    try { fonts.remove(id); } finally { notify(); }
  });
  handle('history:list',z.union([idSchema,z.object({projectId:idSchema,providerId:providerIdSchema.optional()}).strict()]),async input => {
    const projectId = typeof input === 'string' ? input : input.projectId;
    const providerId = typeof input === 'string' ? 'claude' : input.providerId;
    const project = store.state.projects.find(p => p.id === projectId);
    if (!project) throw new Error('项目不存在。');
    return (await historySources.query(project.path, {providerId, limit: 100})).entries;
  });
  handle('git:info',idSchema,id => gitInfo(executors.getSession(id).cwd));
  handle('folder:open',idSchema,async id => {
    const cwd = store.state.projects.find(p => p.id === id)?.path ?? executors.getSession(id).cwd;
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
    const cwd = store.state.projects.find(p => p.id === id)?.path ?? executors.getSession(id).cwd;
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
  window.webContents.session.setPermissionCheckHandler((contents,permission,_origin,details) => allowsLocalFonts(permission,contents === window?.webContents,details,rendererFile,devUrl));
  window.webContents.session.setPermissionRequestHandler((contents,permission,callback,details) => callback(allowsLocalFonts(permission,contents === window?.webContents,details,rendererFile,devUrl)));
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
  if(cliUpdates?.state.phase==='updating'){showWindow();if(window)await dialog.showMessageBox(window,{type:'info',buttons:['返回工作台'],title:'Claude Code 正在安装更新',message:'请等待安装完成后再退出工作台。正在写入的 CLI 安装不能安全中断。'});return;}
  cliUpdates?.cancelPendingUpdate();
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
      fonts = new FontLibrary(store.directory);
      executors = createExecutors(store,()=>capabilities,reportPersistenceError);
      services = new SessionService(store,executors,notify,()=>window,{
        history:(cwd,options)=>historySources.query(cwd,options), diagnose:cwd=>diagnoseEnvironment(cwd,store.state.settings.claudePath),
      });
      sessionCreation = new SessionCreation(store,services,notify,'claude');
      const updater = new CLIUpdater(()=>store.state.settings,(url,options)=>net.fetch(url,options));
      cliUpdates = new CLIUpdateService({
        check:()=>updater.check(), verify:async candidate=>{await updater.verify(candidate);},
        install:candidate=>updater.install(candidate), refresh:refreshCapabilities,
        disconnect:action=>services.withEngineMaintenance('claude',action),
        confirm:async candidate=>{
          if(!window||window.isDestroyed())return false;
          const result=await dialog.showMessageBox(window,{type:'warning',title:'更新 Claude Code CLI',
            message:`将 Claude Code 从 ${candidate.currentVersion} 更新至 ${candidate.latestVersion}？`,
            detail:`更新前会暂停 ${store.state.sessions.filter(session=>session.execution.providerId==='claude').length} 个 Claude 会话的队列，停止其中的任务、终端及工作流（当前 ${services.activeCountForEngine('claude')} 个活动会话）。Shell 和其他引擎继续运行。项目、会话历史和已保存草稿会保留；Claude 任务在更新结束后需手动恢复。`,
            buttons:['取消','停止 Claude 会话并更新'],defaultId:0,cancelId:0,noLink:true});
          return result.response===1;
        },
        changed:state=>{if(window&&!window.isDestroyed())window.webContents.send('cli-update:state',state);},
      });
      registerIPC(); createWindow();
      await refreshCapabilities();
      void cliUpdates.check();
    } catch (error) { dialog.showErrorBox('启动失败',String((error as Error).message));allowQuit=true;app.quit(); }
  });
}
