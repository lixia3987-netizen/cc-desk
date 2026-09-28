import { getNativeTaskCriterionVerification } from '@cc-desk/contracts/native-task';
import type {
  NativeTaskIdentity, NativeTaskPlan, NativeTaskSnapshot, NativeTaskUpdate,
  NativeTaskEvidence, NativeTaskVerification,
} from '@cc-desk/contracts/native-task';
export type * from '@cc-desk/contracts/native-task';

export class NativeTaskError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'NativeTaskError'; }
}
export const NATIVE_TASK_LIMITS = { steps: 64, criteria: 64, evidence: 256, history: 512, files: 4000 } as const;
function fail(code: string, message: string): never { throw new NativeTaskError(code, message); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value: unknown, allowed: string[], label: string): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('invalid_task', `Invalid ${label} fields`);
}
function text(value: unknown, label: string, max = 2000): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail('invalid_task', `Invalid ${label}`);
}
function integer(value: unknown, label: string, min = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min) fail('invalid_task', `Invalid ${label}`);
}
function id(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) fail('invalid_task', `Invalid ${label}`);
}
function uuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) fail('invalid_identity', `Invalid ${label}`);
}
function hash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('invalid_task', 'Invalid workspace fingerprint');
}
function time(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) fail('invalid_task', 'Invalid task timestamp');
}
function strings(value: unknown, label: string, max: number): asserts value is string[] {
  if (!Array.isArray(value) || value.length > max) fail('invalid_task', `Invalid ${label}`);
  for (const item of value) text(item, label, 4096);
  if (new Set(value).size !== value.length) fail('invalid_task', `Duplicate ${label}`);
}
function same(a: unknown, b: unknown): boolean { return canonicalNativeTask(a) === canonicalNativeTask(b); }
export function canonicalNativeTask(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalNativeTask).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalNativeTask(value[key])}`).join(',')}}`;
  return fail('invalid_task', 'Task records must contain finite JSON values');
}
export function validateNativeTaskIdentity(value: unknown): asserts value is NativeTaskIdentity {
  keys(value, ['sessionId', 'conversationId', 'runId', 'requestId', 'workerGeneration'], 'identity');
  text(value.sessionId, 'sessionId', 512); uuid(value.conversationId, 'conversationId'); uuid(value.runId, 'runId');
  text(value.requestId, 'requestId', 1024); integer(value.workerGeneration, 'workerGeneration', 1);
}
export function validateNativeTaskPlan(value: unknown): asserts value is NativeTaskPlan {
  keys(value, ['goal', 'steps', 'criteria'], 'plan'); text(value.goal, 'goal', 4000);
  if (!Array.isArray(value.steps) || !value.steps.length || value.steps.length > NATIVE_TASK_LIMITS.steps) fail('invalid_task', 'A plan needs 1–64 steps');
  const ids = new Set<string>();
  for (const step of value.steps) {
    keys(step, ['id', 'title', 'dependsOn', 'status', 'blockedReason'], 'step'); id(step.id, 'step id'); text(step.title, 'step title');
    if (ids.has(step.id)) fail('invalid_task', 'Duplicate step id'); ids.add(step.id);
    strings(step.dependsOn, 'dependency', NATIVE_TASK_LIMITS.steps);
    if (!['pending', 'in_progress', 'implemented', 'blocked', 'interrupted'].includes(String(step.status))) fail('invalid_task', 'Invalid step status');
    if (step.blockedReason !== undefined) text(step.blockedReason, 'blocked reason');
    if (step.status === 'blocked' && !step.blockedReason) fail('invalid_task', 'Blocked steps require a reason');
  }
  const steps = value.steps as NativeTaskPlan['steps'];
  if (steps.filter(step => step.status === 'in_progress').length > 1) fail('invalid_task', 'Only one step may be in progress');
  const visited = new Set<string>(); const visiting = new Set<string>();
  const visit = (stepId: string): void => {
    if (visiting.has(stepId)) fail('invalid_task', 'Dependency cycle');
    if (visited.has(stepId)) return;
    const step = steps.find(item => item.id === stepId);
    if (!step) fail('invalid_task', 'Dependency refers to an unknown step');
    visiting.add(stepId); step.dependsOn.forEach(visit); visiting.delete(stepId); visited.add(stepId);
  };
  ids.forEach(visit);
  for (const step of steps) {
    if (['in_progress', 'implemented'].includes(step.status) && step.dependsOn.some(dependency => steps.find(item => item.id === dependency)?.status !== 'implemented')) fail('invalid_task', 'Active or implemented steps require implemented dependencies');
  }
  if (!Array.isArray(value.criteria) || value.criteria.length > NATIVE_TASK_LIMITS.criteria) fail('invalid_task', 'Too many acceptance criteria');
  const criterionIds = new Set<string>();
  for (const criterion of value.criteria) {
    keys(criterion, ['id', 'description', 'stepIds', 'kind'], 'criterion'); id(criterion.id, 'criterion id'); text(criterion.description, 'criterion description');
    if (criterionIds.has(criterion.id)) fail('invalid_task', 'Duplicate criterion id'); criterionIds.add(criterion.id);
    strings(criterion.stepIds, 'criterion step', NATIVE_TASK_LIMITS.steps);
    if (!criterion.stepIds.length || criterion.stepIds.some(item => !ids.has(item))) fail('invalid_task', 'Criterion must reference existing steps');
    if (!['command', 'manual'].includes(String(criterion.kind))) fail('invalid_task', 'Invalid criterion kind');
  }
}
function validateEvidence(value: unknown, task: NativeTaskSnapshot): asserts value is NativeTaskEvidence {
  keys(value, ['id', 'identity', 'stepIds', 'criterionIds', 'source', 'status', 'planRevision', 'acceptanceRevision', 'workspaceFingerprint', 'workspaceComplete', 'toolCallId', 'command', 'exitCode', 'output', 'outputDigest', 'truncated', 'reason', 'createdAt', 'stale'], 'evidence');
  id(value.id, 'evidence id'); validateNativeTaskIdentity(value.identity);
  if (value.identity.sessionId !== task.identity.sessionId || value.identity.conversationId !== task.identity.conversationId) fail('invalid_identity', 'Evidence belongs to a different task session');
  strings(value.stepIds, 'evidence step', 64); strings(value.criterionIds, 'evidence criterion', 64);
  if (!value.stale && (value.stepIds.some(item => !task.steps.some(step => step.id === item)) || value.criterionIds.some(item => !task.criteria.some(criterion => criterion.id === item)))) fail('invalid_task', 'Evidence refers to unknown plan entries');
  if (!['command', 'manual'].includes(String(value.source)) || !['unverified', 'passed', 'failed', 'not_applicable'].includes(String(value.status))) fail('invalid_task', 'Invalid evidence source/status');
  integer(value.planRevision, 'evidence planRevision', 1); integer(value.acceptanceRevision, 'evidence acceptanceRevision', 1);
  hash(value.workspaceFingerprint); if (typeof value.workspaceComplete !== 'boolean') fail('invalid_task', 'Invalid workspace completeness');
  time(value.createdAt);
  if (value.truncated !== undefined && typeof value.truncated !== 'boolean') fail('invalid_task', 'Invalid truncation');
  if (value.stale !== undefined && typeof value.stale !== 'boolean') fail('invalid_task', 'Invalid stale marker');
  if (value.output !== undefined && (typeof value.output !== 'string' || value.output.length > 16000 || value.output.includes('\0'))) fail('invalid_task', 'Invalid evidence output');
  if (value.outputDigest !== undefined) hash(value.outputDigest);
  if (value.reason !== undefined) text(value.reason, 'evidence reason', 4000);
  if (value.status === 'not_applicable' && !value.reason) fail('invalid_task', 'Not-applicable evidence needs a reason');
  if (value.source === 'manual') text(value.reason, 'human evidence reason', 4000);
  if (value.source === 'command') {
    if (!['unverified', 'failed'].includes(String(value.status))) fail('invalid_task', 'Command receipts do not establish acceptance; human condition review is required');
    text(value.toolCallId, 'tool call id', 512);
    keys(value.command, ['executable', 'argv', 'cwd'], 'command'); text(value.command.executable, 'executable', 4096); text(value.command.cwd, 'cwd', 4096);
    if (!Array.isArray(value.command.argv) || value.command.argv.length > 256 || value.command.argv.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) fail('invalid_task', 'Invalid command argv');
    if (value.exitCode !== null && !Number.isSafeInteger(value.exitCode)) fail('invalid_task', 'Invalid exit code');
    if (value.status === 'passed' && (value.exitCode !== 0 || value.truncated || !value.workspaceComplete)) fail('invalid_task', 'Incomplete command evidence cannot pass');
  }
  if (value.status === 'passed' && !value.workspaceComplete) fail('invalid_task', 'Unknown workspace cannot pass');
}
function validateWorkspace(value: unknown): void {
  keys(value, ['fingerprint', 'complete', 'rootFingerprint', 'files', 'scope', 'issues', 'capturedAt'], 'workspace');
  hash(value.fingerprint); hash(value.rootFingerprint); time(value.capturedAt);
  if (typeof value.complete !== 'boolean' || !Array.isArray(value.files) || value.files.length > NATIVE_TASK_LIMITS.files) fail('invalid_task', 'Invalid workspace scan');
  strings(value.scope, 'workspace scope', 128); strings(value.issues, 'workspace issue', 128);
  const paths = new Set<string>();
  for (const file of value.files) {
    keys(file, ['path', 'hash', 'bytes', 'mode'], 'workspace file'); text(file.path, 'workspace path', 4096); hash(file.hash);
    integer(file.bytes, 'file bytes'); integer(file.mode, 'file mode');
    if (paths.has(file.path) || file.path.startsWith('/') || file.path.split(/[\\/]/).includes('..')) fail('invalid_task', 'Invalid or repeated workspace path');
    paths.add(file.path);
  }
}
function validateChanges(value: unknown): void {
  keys(value, ['complete', 'added', 'modified', 'removed', 'attribution', 'truncated'], 'workspace changes');
  if (typeof value.complete !== 'boolean' || typeof value.truncated !== 'boolean' || value.attribution !== 'observed_since_task_start') fail('invalid_task', 'Invalid workspace change summary');
  strings(value.added, 'added path', 4000); strings(value.modified, 'modified path', 4000); strings(value.removed, 'removed path', 4000);
}
/** Evidence results are scoped; human review of requirement coverage is a separate gate. */
export function deriveNativeTaskVerification(task: NativeTaskSnapshot): NativeTaskVerification {
  if (task.review?.status === 'rejected') return 'failed';
  const statuses = task.criteria.map(criterion => getNativeTaskCriterionVerification(task, criterion.id));
  if (statuses.includes('failed')) return 'failed';
  if (task.criteria.length && statuses.every(status => status === 'passed' || status === 'not_applicable')
      && task.review?.status === 'approved' && task.steps.every(step => step.status === 'implemented')) {
    return statuses.every(status => status === 'not_applicable') ? 'not_applicable' : 'passed';
  }
  if (task.evidence.some(evidence => evidence.stale)) return 'stale';
  return 'unverified';
}
export function validateNativeTaskSnapshot(value: unknown): asserts value is NativeTaskSnapshot {
  keys(value, ['schemaVersion', 'taskId', 'identity', 'revision', 'planRevision', 'acceptanceRevision', 'execution', 'runOutcome', 'verification', 'goal', 'steps', 'criteria', 'evidence', 'workspace', 'review', 'history', 'createdAt', 'updatedAt'], 'snapshot');
  if (value.schemaVersion !== 1) fail('invalid_task', 'Unsupported task schema');
  uuid(value.taskId, 'taskId'); validateNativeTaskIdentity(value.identity);
  integer(value.revision, 'revision', 1); integer(value.planRevision, 'planRevision', 1); integer(value.acceptanceRevision, 'acceptanceRevision', 1);
  if (value.planRevision > value.revision || value.acceptanceRevision > value.revision) fail('invalid_task', 'Task revisions exceed snapshot revision');
  validateNativeTaskPlan({ goal: value.goal, steps: value.steps, criteria: value.criteria });
  if (!['active', 'ended', 'interrupted'].includes(String(value.execution))) fail('invalid_task', 'Invalid execution state');
  if (value.runOutcome !== undefined) text(value.runOutcome, 'run outcome', 256);
  time(value.createdAt); time(value.updatedAt);
  if (!Array.isArray(value.evidence) || value.evidence.length > NATIVE_TASK_LIMITS.evidence) fail('invalid_task', 'Too many evidence records');
  const task = value as unknown as NativeTaskSnapshot;
  const evidenceIds = new Set<string>();
  for (const evidence of value.evidence) { validateEvidence(evidence, task); if (evidenceIds.has(evidence.id)) fail('invalid_task', 'Duplicate evidence id'); evidenceIds.add(evidence.id); }
  if (value.workspace !== undefined) {
    keys(value.workspace, ['baseline', 'current', 'changes'], 'workspace versions'); validateWorkspace(value.workspace.baseline); validateWorkspace(value.workspace.current); validateChanges(value.workspace.changes);
  }
  if (value.review !== undefined) {
    keys(value.review, ['status', 'reason', 'at'], 'review');
    if (!['approved', 'rejected'].includes(String(value.review.status))) fail('invalid_task', 'Invalid review status');
    text(value.review.reason, 'review reason', 4000); time(value.review.at);
  }
  if (!Array.isArray(value.history) || !value.history.length || value.history.length > NATIVE_TASK_LIMITS.history || value.history.length !== value.revision) fail('invalid_task', 'Invalid task history');
  const mutationIds = new Set<string>();
  value.history.forEach((entry, index) => {
    keys(entry, ['revision', 'mutationId', 'kind', 'runId', 'at', 'summary'], 'history');
    if (entry.revision !== index + 1) fail('invalid_task', 'Nonsequential task history');
    text(entry.mutationId, 'mutation id', 256); uuid(entry.runId, 'history runId'); text(entry.kind, 'history kind', 32); text(entry.summary, 'history summary', 4000); time(entry.at);
    if (mutationIds.has(entry.mutationId)) fail('invalid_task', 'Duplicate task mutation'); mutationIds.add(entry.mutationId);
  });
  if (value.verification !== deriveNativeTaskVerification(task)) fail('invalid_task', 'Verification does not match durable evidence');
}
function invalidate(task: NativeTaskSnapshot): void { task.evidence.forEach(evidence => { evidence.stale = true; }); delete task.review; }
function structure(plan: NativeTaskPlan): unknown { return { goal: plan.goal, steps: plan.steps.map(({ id, title, dependsOn }) => ({ id, title, dependsOn })) }; }
/** Pure reducer. The caller authenticates host-only mutations and persists before publishing. */
export function applyNativeTaskUpdate(previous: NativeTaskSnapshot | null, update: NativeTaskUpdate, now: string): NativeTaskSnapshot {
  keys(update, ['identity', 'taskId', 'mutationId', 'expectedRevision', 'mutation'], 'update');
  validateNativeTaskIdentity(update.identity); uuid(update.taskId, 'taskId'); text(update.mutationId, 'mutation id', 256); integer(update.expectedRevision, 'expected revision'); time(now);
  if (previous) validateNativeTaskSnapshot(previous);
  if ((previous?.revision ?? 0) !== update.expectedRevision) fail('revision_conflict', 'Task revision changed; read the latest snapshot');
  if (!object(update.mutation)) fail('invalid_task', 'Missing task mutation');
  const mutation = update.mutation;
  if (!previous && mutation.type !== 'plan') fail('task_not_found', 'Create a task plan before updating it');
  if (previous && (previous.taskId !== update.taskId || previous.identity.sessionId !== update.identity.sessionId || previous.identity.conversationId !== update.identity.conversationId)) fail('invalid_identity', 'Task identity mismatch');
  if (previous && mutation.type !== 'continue' && !same(previous.identity, update.identity)) fail('invalid_identity', 'Task update belongs to a stale or different run');
  if (previous && previous.history.length >= NATIVE_TASK_LIMITS.history) fail('limit_exceeded', 'Task history limit reached');
  const next = previous ? JSON.parse(canonicalNativeTask(previous)) as NativeTaskSnapshot : {
    schemaVersion: 1 as const, taskId: update.taskId, identity: update.identity, goal: '', steps: [], criteria: [],
    revision: 0, planRevision: 1, acceptanceRevision: 1, execution: 'active' as const,
    verification: 'unverified' as const, evidence: [], history: [], createdAt: now, updatedAt: now,
  };
  let summary: string = mutation.type;
  switch (mutation.type) {
    case 'plan': {
      keys(mutation, ['type', 'plan', 'explanation'], 'plan mutation'); validateNativeTaskPlan(mutation.plan);
      if (mutation.explanation !== undefined) text(mutation.explanation, 'plan explanation');
      if (next.execution !== 'active') fail('task_ended', 'Explicitly continue this task before changing its plan');
      if (mutation.plan.steps.some(step => step.status === 'interrupted' && !previous?.steps.some(old => old.id === step.id && old.status === 'interrupted'))) fail('invalid_task', 'Only the host may interrupt a step');
      if (previous && !same(structure(previous), structure(mutation.plan))) { next.planRevision++; invalidate(next); }
      if (previous && !same(previous.criteria, mutation.plan.criteria)) { next.acceptanceRevision++; invalidate(next); }
      if (previous && !same(previous.steps.map(step => step.status), mutation.plan.steps.map(step => step.status))) delete next.review;
      Object.assign(next, JSON.parse(canonicalNativeTask(mutation.plan))); summary = mutation.explanation ?? 'Plan updated'; break;
    }
    case 'workspace': {
      keys(mutation, ['type', 'baseline', 'current', 'changes'], 'workspace mutation'); validateWorkspace(mutation.current); validateChanges(mutation.changes);
      if (mutation.baseline) validateWorkspace(mutation.baseline);
      if (!next.workspace && !mutation.baseline) fail('invalid_task', 'Initial workspace requires a baseline');
      if (next.workspace && mutation.baseline && !same(next.workspace.baseline, mutation.baseline)) fail('invalid_task', 'Task baseline cannot change');
      if (next.workspace && (next.workspace.current.fingerprint !== mutation.current.fingerprint || next.workspace.current.complete !== mutation.current.complete)) invalidate(next);
      next.workspace = { baseline: next.workspace?.baseline ?? mutation.baseline!, current: mutation.current, changes: mutation.changes }; break;
    }
    case 'evidence': {
      keys(mutation, ['type', 'evidence'], 'evidence mutation'); validateEvidence(mutation.evidence, next);
      if (!same(mutation.evidence.identity, update.identity) || mutation.evidence.planRevision !== next.planRevision || mutation.evidence.acceptanceRevision !== next.acceptanceRevision || mutation.evidence.stale) fail('invalid_identity', 'Evidence is not bound to the current task/run/plan');
      if (next.evidence.length >= NATIVE_TASK_LIMITS.evidence) fail('limit_exceeded', 'Task evidence limit reached');
      if (next.evidence.some(item => item.id === mutation.evidence.id)) fail('invalid_task', 'Evidence ids cannot be reused');
      if (mutation.evidence.status === 'passed' && (!next.workspace?.current.complete || mutation.evidence.workspaceFingerprint !== next.workspace.current.fingerprint)) fail('invalid_task', 'Passing evidence needs the current complete workspace');
      next.evidence.push(mutation.evidence); delete next.review; break;
    }
    case 'review': {
      keys(mutation, ['type', 'status', 'reason'], 'review mutation'); text(mutation.reason, 'review reason', 4000);
      if (!['approved', 'rejected'].includes(mutation.status)) fail('invalid_task', 'Invalid review status');
      if (mutation.status === 'approved' && (!next.criteria.length || !next.steps.every(step => step.status === 'implemented') ||
          !next.criteria.every(criterion => ['passed', 'not_applicable'].includes(getNativeTaskCriterionVerification(next, criterion.id))))) fail('verification_incomplete', 'Every implemented step and current acceptance condition must be reviewed before overall approval');
      next.review = { status: mutation.status, reason: mutation.reason, at: now }; summary = mutation.reason; break;
    }
    case 'invalidate': keys(mutation, ['type', 'reason'], 'invalidate mutation'); text(mutation.reason, 'invalidation reason'); invalidate(next); summary = mutation.reason; break;
    case 'finish':
      keys(mutation, ['type', 'outcome'], 'finish mutation'); text(mutation.outcome, 'run outcome', 256);
      if (next.execution !== 'active') fail('task_ended', 'Task execution has already ended');
      next.execution = 'ended'; next.runOutcome = mutation.outcome;
      next.steps.forEach(step => { if (step.status === 'in_progress') { step.status = 'interrupted'; step.blockedReason = 'Execution ended before this step was declared implemented'; } }); break;
    case 'interrupt':
      keys(mutation, ['type', 'reason'], 'interrupt mutation'); text(mutation.reason, 'interruption reason');
      next.execution = 'interrupted'; next.runOutcome = 'interrupted'; summary = mutation.reason;
      next.steps.forEach(step => { if (step.status === 'in_progress') { step.status = 'interrupted'; step.blockedReason = mutation.reason; } }); break;
    case 'continue':
      keys(mutation, ['type', 'previousRunId'], 'continuation mutation'); uuid(mutation.previousRunId, 'previous runId');
      if (!previous || previous.identity.runId !== mutation.previousRunId || previous.identity.runId === update.identity.runId || previous.execution === 'active') fail('invalid_identity', 'Continuation needs the exact ended previous run');
      if (previous.history.some(item => item.runId === update.identity.runId)) fail('invalid_identity', 'A past task run cannot be reused');
      next.identity = update.identity; next.execution = 'active'; delete next.runOutcome; delete next.review; break;
    default: fail('invalid_task', 'Unknown task mutation');
  }
  next.revision++; next.updatedAt = now;
  next.history.push({ revision: next.revision, mutationId: update.mutationId, kind: mutation.type, runId: update.identity.runId, at: now, summary });
  next.verification = deriveNativeTaskVerification(next);
  validateNativeTaskSnapshot(next);
  return JSON.parse(canonicalNativeTask(next)) as NativeTaskSnapshot;
}
