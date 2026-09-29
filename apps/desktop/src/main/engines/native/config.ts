import { z } from 'zod';
import { normalizeProjectSkillPaths } from '@cc-desk/agent-node/project-skills';
import type { EngineConfig } from '../../../shared/execution';

const optionsSchema = z.object({
  connectionId: z.string().trim().max(100).default(''),
  model: z.string().trim().max(200).default(''),
  maxModelRequests: z.number().int().min(1).max(100).default(30),
  maxToolCalls: z.number().int().min(1).max(200).default(60),
  maxActiveMs: z.number().int().min(1000).max(30 * 60_000).default(10 * 60_000),
  maxInputTokens: z.number().int().min(1024).max(2_000_000).default(64_000),
  maxOutputTokens: z.number().int().min(128).max(64_000).default(8192),
  autoCompact: z.enum(['off', 'before_send', 'before_send_and_during_run']).default('off'),
  mcpConnections: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)).max(4).default([])
    .refine(ids => new Set(ids).size === ids.length, 'MCP 服务不能重复选择。').transform(ids => ids.sort()),
  projectSkills: z.array(z.string().max(4096)).max(16).default([]).transform((paths, context) => {
    try { return normalizeProjectSkillPaths(paths); }
    catch { context.addIssue({ code: 'custom', message: '请选择项目内普通目录中有效且不重复的 SKILL.md，最多 16 项。' }); return z.NEVER; }
  }),
}).strict();
export function parseNativeConfig(config: EngineConfig) {
  if (config.schemaVersion !== 1) throw new Error('不支持此 native 配置版本；原配置已保留。');
  return optionsSchema.parse(config.options);
}
export function createNativeConfig(config: EngineConfig = { schemaVersion: 1, options: {} }): EngineConfig {
  return { schemaVersion: 1, options: parseNativeConfig(config) };
}
