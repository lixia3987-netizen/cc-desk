import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from '../shared/types';
const api: DesktopAPI = {
  snapshot:() => ipcRenderer.invoke('workspace:snapshot'),
  chooseProject:() => ipcRenderer.invoke('project:choose'),
  addProject:path => ipcRenderer.invoke('project:add',path),
  removeProject:id => ipcRenderer.invoke('project:remove',id),
  createSession:input => ipcRenderer.invoke('session:create',input),
  updateSession:input => ipcRenderer.invoke('session:update',input),
  startSession:id => ipcRenderer.invoke('session:start',id),
  stopSession:id => ipcRenderer.invoke('session:stop',id),
  interruptSession:id => ipcRenderer.invoke('session:interrupt',id),
  terminalSnapshot:id => ipcRenderer.invoke('terminal:snapshot',id),
  writeTerminal:(id,data) => ipcRenderer.invoke('terminal:write',{id,data}),
  resizeTerminal:(id,cols,rows) => ipcRenderer.invoke('terminal:resize',{id,cols,rows}),
  saveSettings:settings => ipcRenderer.invoke('settings:save',settings),
  detect:() => ipcRenderer.invoke('cli:detect'),
  history:projectId => ipcRenderer.invoke('history:list',projectId),
  gitInfo:sessionId => ipcRenderer.invoke('git:info',sessionId),
  exportTranscript:id => ipcRenderer.invoke('session:export',id),
  openFolder:id => ipcRenderer.invoke('folder:open',id),
  onState:callback => { const listener = (_event:Electron.IpcRendererEvent,data:Parameters<typeof callback>[0]) => callback(data);ipcRenderer.on('workspace:state',listener);return () => ipcRenderer.removeListener('workspace:state',listener); },
  onTerminal:callback => {const listener = (_event:Electron.IpcRendererEvent,data:Parameters<typeof callback>[0]) => callback(data);ipcRenderer.on('terminal:data',listener);return () => ipcRenderer.removeListener('terminal:data',listener);}
};
contextBridge.exposeInMainWorld('desktop',api);
