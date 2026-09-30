import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { NATIVE_TASK_LIMITS, NativeTaskError, type PreparedTool, type ToolExecutionContext } from '@cc-desk/agent-core';
import { NativeTaskStore, type NativeTaskStoreFaultPoint } from '@cc-desk/agent-node/task-store';
import { assertNoModelCredential } from '@cc-desk/agent-node/responses-model';
import { ProjectFiles } from '@cc-desk/agent-node/tools';
import { createCodeLocationTool } from '../src/main/engines/native/code-location-tool';
import { extractCodeLines } from '../src/main/engines/native/code-location';
import { NativeTaskSession } from '../src/main/engines/native/task-session';
import { createNativeTaskTool } from '../src/main/engines/native/task-tool';

const secret = 'sk-location-protected-value';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function fixture(options: { content?: string; nested?: boolean; incomplete?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-location-tool-')), project = path.join(directory, 'project'), data = path.join(directory, 'data');
  await fs.mkdir(project); await fs.mkdir(data);
  const content = options.content ?? 'first\r\nsecond\n第三行\n', relative = options.nested ? 'src/code.ts' : 'code.ts';
  if (options.nested) { await fs.mkdir(path.join(project, 'src')); await fs.writeFile(path.join(project, 'src', 'CLAUDE.md'), 'Nested Claude rules'); await fs.writeFile(path.join(project, 'src', 'AGENTS.md'), 'Nested agent rules take precedence'); }
  await fs.writeFile(path.join(project, relative), content);
  if (options.incomplete) await fs.writeFile(path.join(project, 'large.bin'), Buffer.alloc(4 * 1024 * 1024 + 1));
  const identity = { sessionId: 'session', conversationId: randomUUID(), runId: randomUUID(), requestId: 'request', workerGeneration: 1 }, taskId = randomUUID();
  let fault: ((point: NativeTaskStoreFaultPoint) => void | Promise<void>) | undefined, rejectOwnership = false;
  const store = await NativeTaskStore.open({ rootDirectory: data, conversationId: identity.conversationId, sessionId: identity.sessionId,
    forbiddenValues: [secret], fault: point => fault?.(point) });
  const changes: number[] = [], abort = new AbortController();
  const session = new NativeTaskSession(store, { projectRoot: project, excludedRoots: [data], changed: snapshot => { changes.push(snapshot.revision); },
    assertSafe: value => assertNoModelCredential(value, secret) });
  const task = await store.apply({ identity, taskId, expectedRevision: 0, mutationId: 'create-plan', mutation: { type: 'plan', plan: {
    goal: 'Capture bounded file evidence', steps: [{ id: 'step', title: 'Implement feature', dependsOn: [], status: 'in_progress' }],
    criteria: [{ id: 'criterion', description: 'Human review checks the real behavior', stepIds: ['step'], kind: 'manual' }],
  } } });
  await session.planCommitted(task);
  const guard = async () => { if (rejectOwnership) throw new Error('ownership changed'); };
  const tool = createCodeLocationTool({ identity, taskId, session, projectRoot: project, excludedRoots: [data], forbiddenValues: [secret], assertOwnership: guard });
  const context: ToolExecutionContext = { identity, policyRevision: 'policy-1', signal: abort.signal, maxOutputBytes: 64 * 1024 };
  const input = () => ({ expectedRevision: store.read(taskId)!.revision, path: relative, expectedHash: hash(content), startLine: 1, endLine: 2, stepIds: ['step'], criterionIds: ['criterion'] });
  return { directory, project, data, relative, content, identity, taskId, store, session, tool, context, abort, changes, input,
    get task() { return store.read(taskId)!; },
    setFault(callback: typeof fault) { fault = callback; }, rejectOwnership() { rejectOwnership = true; },
    prepare(value: unknown = input(), id = 'location-1') { return tool.prepare({ id, name: 'record_code_location', arguments: JSON.stringify(value) }, context); },
    async execute(value: unknown = input(), id = 'location-1') { const prepared = await this.prepare(value, id); await tool.validate(prepared, context); return tool.execute(prepared, context); },
    async dispose() { await store.close(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

test('line extraction preserves CRLF and exact UTF-8 bounds without phantom or truncated lines', () => {
  assert.equal(extractCodeLines('a\r\nb\nc', 1, 2), 'a\r\nb\n');
  assert.equal(extractCodeLines('\n', 1, 1), '\n');
  assert.equal(extractCodeLines('a\n', 1, 1), 'a\n');
  assert.equal(extractCodeLines('a\r', 1, 1), 'a\r');
  assert.throws(() => extractCodeLines('', 1, 1)); assert.throws(() => extractCodeLines('a\n', 2, 2));
  assert.throws(() => extractCodeLines('a\n'.repeat(81), 1, 81));
  assert.equal(extractCodeLines('字'.repeat(2730) + 'ab', 1, 1), '字'.repeat(2730) + 'ab');
  assert.throws(() => extractCodeLines('字'.repeat(2731), 1, 1));
  for (const [start, end] of [[0, 1], [1, 0], [-1, 1], [1.5, 2], [1, Infinity]]) assert.throws(() => extractCodeLines('a\nb', start, end));
});

test('host reads and durably stores an unverified location; read_task returns metadata without the excerpt', async () => {
  const f = await fixture({ nested: true });
  try {
    const revision = f.task.revision, prepared = await f.prepare();
    assert.equal(prepared.definition.risk, 'read'); assert.equal(prepared.requiresApproval, false);
    const result = await f.tool.execute(prepared, f.context);
    assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(f.task.revision, revision + 1);
    const evidence = f.task.evidence[0]; assert.equal(evidence.source, 'location'); assert.equal(evidence.status, 'unverified');
    assert.equal(f.task.verification, 'unverified'); assert.equal(f.task.steps[0].status, 'in_progress');
    assert.deepEqual(evidence.location, { path: f.relative, startLine: 1, endLine: 2, fileHash: hash(f.content), fileBytes: Buffer.byteLength(f.content),
      excerpt: 'first\r\nsecond\n', excerptHash: hash('first\r\nsecond\n') });
    assert.match(JSON.stringify(result.output), /Nested Claude rules/); assert.match(JSON.stringify(result.output), /Nested agent rules/);
    const persisted = await NativeTaskStore.readSnapshot({ rootDirectory: f.data, conversationId: f.identity.conversationId, sessionId: f.identity.sessionId });
    assert.deepEqual(persisted, f.task);
    const taskTool = createNativeTaskTool({ identity: f.identity, taskId: f.taskId, forbiddenValues: [secret], store: f.store, assertOwnership: async () => {} });
    const read = await taskTool.prepare({ id: 'read', name: 'read_task', arguments: '{}' }, f.context), index = await taskTool.execute(read, f.context);
    assert.match(JSON.stringify(index), /excerptHash/); assert.equal(JSON.stringify(index).includes('first\\r\\nsecond'), false);
    assert.equal((index.output as any).task.evidence[0].location.fileHash, hash(f.content));
  } finally { await f.dispose(); }
});

test('a known file from an incomplete workspace can be recorded without claiming complete coverage', async () => {
  const f = await fixture({ incomplete: true });
  try { assert.equal(f.task.workspace?.current.complete, false); assert.equal((await f.execute()).status, 'completed'); assert.equal(f.task.evidence[0].workspaceComplete, false); }
  finally { await f.dispose(); }
});

test('strict location input rejects fabricated evidence, unsafe paths, broken associations and stale revisions', async () => {
  const f = await fixture();
  try {
    const base = f.input(), cases = [
      { ...base, expectedRevision: 0 }, { ...base, taskId: randomUUID() }, { ...base, snippet: 'made up' }, { ...base, status: 'passed' },
      { ...base, path: '../code.ts' }, { ...base, path: '/code.ts' }, { ...base, path: '.git/config' }, { ...base, path: '.env' }, { ...base, path: secret },
      { ...base, expectedHash: 'short' }, { ...base, startLine: 0 }, { ...base, endLine: 81 }, { ...base, endLine: 0 },
      { ...base, stepIds: [] }, { ...base, stepIds: ['missing'] }, { ...base, stepIds: ['step', 'step'] }, { ...base, criterionIds: ['missing'] },
      { ...base, criterionIds: ['criterion', 'criterion'] }, { ...base, expectedRevision: base.expectedRevision - 1 },
    ];
    for (let index = 0; index < cases.length; index++) await assert.rejects(f.prepare(cases[index], `bad-${index}`));
    assert.equal(f.task.evidence.length, 0);
    assert.equal((await f.execute({ ...base, expectedHash: 'a'.repeat(64) }, 'hash-mismatch')).status, 'not_executed');
    assert.equal((await f.execute({ ...base, endLine: 4 }, 'missing-line')).status, 'not_executed');
    assert.equal(f.task.evidence.length, 0);
  } finally { await f.dispose(); }
});

test('binary, oversized, credential-containing and excluded files cannot become location evidence', async () => {
  for (const content of ['zero\0byte', 'a'.repeat(1024 * 1024 + 1), `${secret}\nsecond`, '字'.repeat(2731) + '\nsecond']) {
    const f = await fixture({ content });
    try { assert.equal((await f.execute()).status, 'not_executed'); assert.equal(f.task.evidence.length, 0); }
    finally { await f.dispose(); }
  }
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.project, 'node_modules')); await fs.writeFile(path.join(f.project, 'node_modules', 'code.ts'), 'a\nb');
    const result = await f.execute({ ...f.input(), path: 'node_modules/code.ts', expectedHash: hash('a\nb') });
    assert.equal(result.status, 'not_executed'); assert.equal(f.task.evidence.length, 0);
  } finally { await f.dispose(); }
});

test('concurrent exact calls are idempotent and forged binding or changed scopes never write', async () => {
  const f = await fixture({ nested: true });
  try {
    const input = f.input(), prepared = await f.prepare(input);
    assert.deepEqual(await f.prepare(input), prepared);
    await assert.rejects(f.prepare({ ...input, endLine: 1 }));
    for (const forged of [{ ...prepared, inputDigest: 'forged' }, { ...prepared, input: { ...prepared.input, startLine: 2 } },
      { ...prepared, requiresApproval: true }] as PreparedTool[]) assert.equal((await f.tool.execute(forged, f.context)).status, 'not_executed');
    const [a, b] = await Promise.all([f.tool.execute(prepared, f.context), f.tool.execute(prepared, f.context)]);
    assert.equal(a.status, 'completed'); assert.deepEqual(a, b); assert.equal(f.task.evidence.length, 1);
    assert.deepEqual(await f.tool.execute(prepared, f.context), a);
    const next = await f.prepare(f.input(), 'next');
    await fs.writeFile(path.join(f.project, 'src', 'CLAUDE.md'), 'Changed scope rules');
    await assert.rejects(f.tool.validate(next, f.context)); assert.equal((await f.tool.execute(next, f.context)).status, 'not_executed');
    assert.equal(f.task.evidence.length, 1);
  } finally { await f.dispose(); }
});

test('external edits refresh workspace through their own revision and allow an explicit retry', async () => {
  const f = await fixture();
  try {
    const revision = f.task.revision, prepared = await f.prepare();
    await fs.writeFile(path.join(f.project, 'other.ts'), 'external content');
    const changed = await f.tool.execute(prepared, f.context);
    assert.equal(changed.status, 'not_executed'); assert.equal((changed.output as any).error, 'task_revision_changed');
    assert.equal((changed.output as any).currentRevision, revision + 1); assert.equal(f.task.evidence.length, 0);
    assert.equal((await f.execute(f.input(), 'after-refresh')).status, 'completed'); assert.equal(f.task.evidence.length, 1);
  } finally { await f.dispose(); }
});

test('a file changed at final pre-rename guard saves only a refreshed workspace, and retry needs its new hash', async () => {
  const f = await fixture();
  try {
    let injected = false;
    f.setFault(async point => { if (point === 'before_rename' && !injected) { injected = true; await fs.writeFile(path.join(f.project, f.relative), 'changed\nsecond\n'); } });
    const result = await f.execute(); assert.equal(result.status, 'not_executed'); assert.equal((result.output as any).error, 'task_revision_changed');
    assert.equal(f.task.evidence.length, 0);
    assert.equal((await f.execute({ ...f.input(), expectedHash: hash('changed\nsecond\n') }, 'retry')).status, 'completed');
    assert.equal(f.task.evidence[0].location?.excerpt, 'changed\nsecond\n');
  } finally { await f.dispose(); }
});

test('late ownership or cancellation prevents durable publication and unknown commit stops replay', async () => {
  for (const failure of ['ownership', 'cancel', 'after_rename'] as const) {
    const f = await fixture();
    try {
      const prepared = await f.prepare(); let injected = false;
      f.setFault(point => { if (injected) return;
        if (failure === 'after_rename' && point === 'after_rename') { injected = true; throw new Error(secret); }
        if (failure !== 'after_rename' && point === 'before_rename') { injected = true; if (failure === 'ownership') f.rejectOwnership(); else f.abort.abort(); }
      });
      const result = await f.tool.execute(prepared, f.context); assert.equal(result.status, 'unknown'); assert.equal(JSON.stringify(result).includes(secret), false);
      const durable = await NativeTaskStore.readSnapshot({ rootDirectory: f.data, conversationId: f.identity.conversationId, sessionId: f.identity.sessionId });
      assert.equal(durable!.evidence.length, failure === 'after_rename' ? 1 : 0);
      if (failure === 'after_rename') assert.deepEqual(await f.tool.execute(prepared, f.context), result);
    } finally { await f.dispose(); }
  }
});

test('cancellation after the final file read returns still prevents task publication', async () => {
  const f = await fixture(), original = ProjectFiles.prototype.read;
  try {
    let targetReads = 0;
    ProjectFiles.prototype.read = async function (relative, signal, maximum) {
      const value = await original.call(this, relative, signal, maximum);
      if (relative === f.relative && ++targetReads === 2) f.abort.abort();
      return value;
    };
    const result = await f.execute(); assert.equal(targetReads, 2); assert.equal(result.status, 'unknown');
    const durable = await NativeTaskStore.readSnapshot({ rootDirectory: f.data, conversationId: f.identity.conversationId, sessionId: f.identity.sessionId });
    assert.equal(durable!.evidence.length, 0);
  } finally { ProjectFiles.prototype.read = original; await f.dispose(); }
});

test('overlapping preparation keeps the first exact binding and enforces the cache cap after scope awaits', async () => {
  const f = await fixture();
  try {
    const input = f.input(), raced = await Promise.allSettled([f.prepare(input), f.prepare({ ...input, endLine: 1 })]);
    assert.equal(raced.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(raced.filter(item => item.status === 'rejected').length, 1);
    for (let index = 1; index < 199; index++) await f.prepare(input, `prepared-${index}`);
    const capacityRace = await Promise.allSettled([f.prepare(input, 'cap-a'), f.prepare(input, 'cap-b')]);
    assert.equal(capacityRace.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(capacityRace.filter(item => item.status === 'rejected').length, 1);
  } finally { await f.dispose(); }
});

// Windows rejects quotes in filenames. Run the portable UTF-8 byte-budget case
// everywhere, plus JSON-escaped paths on filesystems that support them.
for (const namePart of process.platform === 'win32' ? ['界文'] : ['界文', '界"'])
test(`output budget includes Unicode paths and scoped instructions before persistence (${JSON.stringify(namePart)})`, async () => {
  const f = await fixture();
  try {
    const relative = `${namePart.repeat(40)}.ts`;
    await fs.writeFile(path.join(f.project, relative), f.content);
    const call = { id: 'quoted', name: 'record_code_location', arguments: JSON.stringify({ ...f.input(), path: relative }) };
    const small = { ...f.context, maxOutputBytes: 2048 };
    const prepared = await f.tool.prepare(call, small);
    const first = await f.tool.execute(prepared, small); assert.equal((first.output as any).error, 'task_revision_changed');
    const retry = await f.tool.prepare({ ...call, id: 'quoted-retry', arguments: JSON.stringify({ ...f.input(), path: relative }) }, small);
    const result = await f.tool.execute(retry, small); assert.equal(result.status, 'completed'); assert.ok(Buffer.byteLength(JSON.stringify(result.output)) <= small.maxOutputBytes);
    const revision = f.task.revision; await fs.writeFile(path.join(f.project, 'AGENTS.md'), 'Long scoped rules '.repeat(200));
    await assert.rejects(f.tool.prepare({ ...call, id: 'budget-rejected', arguments: JSON.stringify({ ...f.input(), path: relative }) }, small), /预算/);
    assert.equal(f.task.revision, revision); assert.equal(f.task.evidence.length, 1);
  } finally { await f.dispose(); }
});

test('known task evidence and pre-write store capacity exhaustion returns a definite failure', async () => {
  const f = await fixture();
  try {
    const original = f.store.apply.bind(f.store);
    f.store.apply = async () => { throw new NativeTaskError('limit_exceeded', 'Task snapshot capacity reached'); };
    assert.deepEqual(await f.execute(), { status: 'failed', output: { error: 'task_capacity_exceeded' } });
    f.store.apply = original;
    for (let index = 0; index < NATIVE_TASK_LIMITS.evidence; index++) {
      const task = f.task;
      await f.store.apply({ taskId: f.taskId, identity: f.identity, expectedRevision: task.revision, mutationId: `fill-${index}`, mutation: { type: 'evidence', evidence: {
        id: `command-${index}`, identity: f.identity, source: 'command', status: 'unverified', stepIds: ['step'], criterionIds: [],
        planRevision: task.planRevision, acceptanceRevision: task.acceptanceRevision, workspaceFingerprint: task.workspace!.current.fingerprint,
        workspaceComplete: true, toolCallId: `command-${index}`, createdAt: new Date().toISOString(),
        command: { executable: 'node', argv: ['--version'], cwd: '.' }, exitCode: null,
      } } });
    }
    const revision = f.task.revision;
    assert.deepEqual(await f.execute(f.input(), 'full'), { status: 'failed', output: { error: 'task_capacity_exceeded' } });
    assert.equal(f.task.revision, revision); assert.equal(f.task.evidence.length, NATIVE_TASK_LIMITS.evidence);
  } finally { await f.dispose(); }
});
