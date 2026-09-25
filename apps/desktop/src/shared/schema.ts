import { z } from 'zod';
import { THEME_IDS } from './theme';
import type { EngineConfig, JsonValue } from './execution';
import { persistedStateSchema as persistedV2Schema } from './workspace-v2';
import { SUBTASK_STATUSES, SUBTASK_LIMIT } from './subtasks';
import { DEFAULT_TYPOGRAPHY, isFontId } from './fonts';
export const fontIdSchema = z.string().max(2311).refine(isFontId, '请选择系统或已导入的字体。').transform(value => value as import('./fonts').FontId);
export const idSchema = z.uuid();
export const providerIdSchema = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const conversationIdSchema = z.string().min(1).max(4096).refine(value => !/[\x00-\x1f\x7f]/.test(value));
export const sessionExecutionSchema = z.object({
  providerId: providerIdSchema,
  mode: z.enum(['terminal', 'structured']),
  conversationId: conversationIdSchema.optional(),
  forkFrom: conversationIdSchema.optional(),
  imported: z.boolean().optional(),
}).strict();
/** Bound unknown provider data before recursive consumers can inspect it. */
function boundedJsonObject(value: unknown): value is Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const queue: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0, size = 0;
  while (queue.length) {
    const item = queue.pop()!;
    if (++nodes > 2048 || item.depth > 8) return false;
    const current = item.value;
    if (current === null || typeof current === 'boolean') continue;
    if (typeof current === 'number') { if (!Number.isFinite(current)) return false; continue; }
    if (typeof current === 'string') { size += current.length; if (size > 65536) return false; continue; }
    if (!current || typeof current !== 'object' || seen.has(current)) return false;
    seen.add(current);
    if (!Array.isArray(current) && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) return false;
    for (const [key, child] of Object.entries(current)) {
      if (key.length > 200 || /[\x00-\x1f\x7f]/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) return false;
      size += key.length; if (size > 65536) return false;
      queue.push({ value: child, depth: item.depth + 1 });
      if (queue.length > 2048) return false;
    }
  }
  return true;
}
export const engineConfigSchema = z.object({
  schemaVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  options: z.custom<Record<string, JsonValue>>(boundedJsonObject, '引擎配置必须是大小和深度受限的 JSON 对象。'),
}).strict();
export const settingsSchema = z.object({
  claudePath: z.string().max(4096).refine(s => !/[\x00\r\n]/.test(s)),
  shellPath: z.string().max(4096).refine(s => !/[\x00\r\n]/.test(s)),
  idePath: z.string().trim().max(4096).refine(s => !/[\x00-\x1f\x7f]/.test(s), 'IDE 应用路径不能包含控制字符。').default(''),
  worktreeLocation: z.enum(['project','custom']).default('project'),
  worktreeRoot: z.string().max(4096).refine(s => !/[\x00-\x1f\x7f]/.test(s), 'Worktree 根目录不能包含控制字符。').trim().default(''),
  maxSessions: z.number().int().min(1).max(12), fontSize: z.number().int().min(11).max(24),
  chatFontFamily: fontIdSchema.default(DEFAULT_TYPOGRAPHY.chatFontFamily),
  chatFontSize: z.number().int().min(11).max(28).default(DEFAULT_TYPOGRAPHY.chatFontSize),
  uiFontFamily: fontIdSchema.default(DEFAULT_TYPOGRAPHY.uiFontFamily),
  uiFontSize: z.number().int().min(11).max(20).default(DEFAULT_TYPOGRAPHY.uiFontSize),
  scrollback: z.number().int().min(1000).max(50000),
  notifications: z.boolean().optional(), closeToTray: z.boolean().optional(), theme: z.enum(THEME_IDS).optional(),
  engineDefaults: z.record(providerIdSchema, engineConfigSchema).default({})
}).refine(settings => settings.worktreeLocation !== 'custom' || !!settings.worktreeRoot, { message: '请选择或填写统一 Worktree 根目录。', path: ['worktreeRoot'] });
export const sessionInputSchema = z.object({
  projectId: idSchema, title: z.string().trim().max(120), kind: z.enum(['agent', 'shell']),
  engineConfig: engineConfigSchema.optional(), isolated: z.boolean(),
  worktreeName: z.string().max(80).refine(s => !/[/\\\x00-\x1f\x7f]/.test(s) && !s.includes('..'), 'Worktree 名称不能包含路径分隔符、控制字符或 ..。').trim().optional(),
  providerId: providerIdSchema.optional(), conversationId: conversationIdSchema.optional(), fork: z.boolean().optional(),
  mode: z.enum(['terminal','structured']).optional()
}).strict();
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
const sessionFieldsSchema = z.object({
  id: idSchema, projectId: idSchema, title: z.string(),
  titleSource: z.enum(['default','auto','manual']).optional(),
  cwd: z.string(), started: z.boolean(),
  engineConfig: engineConfigSchema,
  status: z.enum(['idle','running','stopping','stopped','error']), archived: z.boolean(),
  createdAt: z.string(), updatedAt: z.string(), worktree: z.string().optional(), exitCode: z.number().optional(), error: z.string().optional(),
  draft: z.string().max(128*1024).optional(), worktreeBase: z.string().optional(),
  terminalSync: z.enum(['waiting','synced','unsupported']).optional(), identityPending: z.boolean().optional(),
  observedPermissionMode: z.enum(['default','plan','acceptEdits','auto','dontAsk','bypassPermissions']).optional(),
  panelDrafts: panelDraftsSchema.optional(),
  subtasks:z.object({turnId:subtaskIdentity,tasks:z.array(subtaskSchema).max(SUBTASK_LIMIT),truncated:z.boolean().optional()}).optional(),
  taskState: z.enum(['idle','starting','thinking','tool_running','waiting_approval','waiting_input','completed','interrupted','error']).optional()
});
export const sessionSchema = sessionFieldsSchema.extend({
  kind: z.enum(['agent', 'shell']), execution: sessionExecutionSchema,
}).strict().refine(session => session.kind === 'shell'
  ? session.execution.providerId === 'shell' && session.execution.mode === 'terminal' && session.execution.conversationId === undefined && session.execution.forkFrom === undefined && session.execution.imported === undefined
  : session.execution.providerId !== 'shell', { message: '会话类型与执行身份不匹配。', path: ['execution'] });
