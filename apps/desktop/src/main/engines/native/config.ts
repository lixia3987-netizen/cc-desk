import { z } from 'zod';
import type { EngineConfig } from '../../../shared/execution';

const optionsSchema = z.object({
  connectionId: z.string().trim().max(100).default(''),
  model: z.string().trim().max(200).default(''),
  maxModelRequests: z.number().int().min(1).max(100).default(30),
  maxToolCalls: z.number().int().min(1).max(200).default(60),
  maxActiveMs: z.number().int().min(1000).max(30 * 60_000).default(10 * 60_000),
  maxInputTokens: z.number().int().min(1024).max(2_000_000).default(64_000),
  maxOutputTokens: z.number().int().min(128).max(64_000).default(8192),
}).strict();
export function parseNativeConfig(config: EngineConfig) {
  if (config.schemaVersion !== 1) throw new Error('不支持此 native 配置版本；原配置已保留。');
  return optionsSchema.parse(config.options);
}
export function createNativeConfig(config: EngineConfig = { schemaVersion: 1, options: {} }): EngineConfig {
  return { schemaVersion: 1, options: parseNativeConfig(config) };
}
