import { z } from 'zod';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@cc-desk/agent-core';
import { NATIVE_PERMISSION_MODES, NATIVE_PERMISSION_LABELS } from '../../../shared/native-permissions';
import { normalizeProjectSkillPaths } from '@cc-desk/agent-node/project-skills';
import type { EngineConfig, EngineConfigField } from '../../../shared/execution';

export type NativeLegacySkillPolicy = {
  mode: 'legacy';
  autoActivation: false;
  pins: Array<{ kind: 'legacy'; path: string }>;
  disabledIds: [];
}

/** 兼容模式保留旧整文件注入语义，不建立新的 catalog 激活。 */
export function normalizeNativeLegacySkillPolicy(projectSkills: readonly string[]): NativeLegacySkillPolicy {
  return { mode: 'legacy', autoActivation: false,
    pins: normalizeProjectSkillPaths(projectSkills).map(source => ({ kind: 'legacy', path: source })), disabledIds: [] };
}

export const NATIVE_MODEL_RETRY_FIELD: EngineConfigField = {
  key: 'modelRetry', label: '模型请求有限重试', type: 'select', apply: 'stopped',
  options: [{ value: 'off', label: '关闭' }, { value: 'safe_transient', label: '暂时错误时有限重试（可能计费）' }],
  description: '默认关闭。开启后，仅在完整模型响应与工具结果的边界，对尚未收到部分输出的 HTTP 429、502、503、504 错误有限重试；整个回合最多额外请求 2 次，依次等待 500 毫秒、1500 毫秒，等待期间可取消。子 Agent 的重试计入其独立请求与时长预算，主 Agent 不限请求次数与执行时长；每次请求可能计费。摘要和本地工具不自动重试，结果未知的操作不重放。',
};

export const NATIVE_PERMISSION_FIELD: EngineConfigField = {
  key: 'permissionMode', label: '权限模式', type: 'select', apply: 'stopped',
  options: NATIVE_PERMISSION_MODES.map(value => ({ value, label: NATIVE_PERMISSION_LABELS[value] })),
  description: '逐次审批：写入、命令与需授权的读取分别确认。自动允许文件编辑：仅自动批准本地文件编辑，命令与 MCP 调用仍需审批。自动允许工具执行：文件、命令与 MCP 操作均自动批准，提问仍需回答。路径、参数、文件版本和工作流限制继续生效；保存后下一回合使用。',
};

export const NATIVE_SUBAGENT_FIELDS: EngineConfigField[] = [
  { key: 'maxModelRequests', label: '单个子 Agent 模型请求上限', type: 'number', min: 1, max: 200, apply: 'stopped', description: '默认 60 次，最多 200 次。每个子 Agent 独立计数，包含其摘要和重试；主 Agent 不限模型请求次数。' },
  { key: 'maxToolCalls', label: '单个子 Agent 工具调用上限', type: 'number', min: 1, max: 400, apply: 'stopped', description: '默认 120 次，最多 400 次。每个子 Agent 独立计数；主 Agent 不限工具调用次数。' },
  { key: 'maxActiveMs', label: '单个子 Agent 运行时长上限（分钟）', type: 'number', min: 1000, max: 300 * 60_000, numberScale: 60_000, apply: 'stopped', description: '默认 30 分钟，最多 300 分钟。每个子 Agent 独立计时，审批等待除外，不累计到共享总时长；主 Agent 不限执行时长。' },
  { key: 'maxSubagents', label: '子 Agent 并发上限', type: 'number', min: 1, max: 30, apply: 'stopped', description: '默认同时执行 4 个，最多 30 个。已完成或失败的子 Agent 释放名额；单个子 Agent 失败不会停止主任务，主 Agent 可根据已有结果恢复失败的子 Agent。' },
];

