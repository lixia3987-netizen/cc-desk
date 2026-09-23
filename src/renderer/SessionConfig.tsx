import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import type { Capabilities, Effort, Session } from '../shared/types';
import { isSessionBusy } from '../shared/session-activity';
import { PermissionModeField } from './PermissionModeField';

export function SessionConfig({session,capabilities,onError}:{session:Session;capabilities:Capabilities;onError:(error:unknown)=>void}) {
  const [model,setModel]=useState(session.model),[effort,setEffort]=useState(session.effort),[permission,setPermission]=useState(session.permissionMode),[busy,setBusy]=useState(false),[saved,setSaved]=useState(false);
  useEffect(()=>{setModel(session.model);setEffort(session.effort);setPermission(session.permissionMode);setSaved(false);},[session.id,session.model,session.effort,session.permissionMode]);
  const locked=busy||isSessionBusy(session)||(session.execution.mode!=='structured'&&session.status==='running');
  const restarts=session.execution.mode==='structured'&&session.status==='running'&&permission!==session.permissionMode&&(permission==='bypassPermissions'||session.permissionMode==='bypassPermissions');
  return <form className="session-config" onSubmit={event=>{event.preventDefault();setBusy(true);void window.desktop.updateSession({id:session.id,model,effort,permissionMode:permission}).then(()=>setSaved(true)).catch(onError).finally(()=>setBusy(false));}}>
    <h4>运行配置</h4>{session.observedPermissionMode&&<p className="panel-note">{session.status==='running'?'CLI 当前权限':'已保存权限'}：{session.observedPermissionMode}</p>}
    <label>模型<input aria-label="会话模型" value={model} placeholder="跟随 CLI" disabled={locked} onChange={e=>{setModel(e.target.value);setSaved(false);}}/></label>
    <label>推理强度<select aria-label="会话推理强度" value={effort} disabled={locked} onChange={e=>{setEffort(e.target.value as Effort);setSaved(false);}}>{Array.from(new Set([...capabilities.efforts,session.effort])).map(value=><option key={value} value={value}>{value==='default'?'默认':value}</option>)}</select></label>
    <PermissionModeField label="会话权限模式" value={permission} disabled={locked} onChange={mode=>{setPermission(mode);setSaved(false);}}/>
    {restarts&&<p className="panel-note">切换 Bypass 时会停止空闲 CLI，下次发送自动恢复原会话。</p>}
    <button className="secondary compact full" disabled={locked}><Check size={12}/>{saved?'已保存':'保存配置'}</button>
    <p className="panel-note">{locked?'任务结束或停止会话后可修改。':session.execution.mode==='structured'?'配置用于下一轮任务。':'配置用于下一次启动终端。终端内部变更可能尚未同步。'}</p>
  </form>;
}
