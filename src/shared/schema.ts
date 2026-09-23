import { z } from 'zod';
import { THEME_IDS } from './theme';
import { PERMISSION_MODES } from './permissions';
import { SUBTASK_STATUSES, SUBTASK_LIMIT } from './subtasks';
export const idSchema = z.uuid();
export const permissionModeSchema = z.enum(PERMISSION_MODES);
export const settingsSchema = z.object({
  claudePath: z.string().max(4096).refine(s => !/[\x00\r\n]/.test(s)),
  shellPath: z.string().max(4096).refine(s => !/[\x00\r\n]/.test(s)),
  idePath: z.string().trim().max(4096).refine(s => !/[\x00-\x1f\x7f]/.test(s), 'IDE 应用路径不能包含控制字符。').default(''),
  worktreeLocation: z.enum(['project','custom']).default('project'),
  worktreeRoot: z.string().max(4096).refine(s => !/[\x00-\x1f\x7f]/.test(s), 'Worktree 根目录不能包含控制字符。').trim().default(''),
  maxSessions: z.number().int().min(1).max(12), fontSize: z.number().int().min(11).max(24),
  scrollback: z.number().int().min(1000).max(50000),
  notifications: z.boolean().optional(), closeToTray: z.boolean().optional(), theme: z.enum(THEME_IDS).optional(),
  defaultPermissionMode: permissionModeSchema.default('default')
}).refine(settings => settings.worktreeLocation !== 'custom' || !!settings.worktreeRoot, { message: '请选择或填写统一 Worktree 根目录。', path: ['worktreeRoot'] });
export const sessionInputSchema = z.object({
  projectId: idSchema, title: z.string().trim().max(120), kind: z.enum(['claude', 'shell']),
  model: z.string().trim().max(200).refine(s => !/[\x00-\x1f]/.test(s)),
  effort: z.enum(['default','low','medium','high','xhigh','max','ultracode']),
  permissionMode: permissionModeSchema.optional(), isolated: z.boolean(),
  worktreeName: z.string().max(80).refine(s => !/[/\\\x00-\x1f\x7f]/.test(s) && !s.includes('..'), 'Worktree 名称不能包含路径分隔符、控制字符或 ..。').trim().optional(),
  resumeFrom: idSchema.optional(), fork: z.boolean().optional(),
  adapter: z.enum(['terminal','structured']).optional()
});
const draftEntries = (keyLength: number, textLength: number) => z.record(z.string().max(keyLength), z.string().max(textLength))
  .refine(value => Object.keys(value).length <= 200, '草稿条目过多，请先处理已有草稿。');
export const panelDraftsSchema = z.object({
  workflow: z.object({
    goal: z.string().max(20000), pauseAfterEachStage: z.boolean(), maxAttempts: z.number().int().min(1).max(3),
    editing: z.string().max(256), instructions: draftEntries(256, 20000), allRuns: z.boolean(),
  }).optional(),
  git: z.object({ selected: z.string().max(4096), staged: z.boolean(), feedback: draftEntries(4096, 60000) }).optional(),
}).refine(value => JSON.stringify(value).length <= 2 * 1024 * 1024, '面板草稿过大，请先处理已有草稿。');
const subtaskIdentity = z.string().min(1).max(200).refine(value=>!/[\x00-\x1f\x7f]/.test(value));
const subtaskSchema = z.object({
  id:z.string().min(1).max(1024),turnId:subtaskIdentity,source:z.enum(['stream','hooks']),kind:z.enum(['agent','shell','task']),
  status:z.enum(SUBTASK_STATUSES),description:z.string().max(500),startedAt:z.string().max(100),updatedAt:z.string().max(100),endedAt:z.string().max(100).optional(),
  taskId:subtaskIdentity.optional(),toolUseId:subtaskIdentity.optional(),parentToolUseId:subtaskIdentity.optional(),agentId:subtaskIdentity.optional(),
  summary:z.string().max(2000).optional(),progress:z.string().max(2000).optional(),lastTool:z.string().max(200).optional(),
  toolUses:z.number().nonnegative().finite().optional(),totalTokens:z.number().nonnegative().finite().optional(),durationMs:z.number().nonnegative().finite().optional(),background:z.boolean().optional()
});
const sessionSchema = z.object({
  id: idSchema, projectId: idSchema, title: z.string(), kind: z.enum(['claude','shell']),
  titleSource: z.enum(['default','auto','manual']).optional(),
  cwd: z.string(), claudeId: idSchema, resumeFrom: idSchema.optional(), imported: z.boolean().optional(), started: z.boolean(),
  model: z.string(), effort: sessionInputSchema.shape.effort, permissionMode: permissionModeSchema,
  status: z.enum(['idle','running','stopping','stopped','error']), archived: z.boolean(),
  createdAt: z.string(), updatedAt: z.string(), worktree: z.string().optional(), exitCode: z.number().optional(), error: z.string().optional(),
  adapter: z.enum(['terminal','structured']).optional(), draft: z.string().max(128*1024).optional(), worktreeBase: z.string().optional(),
  terminalSync: z.enum(['waiting','synced','unsupported']).optional(), identityPending: z.boolean().optional(),
  observedPermissionMode: z.enum(['default','plan','acceptEdits','auto','dontAsk','bypassPermissions']).optional(),
  panelDrafts: panelDraftsSchema.optional(),
  subtasks:z.object({turnId:subtaskIdentity,tasks:z.array(subtaskSchema).max(SUBTASK_LIMIT),truncated:z.boolean().optional()}).optional(),
  taskState: z.enum(['idle','starting','thinking','tool_running','waiting_approval','waiting_input','completed','interrupted','error']).optional()
});
export const stateSchema = z.object({
  version: z.literal(1), settings: settingsSchema,
  projects: z.array(z.object({ id: idSchema, name: z.string(), path: z.string(), createdAt: z.string() })),
  sessions: z.array(sessionSchema), selectedSessionId: z.union([idSchema,z.literal('')]).optional()
});
