import { z } from 'zod';
export const idSchema = z.uuid();
export const settingsSchema = z.object({
  claudePath: z.string().max(4096).refine(s => !/[\x00\r\n]/.test(s)),
  shellPath: z.string().max(4096).refine(s => !/[\x00\r\n]/.test(s)),
  maxSessions: z.number().int().min(1).max(12), fontSize: z.number().int().min(11).max(24),
  scrollback: z.number().int().min(1000).max(50000)
});
export const sessionInputSchema = z.object({
  projectId: idSchema, title: z.string().trim().min(1).max(120), kind: z.enum(['claude', 'shell']),
  model: z.string().trim().max(200).refine(s => !/[\x00-\x1f]/.test(s)),
  effort: z.enum(['default','low','medium','high','xhigh','max','ultracode']),
  permissionMode: z.enum(['default','plan','acceptEdits']), isolated: z.boolean(),
  resumeFrom: idSchema.optional(), fork: z.boolean().optional()
});
const sessionSchema = z.object({
  id: idSchema, projectId: idSchema, title: z.string(), kind: z.enum(['claude','shell']),
  cwd: z.string(), claudeId: idSchema, resumeFrom: idSchema.optional(), imported: z.boolean().optional(), started: z.boolean(),
  model: z.string(), effort: sessionInputSchema.shape.effort, permissionMode: sessionInputSchema.shape.permissionMode,
  status: z.enum(['idle','running','stopping','stopped','error']), archived: z.boolean(),
  createdAt: z.string(), updatedAt: z.string(), worktree: z.string().optional(), exitCode: z.number().optional(), error: z.string().optional()
});
export const stateSchema = z.object({
  version: z.literal(1), settings: settingsSchema,
  projects: z.array(z.object({ id: idSchema, name: z.string(), path: z.string(), createdAt: z.string() })),
  sessions: z.array(sessionSchema)
});
