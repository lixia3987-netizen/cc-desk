import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ApprovalDecision, ToolExecutionContext } from '@cc-desk/agent-core';
import { createAgentDelegationTools, type NativeAgentChildInput, type NativeAgentChildResult, type NativeDelegationBudget, type NativeDelegationReceipt } from '../src/main/engines/native/agent-delegation';
import { collectAgentWorkspaceEvidence, createAgentWorktree, materializeAgentBaseline, prepareAgentBaseline, verifyAgentBaseline, verifyAgentWorkspace } from '../src/main/engines/native/agent-worktrees';
import { ensureWorktreeParent } from '../src/main/worktree-paths';
import { nativeDelegationExecutionPath, nativeDelegationIntervalsOverlap } from '../src/main/engines/native/agent-delegation-audit';

const execute = promisify(execFile);
async function git(cwd: string, ...args: string[]) { return (await execute('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })).stdout; }
async function repository(t: { after(fn: () => Promise<void>): void }) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cc-native-delegation-')));
  t.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  const cwd = path.join(directory, 'repo'); await fs.mkdir(cwd);
  await git(cwd, 'init', '-b', 'main');
  await git(cwd, 'config', 'user.name', 'Test'); await git(cwd, 'config', 'user.email', 'test@localhost');
  await git(cwd, 'config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(cwd, 'file.txt'), 'initial\n');
  await fs.writeFile(path.join(cwd, '.gitignore'), 'ignored.txt\n');
  await git(cwd, 'add', '--all'); await git(cwd, 'commit', '-m', 'Initial');
  return { directory, cwd, worktreeRoot: path.join(directory, 'worktrees'), storeDirectory: path.join(directory, 'records') };
}
const resultFor = (input: NativeAgentChildInput, result: Partial<NativeAgentChildResult> = {}): NativeAgentChildResult => ({ identity: input.identity, taskId: input.taskId,
  status: 'completed', reason: 'model_completed', committed: true, summary: `${input.title}完成`, modelRequests: 1, toolCalls: 0, ...result });
function fixture(directory: string, runChild: (input: NativeAgentChildInput) => Promise<NativeAgentChildResult>, options: { policy?: 'read_only' | 'workspace_write'; budget?: NativeDelegationBudget; maxSubagents?: number; createChildBudget?: (identity: NativeAgentChildInput['identity']) => NativeDelegationBudget; requiresApproval?: boolean; record?: (r: NativeDelegationReceipt) => Promise<void>; storeDirectory?: string } = {}) {
  const abort = new AbortController();
  const identity = { sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 };
  const budget: NativeDelegationBudget = options.budget ?? { consume: async () => true, remainingMs: () => 120000, snapshot: () => ({ modelRequests: 0, toolCalls: 0 }) };
  const tool = createAgentDelegationTools({ identity, parentTaskId: randomUUID(), cwd: directory, policy: options.policy ?? 'workspace_write', signal: abort.signal,
    forbiddenValues: ['sk-protected-delegation-secret'], storeDirectory: options.storeDirectory ?? path.join(directory, '..', 'records'), worktreeRoot: path.join(directory, '..', 'worktrees'),
    assertOwnership: async () => {}, createChildBudget: options.createChildBudget ?? (() => ({ ...budget })), maxSubagents: options.maxSubagents, runChild, requiresApproval: options.requiresApproval ?? false, record: options.record });
  const context: ToolExecutionContext = { identity, policyRevision: 'instructions:1', signal: abort.signal, maxOutputBytes: 64 * 1024 };
  const prepare = (tasks = [{ title: '审阅', goal: '检查状态边界' }], name = 'delegate_review', id = randomUUID(), baseline = 'snapshot') =>
    tool.prepare({ id, name, arguments: JSON.stringify({ tasks, ...(name === 'delegate_implement' ? { baseline } : {}) }) }, context);
  return { abort, identity, budget, tool, context, prepare };
}
async function readReceipts(directory: string): Promise<NativeDelegationReceipt[]> {
  const root = path.join(directory, 'delegations');
  const result: NativeDelegationReceipt[] = [];
  const read = async (target: string): Promise<void> => {
    for (const item of await fs.readdir(target, { withFileTypes: true })) {
      if (item.isDirectory()) await read(path.join(target, item.name));
      else if (item.isFile() && item.name === 'receipt.json') result.push(JSON.parse(await fs.readFile(path.join(target, item.name), 'utf8')));
    }
  };
  await read(root);
  return result;
}

test('one review batch starts separate child contexts concurrently and retains bound receipts', async t => {
  const repo = await repository(t);
  let starts = 0, release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const inputs: NativeAgentChildInput[] = [];
  const f = fixture(repo.cwd, async input => { inputs.push(input); if (++starts === 3) release(); await barrier; assert.equal(starts, 3); return resultFor(input); });
  t.after(() => f.tool.closeAll());
  const tasks = Array.from({ length: 3 }, (_, i) => ({ title: `审阅${i}`, goal: '独立检查相关代码' }));
  const prepared = await f.prepare(tasks); await f.tool.validate(prepared, f.context);
  const result = await f.tool.execute(prepared, f.context);
  assert.equal(result.status, 'completed'); assert.equal(starts, 3);
  assert.equal(new Set(inputs.map(i => i.identity.sessionId)).size, 3); assert.equal(new Set(inputs.map(i => i.identity.conversationId)).size, 3);
  assert.equal(new Set(inputs.map(i => i.identity.runId)).size, 3); assert.equal(new Set(inputs.map(i => i.taskId)).size, 3);
  for (const input of inputs) { assert.equal(input.cwd, repo.cwd); assert.equal(input.toolPolicy, 'read_only'); assert.notEqual(input.budget, f.budget); assert.deepEqual(input.parentIdentity, f.identity); }
  const receipts = await readReceipts(repo.storeDirectory);
  assert.equal(receipts.length, 3); assert.ok(receipts.every(r => r.status === 'completed' && r.result?.committed));
  assert.ok(receipts.every(r => r.parentTaskId === inputs[0].parentTaskId));
  assert.ok(inputs.every(input => receipts.some(receipt => receipt.childId === input.childId && receipt.identity.runId === input.identity.runId)));
  const execution = JSON.parse(await fs.readFile(nativeDelegationExecutionPath(repo.storeDirectory, f.identity, receipts[0].batchId), 'utf8'));
  assert.equal(nativeDelegationIntervalsOverlap(execution), true);
  assert.equal(execution.children.length, 3);
  assert.ok(execution.children.every((child: { started?: unknown; settled?: unknown }) => child.started && child.settled));
  assert.deepEqual(await f.tool.execute(prepared, f.context), result); assert.equal(starts, 3, 'exact retries never start another child');
});

test('canonical temporary roots support Git worktrees while unnormalized symbolic ancestors remain blocked', async t => {
  const repo = await repository(t), realTemp = path.join(repo.directory, 'real-temp'), aliasTemp = path.join(repo.directory, 'temp-alias');
  await fs.mkdir(realTemp);
  await fs.symlink(realTemp, aliasTemp, process.platform === 'win32' ? 'junction' : 'dir');
  const aliasedFixture = await fs.mkdtemp(path.join(aliasTemp, 'fixture-'));
  await assert.rejects(ensureWorktreeParent(path.join(aliasedFixture, 'worktrees'), []), /符号链接/);
  const canonicalFixture = await fs.realpath(aliasedFixture), baseline = await prepareAgentBaseline(repo.cwd, 'head');
  const worktree = await createAgentWorktree(baseline, path.join(canonicalFixture, 'worktrees'), baseline.parentHead, randomUUID());
  assert.equal(worktree.path, await fs.realpath(worktree.path));
  assert.equal(await fs.readFile(path.join(worktree.cwd, 'file.txt'), 'utf8'), 'initial\n');
  assert.equal((await git(repo.cwd, 'rev-parse', 'HEAD')).trim(), baseline.parentHead);
});

test('retained workspace verification canonicalizes real Git roots and still rejects changed branches, escaped cwd and links', async t => {
  const repo = await repository(t), root = path.join(repo.directory, 'retained 空格'), baseline = await prepareAgentBaseline(repo.cwd, 'head');
  const worktree = await createAgentWorktree(baseline, root, baseline.parentHead, randomUUID());
  const reported = (await git(worktree.path, 'rev-parse', '--show-toplevel')).trim();
  assert.equal(await fs.realpath(reported), worktree.path);
  if (process.platform === 'win32') {
    assert.ok(reported.includes('/'), 'real Git on Windows reports a slash-form path');
    assert.ok(worktree.path.includes('\\'), 'the retained host path uses Windows separators');
    assert.notEqual(reported, worktree.path, 'equivalent Git and host paths require filesystem canonicalization');
  }
  await verifyAgentWorkspace(worktree, root);
  await assert.rejects(verifyAgentWorkspace({ ...worktree, cwd: repo.cwd }, root), { code: 'worktree_identity_changed' });
  const alias = path.join(root, 'linked-workspace');
  await fs.symlink(worktree.path, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyAgentWorkspace({ ...worktree, path: alias, cwd: alias }, root), { code: 'worktree_identity_changed' });
  await git(worktree.path, 'checkout', '-b', 'changed-retained-branch');
  await assert.rejects(verifyAgentWorkspace(worktree, root), { code: 'worktree_identity_changed' });
  assert.equal(await fs.readFile(path.join(worktree.cwd, 'file.txt'), 'utf8'), 'initial\n');
  assert.equal((await git(repo.cwd, 'symbolic-ref', '--short', 'HEAD')).trim(), 'main');
});

test('read-only parents cannot register or invoke implementation and forged bindings are rejected', async t => {
  const repo = await repository(t); let started = 0;
  const f = fixture(repo.cwd, async input => { started++; return resultFor(input); }, { policy: 'read_only' });
  t.after(() => f.tool.closeAll());
  assert.deepEqual(f.tool.definitions.map(d => d.name), ['delegate_review', 'recover_agent']);
  await assert.rejects(f.prepare(undefined, 'delegate_implement'));
  const prepared = await f.prepare();
  await assert.rejects(f.tool.validate({ ...prepared, input: { tasks: [] } }, f.context));
  assert.equal((await f.tool.execute(prepared, { ...f.context, identity: { ...f.identity, sessionId: randomUUID() } })).status, 'not_executed');
  assert.equal(started, 0);
});

test('a child recovery barrier stays unknown in its receipt while the parent tool completes', async t => {
  const repo = await repository(t);
  const f = fixture(repo.cwd, async input => resultFor(input, { status: 'recovery_required', reason: 'unknown_tool_effects', committed: true }));
  t.after(() => f.tool.closeAll());
  const result = await f.tool.execute(await f.prepare(), f.context);
  assert.equal(result.status, 'completed');
  const saved = await readReceipts(repo.storeDirectory);
  assert.equal(saved[0].status, 'unknown'); assert.equal(saved[0].error, 'child_recovery_required');
  assert.equal(saved[0].result!.committed, true); assert.equal(saved[0].result!.status, 'recovery_required');
});

test('parent cancellation reaches every live sibling and waits for durable cancellation receipts', async t => {
  const repo = await repository(t); let starts = 0, cancelled = 0, ready!: () => void;
  const allStarted = new Promise<void>(resolve => { ready = resolve; });
  const f = fixture(repo.cwd, input => new Promise(resolve => {
    if (++starts === 2) ready();
    input.signal.addEventListener('abort', () => { cancelled++; resolve(resultFor(input, { status: 'cancelled', reason: 'parent_cancelled' })); }, { once: true });
  }));
  const prepared = await f.prepare([{ title: '一', goal: '审阅一' }, { title: '二', goal: '审阅二' }]);
  const pending = f.tool.execute(prepared, f.context); await allStarted;
  f.abort.abort(); await f.tool.closeAll();
  assert.equal((await pending).status, 'cancelled'); assert.equal(cancelled, 2);
  assert.ok((await readReceipts(repo.storeDirectory)).every(r => r.status === 'cancelled'));
});

test('siblings receive fresh atomic request budgets without consuming each other allowances', async t => {
  const repo = await repository(t); let consumed = 0;
  const f = fixture(repo.cwd, async input => {
    const allowed = await input.budget.consume('model', input.identity);
    return resultFor(input, { status: allowed ? 'completed' : 'budget_exhausted', reason: allowed ? 'model_completed' : 'model_request_budget', modelRequests: allowed ? 1 : 0 });
  }, { createChildBudget: () => { let requests = 0; return { consume: async () => requests < 1 ? (++requests, ++consumed, true) : false, remainingMs: () => 120000, snapshot: () => ({ modelRequests: requests, toolCalls: 0 }) }; } }); t.after(() => f.tool.closeAll());
  const result = await f.tool.execute(await f.prepare([{ title: '一', goal: '审阅一' }, { title: '二', goal: '审阅二' }]), f.context);
  assert.equal(result.status, 'completed'); assert.equal(consumed, 2);
  const receipts = await readReceipts(repo.storeDirectory);
  assert.equal(receipts.reduce((sum, r) => sum + r.result!.modelRequests, 0), 2);
  assert.equal(receipts.filter(r => r.result?.status === 'budget_exhausted').length, 0);
});

test('dirty snapshots preserve staged/unstaged/new files while leaving parent HEAD, index and files intact', async t => {
  const repo = await repository(t);
  await fs.writeFile(path.join(repo.cwd, 'file.txt'), 'staged\n'); await git(repo.cwd, 'add', 'file.txt');
  await fs.writeFile(path.join(repo.cwd, 'file.txt'), 'unstaged\n'); await fs.writeFile(path.join(repo.cwd, 'new.txt'), 'new parent file\n');
  await fs.writeFile(path.join(repo.cwd, 'ignored.txt'), 'ignored parent artifact\n');
  const indexBefore = await fs.readFile(path.join(repo.cwd, '.git', 'index')), headBefore = await git(repo.cwd, 'rev-parse', 'HEAD');
  const baseline = await prepareAgentBaseline(repo.cwd, 'snapshot');
  assert.equal(baseline.dirty, true);
  await assert.rejects(prepareAgentBaseline(repo.cwd, 'head'), /snapshot/);
  const commit = await materializeAgentBaseline(baseline, repo.worktreeRoot);
  assert.notEqual(commit, baseline.parentHead);
  const tree = await createAgentWorktree(baseline, repo.worktreeRoot, commit, randomUUID());
  assert.equal(await fs.readFile(path.join(tree.cwd, 'file.txt'), 'utf8'), 'unstaged\n');
  assert.equal(await fs.readFile(path.join(tree.cwd, 'new.txt'), 'utf8'), 'new parent file\n');
  await assert.rejects(fs.stat(path.join(tree.cwd, 'ignored.txt')));
  assert.deepEqual(await fs.readFile(path.join(repo.cwd, '.git', 'index')), indexBefore);
  assert.equal(await git(repo.cwd, 'rev-parse', 'HEAD'), headBefore); assert.equal((await git(repo.cwd, 'branch', '--show-current')).trim(), 'main');
  assert.equal(await fs.readFile(path.join(repo.cwd, 'file.txt'), 'utf8'), 'unstaged\n');
  assert.equal(await fs.readFile(path.join(repo.cwd, 'new.txt'), 'utf8'), 'new parent file\n');
  await fs.writeFile(path.join(tree.cwd, 'child.txt'), 'child artifact\n'); await fs.rm(path.join(tree.cwd, 'file.txt'));
  const evidence = await collectAgentWorkspaceEvidence(tree, repo.worktreeRoot);
  assert.ok(evidence.changedFiles.some(f => f.path === 'child.txt' && f.status === 'A'));
  assert.ok(evidence.changedFiles.some(f => f.path === 'file.txt' && f.status === 'D'));
  assert.match(evidence.patch.toString('utf8'), /child artifact/); assert.match(evidence.patch.toString('utf8'), /deleted file mode/);
  assert.deepEqual(await fs.readFile(path.join(repo.cwd, '.git', 'index')), indexBefore);
});

test('approval binds the snapshot and changed parent content blocks launch before side effects', async t => {
  const repo = await repository(t); let starts = 0;
  const f = fixture(repo.cwd, async input => { starts++; return resultFor(input); }, { requiresApproval: true }); t.after(() => f.tool.closeAll());
  const prepared = await f.prepare(undefined, 'delegate_implement');
  assert.equal(prepared.requiresApproval, true);
  assert.equal((await f.tool.execute(prepared, f.context)).status, 'denied');
  const approval: ApprovalDecision = { decision: 'approved', expiresAt: Date.now() + 120000,
    binding: { ...f.identity, toolCallId: prepared.call.id, inputDigest: prepared.inputDigest, policyRevision: prepared.policyRevision } };
  await fs.writeFile(path.join(repo.cwd, 'file.txt'), 'parent changed after approval\n');
  await assert.rejects(f.tool.validate(prepared, f.context), /基线/);
  assert.equal((await f.tool.execute(prepared, f.context, approval)).status, 'not_executed'); assert.equal(starts, 0);
  await assert.rejects(fs.stat(repo.worktreeRoot));
});

test('parallel implement children receive isolated worktrees from one snapshot and preserve artifacts on close', async t => {
  const repo = await repository(t); await fs.writeFile(path.join(repo.cwd, 'file.txt'), 'parent draft\n');
  let started = 0, release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(repo.cwd, async input => {
    assert.equal(input.toolPolicy, 'workspace_write'); assert.notEqual(input.cwd, repo.cwd);
    assert.equal(await fs.readFile(path.join(input.cwd, 'file.txt'), 'utf8'), 'parent draft\n');
    await fs.writeFile(path.join(input.cwd, 'result.txt'), input.title);
    if (++started === 2) release(); await barrier;
    return resultFor(input, { evidence: { runJournalPath: path.join(repo.storeDirectory, `${input.identity.runId}.jsonl`),
      commandReceipts: [{ toolCallId: 'test-1', status: 'completed', exitCode: 0, receiptPath: 'test-receipt.json' }] } });
  });
  const prepared = await f.prepare([{ title: '功能 A', goal: '实现 A' }, { title: '功能 B', goal: '实现 B' }], 'delegate_implement');
  const result = await f.tool.execute(prepared, f.context); assert.equal(result.status, 'completed');
  await f.tool.closeAll();
  const receipts = await readReceipts(repo.storeDirectory);
  assert.equal(new Set(receipts.map(r => r.workspace!.path)).size, 2);
  assert.equal(new Set(receipts.map(r => r.workspace!.baseCommit)).size, 1);
  for (const receipt of receipts) {
    assert.equal(receipt.workspaceVerified, true); assert.match(receipt.workspace!.branch, /^codex\/native-agent-/);
    assert.equal(await fs.readFile(path.join(receipt.workspace!.cwd, 'result.txt'), 'utf8'), receipt.title);
    const patch = await fs.readFile(receipt.artifact!.patchPath);
    assert.match(patch.toString('utf8'), /result.txt/);
    assert.equal(receipt.artifact!.sha256, createHash('sha256').update(patch).digest('hex'));
    assert.equal(receipt.artifact!.bytes, patch.byteLength);
    assert.equal(receipt.result!.evidence!.commandReceipts![0].exitCode, 0);
  }
  await assert.rejects(fs.stat(path.join(repo.cwd, 'result.txt'))); assert.equal(await fs.readFile(path.join(repo.cwd, 'file.txt'), 'utf8'), 'parent draft\n');
});

test('durable implementation artifacts preserve non-UTF8 patch bytes and remain directly applicable', async t => {
  const repo = await repository(t), before = Buffer.from([99, 97, 102, 233, 10]), after = Buffer.from([99, 97, 102, 233, 32, 110, 101, 119, 10]);
  await fs.writeFile(path.join(repo.cwd, 'legacy.txt'), before); await git(repo.cwd, 'add', '--all'); await git(repo.cwd, 'commit', '-m', 'Legacy source');
  const f = fixture(repo.cwd, async input => { await fs.writeFile(path.join(input.cwd, 'legacy.txt'), after); return resultFor(input); });
  t.after(() => f.tool.closeAll());
  assert.equal((await f.tool.execute(await f.prepare(undefined, 'delegate_implement', randomUUID(), 'head'), f.context)).status, 'completed');
  const saved = (await readReceipts(repo.storeDirectory))[0], patch = await fs.readFile(saved.artifact!.patchPath);
  assert.ok(patch.includes(after.subarray(0, -1)), 'saved artifact retains literal legacy bytes');
  const baseline = await prepareAgentBaseline(repo.cwd, 'head'), target = await createAgentWorktree(baseline, repo.worktreeRoot, baseline.parentHead, randomUUID());
  await git(target.path, 'apply', '--', saved.artifact!.patchPath);
  assert.deepEqual(await fs.readFile(path.join(target.path, 'legacy.txt')), after);
});

test('raw artifact credential guards block publication without discarding the retained worktree', async t => {
  const repo = await repository(t), f = fixture(repo.cwd, async input => {
    await fs.writeFile(path.join(input.cwd, 'file.txt'), Buffer.concat([Buffer.from([233, 32]), Buffer.from('sk-protected-delegation-secret\n')]));
    return resultFor(input);
  });
  t.after(() => f.tool.closeAll());
  assert.equal((await f.tool.execute(await f.prepare(undefined, 'delegate_implement', randomUUID(), 'head'), f.context)).status, 'completed');
  const saved = (await readReceipts(repo.storeDirectory))[0];
  assert.equal(saved.status, 'unknown'); assert.equal(saved.error, 'workspace_evidence_unconfirmed'); assert.equal(saved.artifact, undefined);
  assert.ok(await fs.stat(saved.workspace!.path));
  await assert.rejects(fs.stat(path.join(path.dirname(saved.receiptPath), 'workspace.diff.patch')), { code: 'ENOENT' });
  assert.ok(!(await fs.readFile(saved.receiptPath, 'utf8')).includes('sk-protected-delegation-secret'));
});

test('lost child settlement and substituted receipts cause an unknown barrier, never inferred success', async t => {
  const repo = await repository(t);
  const f = fixture(repo.cwd, async input => input.title === 'lost' ? Promise.reject(new Error('transport gone')) : resultFor(input, { identity: { ...input.identity, runId: randomUUID() } }));
  t.after(() => f.tool.closeAll());
  const result = await f.tool.execute(await f.prepare([{ title: 'lost', goal: '审阅' }, { title: 'forged', goal: '审阅' }]), f.context);
  assert.equal(result.status, 'completed'); assert.ok((await readReceipts(repo.storeDirectory)).every(r => r.status === 'unknown'));
});

test('untracked content changes invalidate a prepared snapshot even if porcelain status stays identical', async t => {
  const repo = await repository(t); await fs.writeFile(path.join(repo.cwd, 'untracked.txt'), 'version 1');
  const baseline = await prepareAgentBaseline(repo.cwd, 'snapshot'); await fs.writeFile(path.join(repo.cwd, 'untracked.txt'), 'version 2');
  await assert.rejects(verifyAgentBaseline(baseline), /基线/);
});

test('new delegates obey configured concurrent capacity while settled children never exhaust lifetime capacity', async t => {
  const repo = await repository(t); let starts = 0;
  const f = fixture(repo.cwd, async input => { starts++; return resultFor(input); }); t.after(() => f.tool.closeAll());
  const invalid = [{ tasks: [] }, { tasks: [{ title: ' title ', goal: 'question' }] }, { tasks: [{ title: 'a', goal: 'sk-protected-delegation-secret' }] },
    { tasks: [{ title: 'a', goal: 'question', toolPolicy: 'workspace_write' }] }, { tasks: Array.from({ length: 5 }, () => ({ title: 'a', goal: 'question' })) }];
  for (const input of invalid) await assert.rejects(f.tool.prepare({ id: randomUUID(), name: 'delegate_review', arguments: JSON.stringify(input) }, f.context));
  const tasks = Array.from({ length: 4 }, () => ({ title: '审阅', goal: 'question' }));
  for (let i = 0; i < 4; i++) assert.equal((await f.tool.execute(await f.prepare(tasks), f.context)).status, 'completed');
  assert.equal((await f.tool.execute(await f.prepare(), f.context)).status, 'completed'); assert.equal(starts, 17);
});

test('worktree creation skips repository hooks and never removes pre-existing destinations', async t => {
  const repo = await repository(t);
  await fs.writeFile(path.join(repo.cwd, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  const baseline = await prepareAgentBaseline(repo.cwd, 'head'), commit = await materializeAgentBaseline(baseline, repo.worktreeRoot), id = randomUUID();
  const tree = await createAgentWorktree(baseline, repo.worktreeRoot, commit, id);
  await fs.writeFile(path.join(tree.cwd, 'keep.txt'), 'keep user work');
  await assert.rejects(createAgentWorktree(baseline, repo.worktreeRoot, commit, id));
  assert.equal(await fs.readFile(path.join(tree.cwd, 'keep.txt'), 'utf8'), 'keep user work');
  await assert.rejects(materializeAgentBaseline(baseline, path.join(repo.cwd, 'nested-worktrees')), { code: 'nested_worktree_root' });
});

test('credential-bearing child output is omitted from durable receipts and model output', async t => {
  const repo = await repository(t);
  const f = fixture(repo.cwd, async input => resultFor(input, { summary: 'sk-protected-delegation-secret' })); t.after(() => f.tool.closeAll());
  const result = await f.tool.execute(await f.prepare(), f.context); assert.equal(result.status, 'completed');
  assert.doesNotMatch(JSON.stringify(result), /sk-protected/);
  for (const receipt of await readReceipts(repo.storeDirectory)) assert.doesNotMatch(JSON.stringify(receipt), /sk-protected/);
});

test('capacity is reserved before asynchronous preparation so overlapping batches cannot multiply concurrency', async t => {
  const repo = await repository(t); let starts = 0, ready!: () => void, release!: () => void;
  const allStarted = new Promise<void>(resolve => { ready = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(repo.cwd, async input => { if (++starts === 3) ready(); await barrier; return resultFor(input); });
  t.after(() => f.tool.closeAll());
  const first = await f.prepare(Array.from({ length: 3 }, () => ({ title: 'first', goal: 'review' })));
  const second = await f.prepare(Array.from({ length: 2 }, () => ({ title: 'second', goal: 'review' })));
  const pending = f.tool.execute(first, f.context); await allStarted;
  assert.equal((await f.tool.execute(second, f.context)).status, 'not_executed'); assert.equal(starts, 3);
  release(); assert.equal((await pending).status, 'completed');
});

test('closeAll during durable intent preparation prevents child launch and settles cancellation', async t => {
  const repo = await repository(t); let starts = 0, intentReached!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { intentReached = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(repo.cwd, async input => { starts++; return resultFor(input); }, { record: async receipt => {
    if (receipt.status === 'prepared') { intentReached(); await barrier; }
  } });
  const pending = f.tool.execute(await f.prepare(), f.context); await reached;
  const closed = f.tool.closeAll(); release(); await closed;
  assert.equal((await pending).status, 'cancelled'); assert.equal(starts, 0);
  assert.equal((await readReceipts(repo.storeDirectory))[0].status, 'cancelled');
});

test('large summaries remain durable while bounded model output contains only receipt references', async t => {
  const repo = await repository(t);
  const f = fixture(repo.cwd, async input => resultFor(input, { summary: '详细审阅'.repeat(4000) })); t.after(() => f.tool.closeAll());
  f.context.maxOutputBytes = 2048;
  const result = await f.tool.execute(await f.prepare(Array.from({ length: 4 }, () => ({ title: '审阅', goal: 'review' }))), f.context);
  assert.equal(result.status, 'completed'); assert.equal(result.truncated, true); assert.ok(Buffer.byteLength(JSON.stringify(result.output)) <= 2048);
  assert.ok((await readReceipts(repo.storeDirectory)).every(r => r.result!.summary.length === 16000));
});

test('all output truncation levels retain the parent and child IDs needed to read saved results', async t => {
  const repo = await repository(t);
  const levels: string[] = [];
  for (const { maxOutputBytes, depth } of [{ maxOutputBytes: 64000, depth: 0 }, { maxOutputBytes: 2200, depth: 0 },
    { maxOutputBytes: 2048, depth: 3 }, { maxOutputBytes: 2048, depth: 10 }]) {
    const storeDirectory = path.join(repo.directory, 'records', ...Array.from({ length: depth }, (_, index) => `${index}-${'r'.repeat(180)}`));
    const f = fixture(repo.cwd, async input => resultFor(input, { summary: '详细成果'.repeat(1000) }), { storeDirectory });
    t.after(() => f.tool.closeAll()); f.context.maxOutputBytes = maxOutputBytes;
    const result = await f.tool.execute(await f.prepare(Array.from({ length: 4 }, () => ({ title: '审阅', goal: 'review' }))), f.context);
    assert.ok(result.output && typeof result.output === 'object' && !Array.isArray(result.output));
    assert.equal(result.output.parentRunId, f.identity.runId);
    assert.ok(Array.isArray(result.output.children)); assert.equal(result.output.children.length, 4);
    assert.ok(result.output.children.every(child => child && typeof child === 'object' && !Array.isArray(child) && typeof child.childId === 'string'));
    assert.match(JSON.stringify(result.output), /read_agent_result/);
    assert.ok(Buffer.byteLength(JSON.stringify(result.output)) <= maxOutputBytes);
    levels.push('integration' in result.output ? 'full' : 'limits' in result.output ? 'references' : 'receiptDirectory' in result.output ? 'batch' : 'identities');
  }
  assert.deepEqual(levels, ['full', 'references', 'batch', 'identities']);
});

test('durable intent failure never calls the child host and leaves an unknown recovery barrier', async t => {
  const repo = await repository(t); let starts = 0;
  const f = fixture(repo.cwd, async input => { starts++; return resultFor(input); }, { record: async () => { throw new Error('ledger unavailable'); } });
  t.after(() => f.tool.closeAll());
  const result = await f.tool.execute(await f.prepare(), f.context);
  assert.equal(result.status, 'unknown'); assert.equal(starts, 0);
});

test('parallel execution evidence must be durable before any child launches', async t => {
  const repo = await repository(t); let starts = 0;
  await fs.mkdir(repo.storeDirectory, { recursive: true });
  await fs.writeFile(path.join(repo.storeDirectory, 'delegation-executions'), 'blocked metadata path');
  const f = fixture(repo.cwd, async input => { starts++; return resultFor(input); });
  t.after(() => f.tool.closeAll());
  const result = await f.tool.execute(await f.prepare(), f.context);
  assert.equal(result.status, 'unknown'); assert.equal(starts, 0);
  const saved = await readReceipts(repo.storeDirectory);
  assert.equal(saved.length, 1); assert.equal(saved[0].status, 'prepared');
});

test('configured capacity supports thirty concurrently active independent children with bounded result references', async t => {
  const repo = await repository(t); let starts = 0, release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const budgets = new Set<NativeDelegationBudget>();
  const f = fixture(repo.cwd, async input => {
    budgets.add(input.budget); if (++starts === 30) release(); await barrier; return resultFor(input);
  }, { maxSubagents: 30 });
  t.after(() => f.tool.closeAll()); f.context.maxOutputBytes = 2048;
  assert.equal(((f.tool.definitions[0].inputSchema.properties as Record<string, { maxItems: number }>).tasks).maxItems, 30);
  await assert.rejects(f.prepare(Array.from({ length: 31 }, () => ({ title: 'Too many', goal: 'Review' }))));
  const result = await f.tool.execute(await f.prepare(Array.from({ length: 30 }, (_, index) => ({ title: `Review ${index}`, goal: 'Independent review' }))), f.context);
  assert.equal(result.status, 'completed'); assert.equal(starts, 30); assert.equal(budgets.size, 30);
  assert.ok(Buffer.byteLength(JSON.stringify(result.output)) <= 2048);
  assert.equal((result.output as { children: unknown[] }).children.length, 30);
  const saved = await readReceipts(repo.storeDirectory); assert.equal(saved.length, 30);
});

test('a failed sibling leaves the parent able to continue and recover only that child with a fresh identity and budget', async t => {
  const repo = await repository(t); const inputs: NativeAgentChildInput[] = [];
  const f = fixture(repo.cwd, async input => {
    inputs.push(input);
    return resultFor(input, inputs.length === 1 ? { status: 'budget_exhausted', reason: 'model_request_budget' } : {});
  });
  t.after(() => f.tool.closeAll());
  const delegated = await f.tool.execute(await f.prepare([{ title: 'Fails', goal: 'Independent question one' }, { title: 'Succeeds', goal: 'Independent question two' }]), f.context);
  assert.equal(delegated.status, 'completed');
  const failed = (await readReceipts(repo.storeDirectory)).find(receipt => receipt.status === 'failed')!;
  assert.ok(failed); assert.equal(inputs.length, 2);
  const recovered = await f.tool.prepare({ id: randomUUID(), name: 'recover_agent', arguments: JSON.stringify({ childId: failed.childId }) }, f.context);
  assert.equal((await f.tool.execute(recovered, f.context)).status, 'completed');
  const continuation = inputs[2]; assert.notEqual(continuation.identity.runId, inputs[0].identity.runId);
  assert.notEqual(continuation.taskId, inputs[0].taskId); assert.notEqual(continuation.budget, inputs[0].budget);
  assert.equal(continuation.cwd, inputs[0].cwd); assert.equal(continuation.recovery?.previousChildId, failed.childId);
  assert.equal(continuation.recovery?.previousRunId, failed.identity.runId);
  const records = await readReceipts(repo.storeDirectory), recoveredReceipt = records.find(receipt => receipt.recovery)!;
  assert.equal(recoveredReceipt.status, 'completed'); assert.equal(recoveredReceipt.recovery!.attempt, 1);
  assert.equal(records.find(receipt => receipt.childId === failed.childId)!.status, 'failed', 'old evidence is immutable');
  await assert.rejects(f.tool.prepare({ id: randomUUID(), name: 'recover_agent', arguments: JSON.stringify({ childId: failed.childId }) }, f.context));
  assert.equal((await f.tool.execute(await f.prepare(), f.context)).status, 'completed');
});

test('implementation recovery continues in the retained workspace without replaying earlier file effects', async t => {
  const repo = await repository(t); const inputs: NativeAgentChildInput[] = [];
  const f = fixture(repo.cwd, async input => {
    inputs.push(input);
    if (!input.recovery) {
      await fs.writeFile(path.join(input.cwd, 'effect.txt'), 'already executed once\n');
      return resultFor(input, { status: 'failed', reason: 'model_failed', summary: 'Saved effect.txt; remaining work is not complete.' });
    }
    assert.equal(await fs.readFile(path.join(input.cwd, 'effect.txt'), 'utf8'), 'already executed once\n');
    assert.match(input.recovery.summary, /Saved effect.txt/);
    await fs.writeFile(path.join(input.cwd, 'remaining.txt'), 'continued\n'); return resultFor(input);
  });
  t.after(() => f.tool.closeAll());
  assert.equal((await f.tool.execute(await f.prepare(undefined, 'delegate_implement', randomUUID(), 'head'), f.context)).status, 'completed');
  const failed = (await readReceipts(repo.storeDirectory))[0]; assert.equal(failed.status, 'failed');
  const prepared = await f.tool.prepare({ id: randomUUID(), name: 'recover_agent', arguments: JSON.stringify({ childId: failed.childId }) }, f.context);
  await f.tool.validate(prepared, f.context);
  assert.equal((await f.tool.execute(prepared, f.context)).status, 'completed');
  assert.equal(inputs.length, 2); assert.equal(inputs[1].cwd, inputs[0].cwd); assert.notEqual(inputs[1].budget, inputs[0].budget);
  const continuation = (await readReceipts(repo.storeDirectory)).find(receipt => receipt.recovery)!;
  assert.deepEqual(continuation.workspace, failed.workspace); assert.equal(continuation.recovery!.workspaceOwnerChildId, failed.childId);
  assert.equal(continuation.status, 'completed'); assert.match(await fs.readFile(continuation.artifact!.patchPath, 'utf8'), /remaining.txt/);
  await assert.rejects(fs.stat(path.join(repo.cwd, 'effect.txt')));
});

test('unknown child effects block its recovery without preventing unrelated parent work', async t => {
  const repo = await repository(t); let starts = 0;
  const f = fixture(repo.cwd, async input => resultFor(input, ++starts === 1 ? { status: 'recovery_required', reason: 'unknown_command_cleanup' } : {}));
  t.after(() => f.tool.closeAll());
  assert.equal((await f.tool.execute(await f.prepare(), f.context)).status, 'completed');
  const failed = (await readReceipts(repo.storeDirectory))[0]; assert.equal(failed.status, 'unknown');
  await assert.rejects(f.tool.prepare({ id: randomUUID(), name: 'recover_agent', arguments: JSON.stringify({ childId: failed.childId }) }, f.context));
  assert.equal((await f.tool.execute(await f.prepare(), f.context)).status, 'completed'); assert.equal(starts, 2);
});

test('recovery approval cannot be reused after retained workspace contents change', async t => {
  const repo = await repository(t); let starts = 0;
  const f = fixture(repo.cwd, async input => { starts++; return resultFor(input, { status: 'failed', reason: 'model_failed' }); });
  t.after(() => f.tool.closeAll());
  await f.tool.execute(await f.prepare(undefined, 'delegate_implement', randomUUID(), 'head'), f.context);
  const failed = (await readReceipts(repo.storeDirectory))[0];
  const prepared = await f.tool.prepare({ id: randomUUID(), name: 'recover_agent', arguments: JSON.stringify({ childId: failed.childId }) }, f.context);
  await fs.writeFile(path.join(failed.cwd, 'changed-after-prepare.txt'), 'external change\n');
  await assert.rejects(f.tool.validate(prepared, f.context), /工作区/);
  assert.equal((await f.tool.execute(prepared, f.context)).status, 'not_executed'); assert.equal(starts, 1);
});

test('one settled child releases its configured slot while another sibling is still executing', async t => {
  const repo = await repository(t); let quickSaved!: () => void, release!: () => void, starts = 0;
  const settledQuick = new Promise<void>(resolve => { quickSaved = resolve; }), slow = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(repo.cwd, async input => { starts++; if (input.title === 'Slow') await slow; return resultFor(input); }, {
    maxSubagents: 2, record: async receipt => { if (receipt.title === 'Quick' && receipt.status === 'completed') quickSaved(); },
  });
  t.after(async () => { release(); await f.tool.closeAll(); });
  const pending = f.tool.execute(await f.prepare([{ title: 'Quick', goal: 'One short question' }, { title: 'Slow', goal: 'One longer question' }]), f.context);
  await settledQuick; await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.tool.execute(await f.prepare([{ title: 'Replacement', goal: 'Independent follow-up' }]), f.context)).status, 'completed');
  assert.equal(starts, 3); release(); assert.equal((await pending).status, 'completed');
});

test('read-only parents expose read-risk recovery and can recover only their own review children', async t => {
  const repo = await repository(t); let starts = 0;
  const f = fixture(repo.cwd, async input => resultFor(input, ++starts === 1 ? { status: 'failed', reason: 'model_failed' } : {}), { policy: 'read_only' });
  t.after(() => f.tool.closeAll()); assert.equal(f.tool.definitions.find(definition => definition.name === 'recover_agent')!.risk, 'read');
  await f.tool.execute(await f.prepare(), f.context); const failed = (await readReceipts(repo.storeDirectory))[0];
  const prepared = await f.tool.prepare({ id: randomUUID(), name: 'recover_agent', arguments: JSON.stringify({ childId: failed.childId }) }, f.context);
  assert.equal(prepared.requiresApproval, false); assert.equal((await f.tool.execute(prepared, f.context)).status, 'completed'); assert.equal(starts, 2);
});
