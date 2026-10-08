import { z } from 'zod';
import type { NativeAgentResultRequest, NativeAgentResult } from '../../shared/chat';
import { idSchema } from '../../shared/schema';
import type { Register } from './registration';

export const nativeAgentResultSchema = z.object({
  id: idSchema, parentRunId: z.string().uuid(), childId: z.string().uuid(),
  patchOffset: z.number().int().min(0).max(16 * 1024 * 1024).optional(),
  patchCharacters: z.number().int().min(1).max(32000).optional(),
  expectedPatchSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export function registerNativeAgentResultHandlers(handle: Register,
  read: (id: string, input: NativeAgentResultRequest) => Promise<NativeAgentResult>): void {
  handle('native:agent-result', nativeAgentResultSchema, ({ id, ...input }) => read(id, input));
}
