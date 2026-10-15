import { ShieldCheck } from 'lucide-react';
import type { EngineConfig, ExecutionDescriptor } from '../../shared/execution';
import { configurationSupported } from '../EngineConfiguration';

interface Props {
  value: EngineConfig; descriptor?: ExecutionDescriptor; disabled?: boolean;
  onChange(value: EngineConfig): void;
}

export function NewSessionPermissionMode({ value, descriptor, disabled, onChange }: Props) {
  const field = descriptor?.configuration?.fields.find(field => field.key === 'permissionMode' && field.type === 'select');
  if (!field || !descriptor) return null;
  const raw = value.options.permissionMode ?? descriptor.configuration?.defaults.options.permissionMode ?? 'default';
  const scalar = typeof raw === 'string';
  const selected = scalar ? raw : JSON.stringify(raw);
  const blocked = !!disabled || !scalar || !configurationSupported(descriptor, value);
  return <label className="composer-permission" title="新会话的权限模式，从首条消息开始生效。默认值可在设置中调整。">
    <ShieldCheck size={14}/><span>权限</span>
    <select aria-label="新会话权限模式" value={selected} disabled={blocked} onChange={event => {
      const next = event.target.value;
      if (!blocked && field.options?.some(option => option.value === next)) {
        onChange({ ...value, options: { ...value.options, permissionMode: next } });
      }
    }}>
      {!field.options?.some(option => option.value === selected) && <option value={selected}>{selected} · 当前保存值</option>}
      {field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </label>;
}
