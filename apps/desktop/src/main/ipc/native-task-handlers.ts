import { z } from 'zod';
import type { NativeTaskSnapshot } from '@cc-desk/contracts/native-task';
import { toNativeTaskView, type NativeTaskReviewInput } from '../../shared/native-task';
import type { Register } from './registration';
import { idSchema } from '../../shared/schema';

export const nativeTaskReviewSchema = z.object({
  id: idSchema, taskId: z.string().uuid(), expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expectedWorkspaceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['passed', 'failed', 'not_applicable', 'approve', 'reject']),
  criterionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/).optional(),
  reason: z.string().trim().min(1).max(2000),
}).strict().refine(value => (value.decision === 'approve' || value.decision === 'reject') ? !value.criterionId : !!value.criterionId,
  '请明确复核条件或整体验收。');

export function registerNativeTaskHandlers(handle: Register, review: (id: string, input: NativeTaskReviewInput) => Promise<NativeTaskSnapshot>): void {
  handle('native:task-review', nativeTaskReviewSchema, async ({ id, ...input }) => toNativeTaskView(await review(id, input)));
}
