export const NATIVE_PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions'] as const;
export type NativePermissionMode = typeof NATIVE_PERMISSION_MODES[number];
export const NATIVE_PERMISSION_LABELS: Record<NativePermissionMode, string> = {
  default: '逐次审批',
  acceptEdits: '自动允许文件编辑',
  bypassPermissions: '自动允许工具执行',
};

const fileEditTools = new Set(['apply_patch', 'edit_file', 'apply_change_set']);

/** 仅主进程已知的文件编辑工具符合条件，远程写入仍需审批。 */
export function nativeAutoApproves(mode: NativePermissionMode, tool: { name: string; risk: string }): boolean {
  if (tool.name === 'ask_user') return false;
  return mode === 'bypassPermissions' || mode === 'acceptEdits' && tool.risk === 'write' && fileEditTools.has(tool.name);
}

export function nativePermissionInstructions(mode: NativePermissionMode): string {
  if (mode === 'bypassPermissions') return 'The user enabled automatic tool approval for this run. The host authorizes tools without individual prompts; user questions still require an answer. Follow all tool validation, project instructions and workflow restrictions.';
  if (mode === 'acceptEdits') return 'The user enabled automatic approval for local file edits. Commands, external MCP calls, sensitive reads and user questions still require individual approval or answers. Follow all tool validation and project instructions.';
  return 'The host requests individual approval for writes, commands and other approval-required tools.';
}
