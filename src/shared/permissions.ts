export const PERMISSION_MODES = ['default', 'plan', 'acceptEdits', 'bypassPermissions'] as const;
export type PermissionMode = typeof PERMISSION_MODES[number];

export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  default: '默认 · 按需审批',
  plan: 'Plan · 只做规划',
  acceptEdits: '自动接受文件编辑',
  bypassPermissions: 'Bypass · 跳过权限确认',
};

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}
