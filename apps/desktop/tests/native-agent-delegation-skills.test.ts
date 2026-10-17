import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { canonicalJson, type ApprovalDecision, type JsonValue, type RunIdentity, type ToolExecutionContext } from '@cc-desk/agent-core';
import { createAgentDelegationTools, type NativeAgentChildInput, type NativeAgentChildResult, type NativeAgentDelegationOptions,
  type NativeAgentSkillInheritanceHooks, type NativeDelegationReceipt } from '../src/main/engines/native/agent-delegation';
import { nativeSkillInheritanceDigest, type NativeSkillInheritanceManifest } from '../src/main/engines/native/skill-inheritance';
import { nativeDelegationExecutionPath } from '../src/main/engines/native/agent-delegation-audit';

const exec = promisify(execFile);
const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value as JsonValue)).digest('hex');
const guidePath = '.agents/skills/engineering/SKILL.md';
const guideBody = 'Retain source versions and report actual verification.';
async function git(cwd: string, ...args: string[]) { return (await exec('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })).stdout; }

function manifestFor(identity: RunIdentity, tag = 'original'): NativeSkillInheritanceManifest {
  const skillId = `skill:${hash('engineering')}`, sourceFingerprint = hash('source');
  const version = { skillId, sourceRevision: 1, sourceFingerprint, fullFileHash: hash(tag), bodyHash: hash(guideBody), bytes: Buffer.byteLength(guideBody), format: 'standard' as const };
  const catalogRevision = hash(`catalog-${tag}`);
  const parentManifest = { schemaVersion: 1 as const, identity, catalogRevision, entries: [{ skillId, sourceId: 'project-agents', relativePath: 'engineering/SKILL.md',
    version, origin: 'explicit' as const, evidence: { kind: 'run_started' as const, seq: 1 }, placement: 'initial_instructions' as const }] };
  const manifest = { schemaVersion: 1 as const, context: { schemaVersion: 1 as const, parentHead: { seq: 1, hash: hash('head') },
    parentManifest: { ...parentManifest, digest: hash(parentManifest) } },
  catalog: { schemaVersion: 1 as const, revision: catalogRevision, entries: [{ skillId, sourceId: 'project-agents', scope: 'project' as const,
    relativePath: 'engineering/SKILL.md', sourceRevision: 1, sourceFingerprint, metadataHash: hash('metadata'), bytes: version.bytes,
    format: 'standard' as const, name: 'engineering', description: 'Review actual source evidence.', autoMatchable: true, diagnostics: [], headerBytes: 0 }], issues: [], truncated: false },
  versions: [version], excludedSkillIds: [] };
  return { ...manifest, digest: nativeSkillInheritanceDigest(manifest) };
}
const resultFor = (input: NativeAgentChildInput, overrides: Partial<NativeAgentChildResult> = {}): NativeAgentChildResult => ({ identity: input.identity, taskId: input.taskId,
  status: 'completed', reason: 'model_completed', committed: true, summary: 'Verified child fixture.', modelRequests: 1, toolCalls: 0, ...overrides });

async function fixture(t: { after(fn: () => Promise<void>): void }, setup: (identity: RunIdentity) => {
  hooks: NativeAgentSkillInheritanceHooks; runChild(input: NativeAgentChildInput): Promise<NativeAgentChildResult>; requiresApproval?: boolean; maxSubagents?: number;
}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cc-skill-delegation-'))), cwd = path.join(directory, 'repo');
  await fs.mkdir(path.dirname(path.join(cwd, guidePath)), { recursive: true });
  await fs.writeFile(path.join(cwd, guidePath), guideBody); await fs.writeFile(path.join(cwd, 'file.txt'), 'initial\n');
  await git(cwd, 'init', '-b', 'main'); await git(cwd, 'config', 'user.name', 'Test'); await git(cwd, 'config', 'user.email', 'test@localhost');
  await git(cwd, 'config', 'core.autocrlf', 'false'); await git(cwd, 'add', '--all'); await git(cwd, 'commit', '-m', 'Initial');
  const identity: RunIdentity = { sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 };
  const abort = new AbortController(), selected = setup(identity), receipts = new Map<string, NativeDelegationReceipt>(), inputs: NativeAgentChildInput[] = [];
  const options: NativeAgentDelegationOptions = { identity, parentTaskId: randomUUID(), cwd, policy: 'workspace_write', signal: abort.signal,
    forbiddenValues: ['sk-protected-delegation-secret'], storeDirectory: path.join(directory, 'records'), worktreeRoot: path.join(directory, 'worktrees'),
    maxSubagents: selected.maxSubagents ?? 2, requiresApproval: selected.requiresApproval ?? false, skills: selected.hooks, assertOwnership: async () => {},
    createChildBudget: () => ({ consume: async () => true, remainingMs: () => 120000, snapshot: () => ({ modelRequests: 0, toolCalls: 0 }) }),
    runChild: async input => { inputs.push(input); return selected.runChild(input); }, record: async receipt => { receipts.set(receipt.childId, structuredClone(receipt)); } };
  const tool = createAgentDelegationTools(options), context: ToolExecutionContext = { identity, policyRevision: 'policy', signal: abort.signal, maxOutputBytes: 65536 };
  t.after(async () => { await tool.closeAll(); await fs.rm(directory, { recursive: true, force: true }); });
  const prepare = (mode = 'delegate_review', tasks = [{ title: 'Independent task', goal: 'Verify source evidence.' }]) => tool.prepare({ id: randomUUID(), name: mode,
    arguments: JSON.stringify({ tasks, ...(mode === 'delegate_implement' ? { baseline: 'head' } : {}) }) }, context);
  return { cwd, directory, options, tool, identity, context, inputs, receipts, prepare };
}

test('delegation freezes exact Skills into durable preconditions and retries preserve the original child receipts', async t => {
  let frozen!: NativeSkillInheritanceManifest, freezes = 0, validations = 0;
  const f = await fixture(t, identity => {
    frozen = manifestFor(identity);
    return { hooks: { freeze: async () => { freezes++; return frozen; }, assertCurrent: async manifest => { validations++; assert.deepEqual(manifest, frozen); },
      preflightChild: async (manifest, input) => { assert.deepEqual(manifest, frozen); assert.equal(input.toolPolicy, 'read_only'); assert.equal(input.cwd, f.cwd); } },
    runChild: async input => resultFor(input) };
  });
  const prepared = await f.prepare();
  assert.equal((prepared.preconditions as { nativeSkillsDigest: string }).nativeSkillsDigest, frozen.digest);
  assert.deepEqual((prepared.preconditions as { nativeSkills: unknown }).nativeSkills, frozen);
  const changed = structuredClone(prepared); (changed.preconditions as { nativeSkillsDigest: string }).nativeSkillsDigest = hash('forged');
  assert.equal((await f.tool.execute(changed, f.context)).status, 'not_executed');
  await f.tool.validate(prepared, f.context);
  const result = await f.tool.execute(prepared, f.context), saved = [...f.receipts.values()][0];
  assert.equal(result.status, 'completed'); assert.deepEqual(saved.nativeSkills, frozen); assert.deepEqual(f.inputs[0].nativeSkills, frozen);
  assert.equal(freezes, 1); assert.ok(validations >= 2);
  frozen = manifestFor(f.identity, 'changed-after-terminal');
  assert.deepEqual(await f.tool.execute(prepared, f.context), result);
  assert.equal(f.inputs.length, 1, 'retrying a completed delegation never starts another child or reloads its Skills');
});

test('an activation or source change after approval prevents launch before child or worktree effects', async t => {
  let selected!: NativeSkillInheritanceManifest;
  const f = await fixture(t, identity => {
    selected = manifestFor(identity);
    return { requiresApproval: true, hooks: { freeze: async () => selected, assertCurrent: async manifest => { if (manifest.digest !== selected.digest) throw new Error('Active Skill set changed'); },
      preflightChild: async () => assert.fail('No child preflight may start.') }, runChild: async () => assert.fail('No child may start.') };
  });
  const prepared = await f.prepare('delegate_implement');
  const approved: ApprovalDecision = { decision: 'approved', expiresAt: Date.now() + 120000,
    binding: { ...f.identity, toolCallId: prepared.call.id, inputDigest: prepared.inputDigest, policyRevision: prepared.policyRevision } };
  selected = manifestFor(f.identity, 'new-active-guide');
  await assert.rejects(f.tool.validate(prepared, f.context), /changed/);
  assert.equal((await f.tool.execute(prepared, f.context, approved)).status, 'not_executed');
  assert.equal(f.inputs.length, 0); assert.equal(f.receipts.size, 0); await assert.rejects(fs.stat(f.options.worktreeRoot));
});

test('a source mismatch in one allocated child worktree stays known failed and releases only its own slot', async t => {
  let preflights = 0;
  const f = await fixture(t, identity => ({ hooks: { freeze: async () => manifestFor(identity), assertCurrent: async () => {}, preflightChild: async (_manifest, input) => {
    if (++preflights === 1) await fs.writeFile(path.join(input.cwd, guidePath), 'Changed child-local source.');
    if (await fs.readFile(path.join(input.cwd, guidePath), 'utf8') !== guideBody) throw new Error('Child Skill source differs from parent.');
  } }, runChild: async input => resultFor(input) }));
  const prepared = await f.prepare('delegate_implement', [{ title: 'Mismatch', goal: 'Inspect source.' }, { title: 'Independent sibling', goal: 'Inspect another source.' }]);
  assert.equal((await f.tool.execute(prepared, f.context)).status, 'completed');
  const saved = [...f.receipts.values()], failed = saved.find(receipt => receipt.status === 'failed');
  assert.ok(failed); assert.equal(failed.error, 'skill_inheritance_preflight_failed'); assert.equal(failed.workspaceVerified, true); assert.ok(failed.artifact);
  assert.equal(failed.result, undefined, 'host source mismatch does not fabricate a child terminal journal');
  assert.equal(saved.filter(receipt => receipt.status === 'completed').length, 1); assert.equal(f.inputs.length, 1);
  assert.equal(saved.some(receipt => receipt.status === 'unknown'), false);
  assert.equal(await fs.readFile(path.join(f.cwd, guidePath), 'utf8'), guideBody);
  assert.equal((await f.tool.execute(await f.prepare('delegate_implement'), f.context)).status, 'completed'); assert.equal(f.inputs.length, 2);
});

test('recover_agent retains the original manifest and effects while creating a fresh child identity and budget', async t => {
  let original!: NativeSkillInheritanceManifest, current!: NativeSkillInheritanceManifest, freezes = 0;
  const validationRecovery: boolean[] = [];
  const f = await fixture(t, identity => {
    original = current = manifestFor(identity);
    return { hooks: { freeze: async () => { freezes++; return current; }, assertCurrent: async (manifest, _signal, recovery) => {
      validationRecovery.push(recovery); assert.deepEqual(manifest, recovery ? original : current);
    }, preflightChild: async (manifest, input) => { assert.deepEqual(manifest, original); if (input.recovery) assert.equal(input.recovery.reason, 'model_failed'); } },
    runChild: async input => {
      assert.deepEqual(input.nativeSkills, original);
      if (!input.recovery) { await fs.writeFile(path.join(input.cwd, 'effect.txt'), 'executed once'); return resultFor(input, { status: 'failed', reason: 'model_failed', toolCalls: 1 }); }
      assert.equal(await fs.readFile(path.join(input.cwd, 'effect.txt'), 'utf8'), 'executed once'); return resultFor(input);
    } };
  });
  await f.tool.execute(await f.prepare('delegate_implement'), f.context);
  const failed = structuredClone([...f.receipts.values()][0]); current = manifestFor(f.identity, 'new-parent-catalog');
  const prepared = await f.tool.prepare({ id: randomUUID(), name: 'recover_agent', arguments: JSON.stringify({ childId: failed.childId }) }, f.context);
  assert.deepEqual((prepared.preconditions as { nativeSkills: unknown }).nativeSkills, original);
  await f.tool.validate(prepared, f.context); assert.equal((await f.tool.execute(prepared, f.context)).status, 'completed');
  assert.equal(freezes, 1, 'recovery cannot replace the original inherited snapshot with the current parent catalog');
  assert.equal(f.inputs.length, 2); assert.notEqual(f.inputs[1].identity.runId, f.inputs[0].identity.runId); assert.notEqual(f.inputs[1].budget, f.inputs[0].budget);
  assert.equal(f.inputs[1].cwd, f.inputs[0].cwd); assert.ok(validationRecovery.includes(true));
  assert.deepEqual(f.receipts.get(failed.childId), failed, 'recovery preserves prior receipt and evidence');
  assert.deepEqual([...f.receipts.values()].find(receipt => receipt.recovery)?.nativeSkills, original);
});

test('recovery refuses a recorded inherited manifest when its runtime is unavailable', async t => {
  const f = await fixture(t, identity => ({ hooks: { freeze: async () => manifestFor(identity), assertCurrent: async () => {}, preflightChild: async () => {} },
    runChild: async input => resultFor(input, { status: 'failed', reason: 'model_failed' }) }));
  await f.tool.execute(await f.prepare(), f.context); const failed = [...f.receipts.values()][0];
  delete f.options.skills;
  await assert.rejects(f.tool.prepare({ id: randomUUID(), name: 'recover_agent', arguments: JSON.stringify({ childId: failed.childId }) }, f.context), /运行时/);
  assert.equal(f.inputs.length, 1);
});

for (const uncertain of [false, true]) test(`a rejected child launch is ${uncertain ? 'unknown when cleanup is unconfirmed' : 'known not started only with host proof'}`, async t => {
  const f = await fixture(t, identity => ({ hooks: { freeze: async () => manifestFor(identity), assertCurrent: async () => {}, preflightChild: async () => {} },
    runChild: async () => { throw Object.assign(new Error('Host preflight rejected'), { code: 'child_start_preconditions_failed', childNotStarted: true,
      ...(uncertain ? { cleanupUnconfirmed: true } : {}) }); } }));
  assert.equal((await f.tool.execute(await f.prepare(), f.context)).status, 'completed');
  const receipt = [...f.receipts.values()][0]; assert.equal(receipt.status, uncertain ? 'unknown' : 'failed');
  assert.equal(receipt.error, uncertain ? 'child_run_unconfirmed' : 'child_start_preconditions_failed');
  const execution = JSON.parse(await fs.readFile(nativeDelegationExecutionPath(f.options.storeDirectory, f.identity, receipt.batchId), 'utf8'));
  if (!uncertain) { assert.equal(execution.children[0].started, undefined); assert.equal(execution.children[0].settled, undefined); }
});

test('queued work retains its frozen Skills and rejects source changes before allocating another budget', async t => {
  let selected!: NativeSkillInheritanceManifest, freezes = 0, preflights = 0, budgets = 0;
  const f = await fixture(t, identity => {
    selected = manifestFor(identity);
    return { maxSubagents: 1, hooks: { freeze: async () => { freezes++; return selected; }, assertCurrent: async manifest => {
      if (manifest.digest !== selected.digest) throw new Error('Inherited source changed while queued');
    }, preflightChild: async () => { preflights++; } }, runChild: async input => {
      selected = manifestFor(identity, 'changed-during-first-child'); return resultFor(input);
    } };
  });
  const originalBudget = f.options.createChildBudget;
  f.options.createChildBudget = identity => { budgets++; return originalBudget(identity); };
  assert.equal((await f.tool.execute(await f.prepare('delegate_review', [{ title: 'A', goal: 'First question' }, { title: 'B', goal: 'Queued question' }]), f.context)).status, 'completed');
  assert.equal(freezes, 1); assert.equal(preflights, 1); assert.equal(budgets, 1); assert.equal(f.inputs.length, 1);
  const queued = [...f.receipts.values()].find(receipt => receipt.title === 'B')!;
  assert.equal(queued.status, 'failed'); assert.equal(queued.error, 'skill_inheritance_preflight_failed'); assert.equal(queued.result, undefined); assert.equal(queued.workspace, undefined);
  assert.equal(queued.nativeSkills!.digest, f.inputs[0].nativeSkills!.digest, 'source changes never replace the admitted manifest');
});
