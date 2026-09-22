import { PERMISSION_LABELS, PERMISSION_MODES, type PermissionMode } from '../shared/permissions';

export function PermissionModeField({ label, value, disabled, onChange }: {
  label: string; value: PermissionMode; disabled?: boolean; onChange: (mode: PermissionMode) => void;
}) {
  return <label>{label}<select aria-label={label} value={value} disabled={disabled} onChange={event=>onChange(event.target.value as PermissionMode)}>
    {PERMISSION_MODES.map(mode=><option key={mode} value={mode}>{PERMISSION_LABELS[mode]}</option>)}
  </select>{value==='bypassPermissions'&&<small className="panel-note">工具可直接修改文件和执行命令；CLI 的强制限制与交互提问仍会生效。</small>}</label>;
}
