import { useEffect, useRef, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import type { Session } from '../shared/types';
import type { EngineConfigField, ExecutionDescriptor } from '../shared/execution';
import type { NativePermissionMode } from '../shared/native-permissions';
import { isSessionBusy } from '../shared/session-activity';
import { configurationSupported } from './EngineConfiguration';

interface Props {
  session: Session; descriptor?: ExecutionDescriptor; disabled?: boolean; running?: boolean;
  isBlocked?(): boolean;
  onError(error: unknown): void; onBusyChange?(busy: boolean): void;
}

function PermissionSelection({ session, descriptor, field, disabled, running, isBlocked, onError, onBusyChange }: Props & {
  descriptor: ExecutionDescriptor; field: EngineConfigField;
}) {
  const native = session.execution.providerId === 'native';
  const persisted = typeof session.engineConfig.options.permissionMode === 'string'
    ? session.engineConfig.options.permissionMode : native ? 'default' : String(descriptor.configuration?.defaults.options.permissionMode ?? 'default');
  const [value, setValue] = useState(persisted), [saving, setSaving] = useState(false);
  const pending = useRef(false), mounted = useRef(true), latest = useRef(session);
  latest.current = session;
  useEffect(() => { if (!pending.current) setValue(persisted); }, [persisted]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; onBusyChange?.(false); };
  }, [onBusyChange]);
  const blocked = disabled || saving || session.archived || session.status === 'stopping' || descriptor.maintenance
    || !configurationSupported(descriptor, session.engineConfig)
    || !native && (isSessionBusy(session) || session.execution.mode === 'terminal' && session.status === 'running');
  const change = async (next: string) => {
    if (pending.current || blocked || isBlocked?.() || !field.options?.some(option => option.value === next) || next === value) return;
    pending.current = true; setSaving(true); setValue(next); onBusyChange?.(true);
    try {
      if (native) await window.desktop.setNativePermissionMode(session.id, next as NativePermissionMode);
      else await window.desktop.updateSession({ id: session.id, engineConfig: {
        ...latest.current.engineConfig, options: { ...latest.current.engineConfig.options, permissionMode: next },
      } });
    } catch (error) {
      if (mounted.current) {
        const saved = latest.current.engineConfig.options.permissionMode;
        setValue(typeof saved === 'string' ? saved : native ? 'default' : String(descriptor.configuration?.defaults.options.permissionMode ?? 'default'));
        onError(error);
      }
    } finally {
      pending.current = false;
      if (mounted.current) { setSaving(false); onBusyChange?.(false); }
    }
  };
  const hint = saving ? '保存中…' : native && running ? '下轮生效' : !native && blocked && running ? '任务结束后可切换' : '';
  return <label className="composer-permission" title={native && running
    ? '选择后自动保存并用于下一轮，本轮执行及待处理审批仍使用原权限。'
    : '当前会话的权限模式，选择后自动保存。'}>
    <ShieldCheck size={14}/><span>权限</span>
    <select aria-label="发送权限模式" value={value} disabled={!!blocked} onChange={event => void change(event.target.value)}>
      {!field.options?.some(option => option.value === value) && <option value={value}>{value} · 当前保存值</option>}
      {field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    {hint && <small role="status">{saving && <Loader2 size={12} className="spin"/>}{hint}</small>}
  </label>;
}

export function ComposerPermissionMode(props: Props) {
  const field = props.descriptor?.configuration?.fields.find(field => field.key === 'permissionMode' && field.type === 'select');
  return field && props.descriptor ? <PermissionSelection key={props.session.id} {...props} descriptor={props.descriptor} field={field}/> : null;
}
