import { z } from 'zod';
import { nativeQualityDeclarationSchema, nativeQualityFindingSchema } from './engines/native/workflow-quality-report';

const date = z.string().datetime();
const collaboration = z.enum(['auto', 'single_agent', 'parallel', 'adversarial']);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.object({ sessionId: z.string().uuid(), conversationId: z.string().uuid(), runId: z.string().uuid(),
  requestId: z.string().min(1).max(256), workerGeneration: z.number().int().min(1) }).strict();
const gitObject = z.string().regex(/^[a-f0-9]{40,64}$/);
const qualityRole = z.enum(['reviewer', 'challenger', 'verifier']);
const qualityReport = z.object({
  version: z.literal(1), role: qualityRole, round: z.number().int().min(1).max(2), identity, taskId: z.string().uuid(),
  snapshotCommit: gitObject, workspaceFingerprint: digest,
  deliveryDigest: digest.optional(),
  declaration: nativeQualityDeclarationSchema,
  materialReads: z.array(z.object({ toolCallId: z.string().min(1).max(256), path: z.string().min(1).max(4096), fileHash: digest }).strict()).max(64),
  commandReceipts: z.array(z.object({ toolCallId: z.string().min(1).max(256), exitCode: z.number().int().nullable(), successful: z.boolean() }).strict()).max(64),
  submittedAt: date,
}).strict();
export const nativeWorkflowQualitySchema = z.object({
  version: z.literal(1), parentIdentity: identity, taskId: z.string().uuid(), collaboration,
  validationMode: z.enum(['commands', 'static']), status: z.enum(['pending', 'running', 'changes_requested', 'passed', 'blocked', 'cancelled', 'unknown']),
  round: z.number().int().min(0).max(2), maxRounds: z.literal(2), receiptPath: z.string().min(1).max(8192), updatedAt: date,
  rounds: z.array(z.object({ round: z.number().int().min(1).max(2), status: z.enum(['running', 'passed', 'changes_requested', 'blocked', 'cancelled', 'unknown']),
    snapshotCommit: gitObject.optional(), snapshotTree: gitObject.optional(), parentFingerprint: digest.optional(), deliveryDigest: digest.optional(),
    roles: z.array(z.object({ role: qualityRole, childId: z.string().uuid(), identity, taskId: z.string().uuid(), cwd: z.string().min(1).max(8192),
      status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'unknown']), report: qualityReport.optional(), error: z.string().max(4000).optional(),
    }).strict()).max(3), issues: z.array(z.string().min(1).max(4000)).max(16),
  }).strict()).max(2),
  findings: z.array(nativeQualityFindingSchema).max(32), workspaceFingerprint: digest.optional(),
  automaticReview: z.enum(['pending', 'passed', 'blocked', 'unknown']), manualAcceptance: z.literal('not_requested'),
}).strict();