const workspaceFields = {
  settings: settingsSchema,
  projects: z.array(z.object({ id: idSchema, name: z.string(), path: z.string(), createdAt: z.string() })),
  selectedSessionId: z.union([idSchema,z.literal('')]).optional(),
};
export const stateSchema = z.object({
  version: z.literal(3), ...workspaceFields, sessions: z.array(sessionSchema),
});

function migrateConfig(providerId: string, options: { model: string; effort: string; permissionMode: string }): EngineConfig {
  if (providerId === 'claude') return { schemaVersion: 1, options };
  if (providerId === 'shell') return { schemaVersion: 1, options: options.model || options.effort !== 'default' || options.permissionMode !== 'default' ? { legacy: options } : {} };
  // Version zero has no implied Claude semantics. Only its provider may migrate it.
  return { schemaVersion: 0, options };
}
const migratedV3Schema = persistedV2Schema.transform((state, context): z.infer<typeof stateSchema> => {
  const { defaultPermissionMode, ...settings } = state.settings;
  const result = stateSchema.safeParse({
    ...state, version: 3 as const,
    settings: { ...settings, engineDefaults: { claude: { schemaVersion: 1, options: { model: '', effort: 'default', permissionMode: defaultPermissionMode } } } },
    sessions: state.sessions.map(({ model, effort, permissionMode, ...session }) => ({
      ...session, engineConfig: migrateConfig(session.execution.providerId, { model, effort, permissionMode }),
    })),
  });
  if (!result.success) {
    for (const issue of result.error.issues) context.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    return z.NEVER;
  }
  return result.data;
});
/** Only disk reads accept legacy formats. Every live change validates v3. */
export const persistedStateSchema = z.union([stateSchema, migratedV3Schema]);
