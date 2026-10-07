import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { build } from 'esbuild';
import { runAgent, type ToolExecutionContext } from '@cc-desk/agent-core';
import { ResponsesModel } from '@cc-desk/agent-node/responses-model';
import { StateStore } from '../src/main/store';
import { SessionService } from '../src/main/session-service';
import { ExecutionRegistry } from '../src/main/execution/registry';
import { ExecutionEvents } from '../src/main/execution/events';
import type { TerminalExecutor } from '../src/main/execution/ports';
import type { ExecutionCapabilities } from '../src/shared/execution';
import type { Session } from '../src/shared/types';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { createNativeConfig } from '../src/main/engines/native/config';
import { runNativeWorker, type NativeWorkerChild, type NativeWorkerFork } from '../src/main/engines/native/worker-host';
import { createAgentDelegationTools, type NativeAgentChildInput, type NativeAgentChildResult, type NativeDelegationReceipt } from '../src/main/engines/native/agent-delegation';
import { collectAgentWorkspaceEvidence, createAgentWorktree, materializeAgentBaseline, prepareAgentBaseline } from '../src/main/engines/native/agent-worktrees';
// @ts-expect-error Shared loopback Responses fixture has no declarations.
import { startResponsesFixture, functionCall, assistantMessage } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

const execute = promisify(execFile);
async function git(cwd: string, ...args: string[]) { return (await execute('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })).stdout; }
async function repository(t: { after(fn: () => Promise<void>): void }) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cc-native-agent-audit-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, 'repo'); await fs.mkdir(path.join(cwd, 'nested'), { recursive: true });
  await git(cwd, 'init', '-b', 'main');
  await git(cwd, 'config', 'user.name', 'Audit'); await git(cwd, 'config', 'user.email', 'audit@localhost');
  await git(cwd, 'config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(cwd, 'nested', 'source.txt'), 'original\n');
  await fs.writeFile(path.join(cwd, 'delete.txt'), 'delete this\n');
  await fs.writeFile(path.join(cwd, '.gitignore'), 'ignored.dat\n');
  await git(cwd, 'add', '--all'); await git(cwd, 'commit', '-m', 'Initial');
  return { directory, cwd, worktreeRoot: path.join(directory, 'worktrees'), storeDirectory: path.join(directory, 'records') };
}
function delegation(cwd: string, runChild: (input: NativeAgentChildInput) => Promise<NativeAgentChildResult>) {
  const abort = new AbortController(), identity = { sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 };
  const tools = createAgentDelegationTools({ identity, parentTaskId: randomUUID(), cwd, policy: 'workspace_write', signal: abort.signal,
    forbiddenValues: [], storeDirectory: path.join(cwd, '..', 'records'), worktreeRoot: path.join(cwd, '..', 'worktrees'),
    budget: { consume: async () => true, remainingMs: () => 60000, snapshot: () => ({ modelRequests: 0, toolCalls: 0 }) },
    assertOwnership: async () => {}, runChild });
  const context: ToolExecutionContext = { identity, policyRevision: 'audit-policy', signal: abort.signal, maxOutputBytes: 65536 };
  return { tools, context, prepare: () => tools.prepare({ id: randomUUID(), name: 'delegate_review', arguments: JSON.stringify({ tasks: [{ title: 'Audit', goal: 'Inspect cancellation and durable evidence' }] }) }, context) };
}
async function receipts(directory: string): Promise<NativeDelegationReceipt[]> {
  const result: NativeDelegationReceipt[] = [];
  const walk = async (target: string) => { for (const entry of await fs.readdir(target, { withFileTypes: true })) {
    const file = path.join(target, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (entry.name === 'receipt.json') result.push(JSON.parse(await fs.readFile(file, 'utf8')));
  } };
  await walk(path.join(directory, 'delegations')); return result;
}

test('snapshot preserves parent HEAD/index and retains staged, unstaged, deleted, Unicode and binary workspace changes', async t => {
  const f = await repository(t), source = path.join(f.cwd, 'nested', 'source.txt');
  await fs.writeFile(source, 'staged\n'); await git(f.cwd, 'add', 'nested/source.txt'); await fs.writeFile(source, 'working\n');
  await fs.rm(path.join(f.cwd, 'delete.txt')); const binary = Buffer.from([0, 255, 128, 13, 10, 42]);
  await fs.writeFile(path.join(f.cwd, '新增 空格.bin'), binary);
  const head = await git(f.cwd, 'rev-parse', 'HEAD'), index = await fs.readFile(path.join(f.cwd, '.git', 'index'));
  const baseline = await prepareAgentBaseline(path.join(f.cwd, 'nested'), 'snapshot');
  const baseCommit = await materializeAgentBaseline(baseline, f.worktreeRoot);
  const child = await createAgentWorktree(baseline, f.worktreeRoot, baseCommit, randomUUID());
  assert.equal(child.cwd, path.join(child.path, 'nested'));
  assert.equal(await fs.readFile(path.join(child.cwd, 'source.txt'), 'utf8'), 'working\n');
  assert.deepEqual(await fs.readFile(path.join(child.path, '新增 空格.bin')), binary);
  await assert.rejects(fs.stat(path.join(child.path, 'delete.txt')), { code: 'ENOENT' });
  assert.equal(await git(f.cwd, 'rev-parse', 'HEAD'), head); assert.deepEqual(await fs.readFile(path.join(f.cwd, '.git', 'index')), index);
  await fs.writeFile(path.join(child.path, 'child 新文件.bin'), Buffer.from([0, 23, 255, 128]));
  await git(child.path, 'add', '--all'); await git(child.path, 'commit', '-m', 'Child committed work');
  await fs.writeFile(path.join(child.cwd, 'source.txt'), 'uncommitted child work\n');
  const childIndexFile = path.resolve(child.path, (await git(child.path, 'rev-parse', '--git-path', 'index')).trim());
  const childIndex = await fs.readFile(childIndexFile), evidence = await collectAgentWorkspaceEvidence(child, f.worktreeRoot);
  assert.ok(evidence.changedFiles.some(entry => entry.path === 'child 新文件.bin' && entry.status === 'A'));
  assert.ok(evidence.changedFiles.some(entry => entry.path === 'nested/source.txt' && entry.status === 'M'));
  assert.match(evidence.patch.toString('utf8'), /GIT binary patch/); assert.deepEqual(await fs.readFile(childIndexFile), childIndex);
  assert.equal(await git(f.cwd, 'rev-parse', 'HEAD'), head); assert.deepEqual(await fs.readFile(path.join(f.cwd, '.git', 'index')), index);
});

test('snapshot includes newly tracked files deliberately staged through gitignore and preserves the real parent index', async t => {
  const f = await repository(t), bytes = Buffer.from('explicitly tracked despite ignore\n');
  await fs.writeFile(path.join(f.cwd, 'ignored.dat'), bytes); await git(f.cwd, 'add', '-f', 'ignored.dat');
  const index = await fs.readFile(path.join(f.cwd, '.git', 'index'));
  const baseline = await prepareAgentBaseline(f.cwd, 'snapshot'), commit = await materializeAgentBaseline(baseline, f.worktreeRoot);
  const child = await createAgentWorktree(baseline, f.worktreeRoot, commit, randomUUID());
  assert.deepEqual(await fs.readFile(path.join(child.path, 'ignored.dat')), bytes);
  assert.deepEqual(await fs.readFile(path.join(f.cwd, '.git', 'index')), index);
});

test('retained child evidence includes newly staged ignored files without changing the child index', async t => {
  const f = await repository(t), baseline = await prepareAgentBaseline(f.cwd, 'head');
  const child = await createAgentWorktree(baseline, f.worktreeRoot, await materializeAgentBaseline(baseline, f.worktreeRoot), randomUUID());
  await fs.writeFile(path.join(child.path, 'ignored.dat'), 'child deliberately tracked file\n'); await git(child.path, 'add', '-f', 'ignored.dat');
  const evidence = await collectAgentWorkspaceEvidence(child, f.worktreeRoot);
  assert.ok(evidence.changedFiles.some(entry => entry.path === 'ignored.dat' && entry.status === 'A'), 'tracked new files must not silently disappear from retained patches');
  assert.match(evidence.patch.toString('utf8'), /child deliberately tracked file/);
});

test('snapshot honors a staged removal from tracking when the remaining working file is ignored', async t => {
  const f = await repository(t);
  await fs.writeFile(path.join(f.cwd, 'ignored.dat'), 'previously tracked\n'); await git(f.cwd, 'add', '-f', 'ignored.dat'); await git(f.cwd, 'commit', '-m', 'Track generated artifact explicitly');
  await git(f.cwd, 'rm', '--cached', 'ignored.dat'); const index = await fs.readFile(path.join(f.cwd, '.git', 'index'));
  const baseline = await prepareAgentBaseline(f.cwd, 'snapshot'), commit = await materializeAgentBaseline(baseline, f.worktreeRoot);
  const child = await createAgentWorktree(baseline, f.worktreeRoot, commit, randomUUID());
  await assert.rejects(fs.stat(path.join(child.path, 'ignored.dat')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.cwd, 'ignored.dat'), 'utf8'), 'previously tracked\n');
  assert.deepEqual(await fs.readFile(path.join(f.cwd, '.git', 'index')), index);
});

test('retained patch round-trips a non-UTF8 text file without corrupting its literal bytes', async t => {
  const f = await repository(t), name = 'legacy.txt', before = Buffer.from([99, 97, 102, 233, 10]), after = Buffer.from([99, 97, 102, 233, 32, 97, 117, 100, 105, 116, 10]);
  await fs.writeFile(path.join(f.cwd, name), before); await git(f.cwd, 'add', name); await git(f.cwd, 'commit', '-m', 'Legacy encoding source');
  const baseline = await prepareAgentBaseline(f.cwd, 'head'), commit = await materializeAgentBaseline(baseline, f.worktreeRoot);
  const child = await createAgentWorktree(baseline, f.worktreeRoot, commit, randomUUID()); await fs.writeFile(path.join(child.path, name), after);
  const evidence = await collectAgentWorkspaceEvidence(child, f.worktreeRoot), patchFile = path.join(f.directory, 'retained.patch');
  await fs.writeFile(patchFile, evidence.patch);
  const target = await createAgentWorktree(baseline, f.worktreeRoot, commit, randomUUID());
  await git(target.path, 'apply', '--', patchFile);
  assert.deepEqual(await fs.readFile(path.join(target.path, name)), after, 'the retained patch must reconstruct the exact original output bytes');
});

test('closeAll aborts children and waits for settled cleanup rather than equating the abort signal with cancellation', async t => {
  const f = await repository(t); let ready!: () => void, release!: () => void, sawAbort = false;
  const started = new Promise<void>(resolve => { ready = resolve; }), settlement = new Promise<void>(resolve => { release = resolve; });
  const d = delegation(f.cwd, async input => { input.signal.addEventListener('abort', () => { sawAbort = true; }); ready(); await settlement; throw new Error('cleanup or terminal receipt remains unconfirmed'); });
  try {
    const pending = d.tools.execute(await d.prepare(), d.context); await started;
    let closed = false; const closing = d.tools.closeAll().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(sawAbort, true); assert.equal(closed, false);
    release(); assert.equal((await pending).status, 'unknown'); await closing;
    const saved = await receipts(f.storeDirectory); assert.equal(saved[0].status, 'unknown'); assert.equal(saved[0].error, 'child_run_unconfirmed');
  } finally { release?.(); await d.tools.closeAll(); }
});

class AuditTerminal implements TerminalExecutor {
  active = new Set<string>();
  get activeCount() { return this.active.size; }
  has(id: string) { return this.active.has(id); }
  isBusy(id: string) { return this.has(id); }
  async start(id: string) { this.active.add(id); }
  write(_id: string, _text: string) {}
  resize(_id: string, _cols: number, _rows: number) {}
  snapshot(_id: string) { return { chunks: [], status: 'running' as const }; }
  async exports(_id: string) { return []; }
  interrupt(id: string) { this.active.delete(id); }
  stop(id: string) { this.active.delete(id); }
  async stopIdle(id: string) { this.stop(id); }
  async whenReleased(id: string) { if (this.has(id)) throw new Error('Terminal remains active'); }
  forget(id: string) { this.stop(id); }
  setMaintenance(_value: boolean) {}
  async disconnectAll() { this.active.clear(); }
  async shutdown() { this.active.clear(); }
}
const capabilities: ExecutionCapabilities = { available: true, structured: true, terminal: true, approvals: true, resume: true, fork: true,
  commands: true, contextUsage: false, liveConfig: false, attachments: false };
/** Inject only loss of a terminal tool response after a real approved file write. */
const unknownChildWorker: NonNullable<NativeExecutorOptions['worker']> = options => {
  const child = Boolean(options.request.configuration?.delegated), original = options.tools;
  const tools = child ? { ...original, execute: async (...args: Parameters<typeof original.execute>) => {
    const result = await original.execute(...args);
    return args[0].call.name === 'apply_patch' && result.status === 'completed' ? { status: 'unknown' as const, output: { code: 'injected_lost_terminal_response' } } : result;
  } } : original;
  return runAgent({ ...options.request, signal: options.signal }, { model: new ResponsesModel(options.model), tools, store: options.store, approvals: options.approvals,
    host: { now: Date.now, digest: value => createHash('sha256').update(value).digest('hex'), emit: options.onEvent, consumeBudget: options.consumeBudget,
      deadline: (ms, parent) => { const abort = new AbortController(), cancel = () => abort.abort(), timer = setTimeout(cancel, ms);
        parent.addEventListener('abort', cancel, { once: true }); if (parent.aborted) cancel();
        return { signal: abort.signal, dispose: () => { clearTimeout(timer); parent.removeEventListener('abort', cancel); } }; },
    } });
};

test('actual Native unknown child worktree remains quarantined across restart and cross-provider admission until explicit parent confirmation', async t => {
  const f = await repository(t), dataDirectory = path.join(f.directory, 'data'), expectedHash = createHash('sha256').update('original\n').digest('hex');
  const server = await startResponsesFixture({ assertReplay: false, handler: ({ body }: { body: { input: Array<{ type: string; role?: string; content?: string | Array<{ text?: string }> }> } }) => {
    const goal = body.input.filter(item => item.role === 'user').map(item => typeof item.content === 'string' ? item.content : item.content?.map(part => part.text ?? '').join('')).join('\n');
    return { output: [goal.includes('Independent child write') ? functionCall('child-write', 'apply_patch', { path: 'nested/source.txt', content: 'actual child side effect\n', expectedHash })
      : goal.includes('Parent dispatch') ? functionCall('parent-delegate', 'delegate_implement', { baseline: 'head', tasks: [{ title: 'Isolated change', goal: 'Independent child write' }] })
      : assistantMessage('unexpected', 'Unexpected fixture input')] };
  } });
  const store = new StateStore(dataDirectory), connections = new ConnectionStore(dataDirectory), events = new ExecutionEvents();
  const connectionDraft = connections.upsert({ name: 'audit fixture', protocol: 'responses', baseURL: server.baseURL, model: 'audit', enabled: true, allowLoopbackHttp: true, auth: { mode: 'memory' } });
  const connection = connections.setCredential({ id: connectionDraft.id, revision: connectionDraft.revision, mode: 'memory', secret: 'sk-native-audit-loopback-only' });
  const parentId = randomUUID(), projectId = randomUUID(), now = new Date().toISOString();
  store.change(state => { state.settings.notifications = false;
    state.projects.push({ id: projectId, name: 'Parent', path: f.cwd, createdAt: now });
    state.sessions.push({ id: parentId, projectId, title: 'Parent', cwd: f.cwd, kind: 'agent', execution: { providerId: 'native', mode: 'structured', conversationId: randomUUID() },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: connection.id, maxActiveMs: 60000, maxModelRequests: 8, maxToolCalls: 8 } }),
      started: false, archived: false, status: 'idle', createdAt: now, updatedAt: now }); });
  let executor = new NativeStructuredExecutor(store, connections, events, { worker: unknownChildWorker });
  let service: SessionService | undefined;
  const approved = new Set<string>(), unsubscribe = events.subscribe(event => { if (event.type !== 'conversation.changed') return;
    for (const request of executor.snapshot(parentId).pending) if (!approved.has(request.requestId)) { approved.add(request.requestId); queueMicrotask(() => executor.respond(parentId, request.requestId, { behavior: 'allow' })); }
  });
  try {
    await executor.initialize(); const failed = await executor.send(parentId, 'Parent dispatch', []);
    assert.equal(failed.success, false); assert.equal(executor.activeCount, 1, 'unknown child settlement keeps the old parent ownership barrier even after the returned promise settles');
    const saved = await receipts(path.join(dataDirectory, 'native')); assert.equal(saved.length, 1); assert.equal(saved[0].status, 'unknown');
    assert.equal(server.requests.length, 2, JSON.stringify({ failed, receipt: saved[0] }));
    const childRoot = saved[0].workspace!.path; assert.equal(childRoot, path.join(dataDirectory, 'native', 'agent-worktrees', saved[0].childId));
    assert.equal(await fs.readFile(path.join(childRoot, 'nested', 'source.txt'), 'utf8'), 'actual child side effect\n');
    assert.equal(await fs.readFile(path.join(f.cwd, 'nested', 'source.txt'), 'utf8'), 'original\n');
    assert.ok(saved[0].artifact?.changedFiles.some(file => file.path === 'nested/source.txt')); assert.ok(await fs.stat(saved[0].artifact!.patchPath));
    const requests = server.requests.length; assert.equal(requests, 2, 'unknown child must stop parent before another model request');
    await assert.rejects(executor.shutdown(), /尚未完全释放/, 'the old process must not claim it has released unknown child resources');
    executor = new NativeStructuredExecutor(store, connections, events, { worker: unknownChildWorker }); await executor.initialize();
    assert.equal(executor.recoveryRequired(parentId), true); assert.deepEqual(await executor.recoveryDirectories(parentId), [childRoot]);
    const registry = new ExecutionRegistry(id => { const session = store.state.sessions.find(item => item.id === id); if (!session) throw new Error('Missing session'); return session; });
    const terminal = new AuditTerminal(); registry.register({ providerId: 'native', mode: 'structured', executor, capabilities: () => capabilities });
    registry.register({ providerId: 'shell', mode: 'terminal', executor: terminal, capabilities: () => capabilities });
    service = new SessionService(store, registry, () => {}, () => null, { history: async () => ({ entries: [], total: 0, nextOffset: null }), diagnose: async () => { throw new Error('Unused'); } });
    const competitors: Session[] = [];
    for (const cwd of [childRoot, path.dirname(childRoot), path.join(childRoot, 'nested')]) {
      const shell: Session = { id: randomUUID(), projectId, title: 'Shell competitor', cwd, kind: 'shell', execution: { providerId: 'shell', mode: 'terminal' }, engineConfig: { schemaVersion: 1, options: {} }, started: false, archived: false, status: 'idle', createdAt: now, updatedAt: now };
      store.change(state => state.sessions.push(shell)); competitors.push(shell);
      await assert.rejects(service.start(shell.id), /需要核查/); assert.equal(terminal.has(shell.id), false);
    }
    assert.equal(server.requests.length, requests); await executor.confirmRecovery(parentId);
    assert.equal(executor.recoveryRequired(parentId), false); await service.start(competitors[0].id); assert.equal(terminal.has(competitors[0].id), true); await service.stop(competitors[0].id);
    const readOnly = await executor.send(parentId, 'Do not replay the unknown child', []); assert.equal(readOnly.success, false); assert.match(readOnly.error!, /只读|新建会话/);
    assert.equal(server.requests.length, requests); assert.deepEqual(server.errors, []);
  } finally { unsubscribe(); try { if (service) await service.shutdown(); else await executor.shutdown(); } finally { await server.close(); store.flush(); } }
});