const optionsSchema = z.object({
  permissionMode: z.enum(NATIVE_PERMISSION_MODES).default('default'),
  connectionId: z.string().trim().max(100).default(''),
  model: z.string().trim().max(200).default(''),
  runtimePolicy: z.enum(['custom', 'defaults']).default('custom'),
  inputBudgetMode: z.enum(['custom', 'model']).default('custom'),
  // 兼容原配置字段：显式保存的值保留，仅用于每个子 Agent 的独立预算。
  maxModelRequests: z.number().int().min(1).max(200).default(60),
  maxToolCalls: z.number().int().min(1).max(400).default(120),
  maxActiveMs: z.number().int().min(1000).max(300 * 60_000).default(30 * 60_000),
  maxSubagents: z.number().int().min(1).max(30).default(4),
  maxInputTokens: z.number().int().min(1024).max(2_000_000).default(64_000),
  maxOutputTokens: z.number().int().min(128).max(64_000).default(8192),
  autoCompact: z.enum(['off', 'before_send', 'before_send_and_during_run']).default('off'),
  modelRetry: z.enum(['off', 'safe_transient']).default('off'),
  mcpConnections: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)).max(4).default([])
    .refine(ids => new Set(ids).size === ids.length, 'MCP 服务不能重复选择。').transform(ids => ids.sort()),
  projectSkills: z.array(z.string().max(4096)).max(16).default([]).transform((paths, context) => {
    try { return normalizeProjectSkillPaths(paths); }
    catch { context.addIssue({ code: 'custom', message: '请选择项目内普通目录中有效且不重复的 SKILL.md，最多 16 项。' }); return z.NEVER; }
  }),
}).strict();
const legacySkillPolicySchema = z.object({
  mode: z.literal('legacy'),
  autoActivation: z.literal(false),
  pins: z.array(z.object({ kind: z.literal('legacy'), path: z.string().max(4096) }).strict()).max(16),
  disabledIds: z.tuple([]),
}).strict().transform((policy, context): NativeLegacySkillPolicy => {
  try { return normalizeNativeLegacySkillPolicy(policy.pins.map(pin => pin.path)); }
  catch { context.addIssue({ code: 'custom', message: '旧版 Skills 固定路径无效或重复，原配置已保留。' }); return z.NEVER; }
});
const v2OptionsSchema = optionsSchema.extend({ skills: legacySkillPolicySchema }).superRefine((options, context) => {
  const paths = options.skills.pins.map(pin => pin.path);
  if (paths.length !== options.projectSkills.length || paths.some((source, index) => source !== options.projectSkills[index])) {
    context.addIssue({ code: 'custom', message: '旧版 Skills 固定项与项目路径必须一致，原配置已保留。', path: ['skills', 'pins'] });
  }
});
export type NativeConfigOptions = z.infer<typeof optionsSchema> & { skills?: NativeLegacySkillPolicy };

export function parseNativeConfig(config: EngineConfig): NativeConfigOptions {
  if (config.schemaVersion === 1) return optionsSchema.parse(config.options);
  if (config.schemaVersion !== 2) throw new Error('不支持此 native 配置版本；原配置已保留。');
  const policy = config.options?.skills;
  if (policy && typeof policy === 'object' && !Array.isArray(policy) && policy.mode === 'catalog') {
    throw new Error('Native Skills catalog 模式尚未开放；原配置已保留。');
  }
  return v2OptionsSchema.parse(config.options);
}
export function createNativeConfig(config: EngineConfig = { schemaVersion: 1, options: {} }): EngineConfig {
  return { schemaVersion: config.schemaVersion, options: parseNativeConfig(config) };
}

/** CAS 比较原配置，不用补全默认值后的结果覆盖用户尚未保存的表示。 */
export function nativeConfigDigest(config: EngineConfig): string {
  return createHash('sha256').update(canonicalJson({ schemaVersion: config.schemaVersion, options: config.options })).digest('hex');
}

/** 较早的账本未存版本，其 sessionOptions 按当时唯一支持的 v1 读取。 */
export function readNativeRunConfig(configuration: Readonly<Record<string, unknown>>): EngineConfig {
  const version = Object.hasOwn(configuration, 'sessionOptionsSchemaVersion') ? configuration.sessionOptionsSchemaVersion : 1;
  if (typeof version !== 'number') throw new Error('Native 运行记录的配置版本无效；原记录已保留。');
  return createNativeConfig({ schemaVersion: version,
    options: (configuration.sessionOptions === undefined ? {} : configuration.sessionOptions) as EngineConfig['options'] });
}

/** 全新安装使用已知模型容量；旧配置保留已保存的自定义上限。 */
export function createNativeDefaultConfig(): EngineConfig {
  return createNativeConfig({ schemaVersion: 1, options: { inputBudgetMode: 'model' } });
}
