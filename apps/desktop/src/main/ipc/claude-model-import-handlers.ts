import { z } from 'zod';
import type { Register } from './registration';
import { ClaudeModelImporter } from '../claude-model-import';

function privateInput<T>(schema: z.ZodType<T>): z.ZodType<T> {
  return z.unknown().transform((input, context) => {
    const parsed = schema.safeParse(input);
    if (parsed.success) return parsed.data;
    context.addIssue({ code: 'custom', message: 'Claude 模型导入请求格式无效，请重新读取配置并重试。' });
    return z.NEVER;
  });
}

/** Uses the composition root's trusted renderer / main-frame gate. File paths are chosen in main only. */
export function registerClaudeModelImportHandlers(handle: Register, importer: ClaudeModelImporter): void {
  handle('claude:model-import-preview', privateInput(z.object({ source: z.enum(['default', 'file']) }).strict()), input => importer.preview(input));
  handle('claude:model-import', privateInput(z.object({
    token: z.uuid(), credentialMode: z.enum(['memory', 'encrypted']).optional(),
    allowLoopbackHttp: z.boolean().optional(),
    model: z.string().min(1).max(200).refine(value => !/[\x00-\x20\x7f]/.test(value)).optional(),
  }).strict()), input => importer.import(input));
}