async function physicalWorker(directory: string): Promise<NonNullable<NativeExecutorOptions['worker']>> {
  const bundle = path.join(directory, 'physical-worker.cjs'), shim = path.join(directory, 'parent-port.cjs');
  await build({ entryPoints: [fileURLToPath(new URL('../src/main/engines/native/worker-entry.ts', import.meta.url))], outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' });
  await fs.writeFile(shim, `const {EventEmitter}=require('node:events');
const port=new EventEmitter();port.postMessage=value=>process.send(value);
process.parentPort=port;process.on('message',data=>port.emit('message',{data}));require(process.argv[2]);\n`);
  const physicalFork: NativeWorkerFork = (_file, _args, options) => {
    const child = fork(shim, [bundle], { execPath: process.execPath, env: options.env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const adapter = Object.assign(new EventEmitter(), { pid: child.pid, stdout: child.stdout, stderr: child.stderr,
      postMessage: (message: unknown) => { child.send(message as never); }, kill: () => child.kill() });
    child.on('message', message => adapter.emit('message', message)); child.on('exit', code => adapter.emit('exit', code)); child.on('error', error => adapter.emit('error', error));
    return adapter as NativeWorkerChild;
  };
  return options => runNativeWorker({ ...options, fork: physicalFork });
}

test('actual Native parent and independent physical child worker exclude long nested approval from the shared active deadline', async t => {
  const f = await repository(t), dataDirectory = path.join(f.directory, 'data'), ceilingMs = 8000, approvalWaitMs = 8500;
  const expectedHash = createHash('sha256').update('original\n').digest('hex'), worker = await physicalWorker(f.directory);
  const server = await startResponsesFixture({ assertReplay: false, handler: ({ body }: { body: { input: Array<{ type: string; role?: string; content?: string | Array<{ text?: string }>; call_id?: string }> } }) => {
    const goal = body.input.filter(item => item.role === 'user').map(item => typeof item.content === 'string' ? item.content : item.content?.map(part => part.text ?? '').join('')).join('\n');
    const results = new Set(body.input.filter(item => item.type === 'function_call_output').map(item => item.call_id));
    if (goal.includes('Independent approved child')) return { output: [results.has('child-write') ? assistantMessage('child-finished', 'Real approved file change finished')
      : functionCall('child-write', 'apply_patch', { path: 'nested/source.txt', content: 'approved physical child write\n', expectedHash })] };
    return { output: [results.has('parent-delegate') ? assistantMessage('parent-finished', 'Child worktree and evidence retained')
      : functionCall('parent-delegate', 'delegate_implement', { baseline: 'head', tasks: [{ title: 'Child approval', goal: 'Independent approved child' }] })] };
  } });
  const store = new StateStore(dataDirectory), connections = new ConnectionStore(dataDirectory), events = new ExecutionEvents();
  const draft = connections.upsert({ name: 'physical audit fixture', protocol: 'responses', baseURL: server.baseURL, model: 'audit', enabled: true, allowLoopbackHttp: true, auth: { mode: 'memory' } });
  const connection = connections.setCredential({ id: draft.id, revision: draft.revision, mode: 'memory', secret: 'sk-native-audit-physical-only' });
  const id = randomUUID(), projectId = randomUUID(), now = new Date().toISOString();
  store.change(state => { state.projects.push({ id: projectId, name: 'Parent', path: f.cwd, createdAt: now });
    state.sessions.push({ id, projectId, title: 'Physical parent', kind: 'agent', cwd: f.cwd, execution: { providerId: 'native', mode: 'structured', conversationId: randomUUID() },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: connection.id, maxActiveMs: ceilingMs, maxModelRequests: 8, maxToolCalls: 8 } }),
      started: false, archived: false, status: 'idle', createdAt: now, updatedAt: now }); });
  const executor = new NativeStructuredExecutor(store, connections, events, { worker }), approved = new Set<string>(), approvals: Array<Promise<void>> = [];
  let childApprovalWaited = false;
  const unsubscribe = events.subscribe(event => { if (event.type !== 'conversation.changed') return;
    for (const request of executor.snapshot(id).pending) if (!approved.has(request.requestId)) {
      approved.add(request.requestId); const child = JSON.stringify(request).includes('apply_patch');
      const operation = (async () => { if (child) { await new Promise(resolve => setTimeout(resolve, approvalWaitMs)); childApprovalWaited = true; }
        executor.respond(id, request.requestId, { behavior: 'allow' }); })(); approvals.push(operation);
    }
  });
  try {
    await executor.initialize(); const start = performance.now(), result = await executor.send(id, 'Delegate one approved physical child', []);
    await Promise.all(approvals); assert.equal(result.success, true, JSON.stringify(result)); assert.equal(childApprovalWaited, true);
    assert.ok(performance.now() - start > ceilingMs, 'wall time must actually exceed the full parent active allowance');
    assert.ok(result.nativeReceipt!.usage.activeMs < ceilingMs, 'manual waiting is excluded from the parent execution receipt');
    const saved = await receipts(path.join(dataDirectory, 'native')); assert.equal(saved[0].status, 'completed'); assert.equal(saved[0].result!.committed, true);
    assert.equal(await fs.readFile(path.join(saved[0].workspace!.path, 'nested', 'source.txt'), 'utf8'), 'approved physical child write\n');
    assert.equal(await fs.readFile(path.join(f.cwd, 'nested', 'source.txt'), 'utf8'), 'original\n');
    assert.equal(server.requests.length, 4); assert.equal(executor.activeCount, 0); assert.equal(executor.recoveryRequired(id), false); assert.deepEqual(server.errors, []);
  } finally { unsubscribe(); try { await executor.shutdown(); } finally { await Promise.allSettled(approvals); await server.close(); store.flush(); } }
});
