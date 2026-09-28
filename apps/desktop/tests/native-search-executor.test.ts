import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { runAgent } from '@cc-desk/agent-core';
import { createNativeModel } from '@cc-desk/agent-node/native-model';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { execFileAsync } from '../src/main/commands';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { createNativeConfig } from '../src/main/engines/native/config';
// @ts-expect-error Test-only local HTTP/SSE fixture has no declarations.
import { startResponsesFixture, functionCall, assistantMessage } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';
// @ts-expect-error Test-only local HTTP/SSE fixture has no declarations.
import { startChatCompletionsFixture } from '../../../packages/agent-node/tests/fixtures/chat-completions-server.mjs';

type Protocol = 'responses' | 'chat-completions';
type Mode = 'edit' | 'cancel' | 'deep' | 'external-edit';
type WireBody = { tools: Array<any>; input?: Array<any>; messages?: Array<any> };
const sentinel = 'sk-native-search-test-never-persist';
const query = { path: '.', query: '^needle: (alpha|zeta)$', mode: 'regex', glob: '*.txt', pageSize: 1 };
const plan = (implemented = false) => ({ goal: 'Find and edit only the requested match',
  steps: [{ id: 'edit', title: 'Locate and edit the matching file', dependsOn: [], status: implemented ? 'implemented' : 'in_progress' }],
  criteria: [{ id: 'scope', description: 'Review the exact resulting diff and untouched content', stepIds: ['edit'], kind: 'manual' }],
});
function receipts(body: WireBody): Map<string, any> {
  const items = body.input ?? body.messages ?? [];
  return new Map(items.filter(item => item.type === 'function_call_output' || item.role === 'tool')
    .map(item => [item.call_id ?? item.tool_call_id, JSON.parse(item.output ?? item.content)]));
}
const inline: NonNullable<NativeExecutorOptions['worker']> = options => runAgent({ ...options.request, signal: options.signal }, {
  model: createNativeModel(options.model), tools: options.tools, store: options.store, approvals: options.approvals,
  host: { now: Date.now, digest: value => createHash('sha256').update(value).digest('hex'), emit: options.onEvent,
    deadline: (ms, parent) => {
      const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, ms);
      parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort();
      return { signal: controller.signal, dispose() { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
    },
  },
});

async function fixture(protocol: Protocol, mode: Mode = 'edit') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-search-executor-'));
  const project = path.join(directory, 'project'), data = path.join(directory, 'data');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'AGENTS.md'), 'Keep unrelated lines and files unchanged.');
  await fs.writeFile(path.join(project, 'alpha.txt'), 'needle: alpha\nalpha user content\n');
  await fs.writeFile(path.join(project, 'zeta.txt'), 'needle: zeta\nzeta user content\n');
  await fs.mkdir(path.join(project, 'src'));
  await fs.writeFile(path.join(project, 'src', 'AGENTS.md'), 'NESTED_REQUIREMENT: preserve the trailing user line.');
  await fs.writeFile(path.join(project, 'src', 'feature.txt'), 'needle: feature\nuser content\n');
  let cursor = '', ready!: () => void;
  const reachedFirstPage = new Promise<void>(resolve => { ready = resolve; });
  const handler = async ({ body }: { body: WireBody }) => {
    const turn = (body.input ?? body.messages ?? []).filter(item => item.role === 'user').length;
    const prefix = `turn-${turn}`, done = receipts(body);
    const call = (id: string, name: string, input: unknown) => protocol === 'responses'
      ? { output: [functionCall(`${prefix}-${id}`, name, input)] }
      : { message: { role: 'assistant', content: null, tool_calls: [{ id: `${prefix}-${id}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } };
    const finish = () => protocol === 'responses' ? { output: [assistantMessage(`${prefix}-final`, 'Model claims implementation and verification are complete.')] }
      : { message: { role: 'assistant', content: 'Model claims implementation and verification are complete.' } };
    const definitions = body.tools.map(tool => tool.function ?? tool);
    const search = definitions.find(tool => tool.name === 'search');
    assert.ok(search?.parameters?.properties?.mode, 'real protocol request exposes regex search');
    assert.ok(definitions.find(tool => tool.name === 'find_files')?.parameters?.properties?.cursor, 'file search schema reaches the model');
    if (turn > 1) {
      if (!done.has(`${prefix}-old-cursor`)) return call('old-cursor', 'search', { ...query, cursor });
      if (!done.has(`${prefix}-fresh-search`)) return call('fresh-search', 'search', { path: '.', query: 'needle:', glob: '*.txt', pageSize: 10 });
      return finish();
    }
    if (mode === 'deep') {
      if (!done.has(`${prefix}-search`)) return call('search', 'search', { path: '.', query: 'needle: feature', glob: 'src/*.txt' });
      const hit = done.get(`${prefix}-search`).output.matches[0];
      if (!done.has(`${prefix}-unseen-edit`)) return call('unseen-edit', 'edit_file', { path: hit.path, oldText: 'needle: feature', newText: 'updated: feature', expectedHash: hit.hash });
      if (!done.has(`${prefix}-read-rules`)) return call('read-rules', 'read_file', { path: hit.path });
      if (!done.has(`${prefix}-scoped-edit`)) return call('scoped-edit', 'edit_file', { path: hit.path, oldText: 'needle: feature', newText: 'updated: feature', expectedHash: hit.hash });
      return finish();
    }
    if (!done.has(`${prefix}-plan`)) return call('plan', 'update_plan', { expectedRevision: 0, plan: plan() });
    if (!done.has(`${prefix}-find`)) return call('find', 'find_files', { path: '.', glob: '*.txt', pageSize: 1 });
    if (!done.has(`${prefix}-search`)) return call('search', 'search', query);
    cursor = done.get(`${prefix}-search`).output.nextCursor;
    assert.ok(cursor, 'a bounded first page must retain a continuation cursor');
    ready();
    if (mode === 'cancel') return { hang: true };
    if (!done.has(`${prefix}-next-page`)) return call('next-page', 'search', { ...query, cursor });
    const hit = done.get(`${prefix}-next-page`).output.matches[0];
    if (!done.has(`${prefix}-edit`)) {
      if (mode === 'external-edit') await fs.writeFile(path.join(project, hit.path), 'external user edit\n');
      return call('edit', 'edit_file', { path: hit.path, oldText: 'needle: zeta', newText: 'updated: zeta', expectedHash: hit.hash });
    }
    if (!done.has(`${prefix}-read-task`)) return call('read-task', 'read_task', {});
    if (!done.has(`${prefix}-implemented`)) return call('implemented', 'update_plan', { expectedRevision: done.get(`${prefix}-read-task`).output.task.revision, plan: plan(true) });
    return finish();
  };
  const server = await (protocol === 'responses' ? startResponsesFixture({ handler }) : startChatCompletionsFixture({ handler }));
  const store = new StateStore(data), connections = new ConnectionStore(data), events = new ExecutionEvents();
  const created = connections.upsert({ name: 'search fixture', protocol, baseURL: server.baseURL, model: 'fixture-model', enabled: true, allowLoopbackHttp: true, auth: { mode: 'memory' } });
  connections.setCredential({ id: created.id, revision: created.revision, mode: 'memory', secret: sentinel });
  const id = randomUUID(), conversationId = randomUUID(), projectId = randomUUID();
  store.change(state => {
    state.projects.push({ id: projectId, name: 'fixture', path: project, createdAt: new Date().toISOString() });
    state.sessions.push({ id, projectId, title: 'search', kind: 'agent', cwd: project, execution: { providerId: 'native', mode: 'structured', conversationId },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: created.id } }), started: false, status: 'idle', archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  const executor = new NativeStructuredExecutor(store, connections, events, { worker: inline }); await executor.initialize();
  const pending = new Set<string>(), approvals: string[] = [];
  const off = events.subscribe(event => {
    if (event.type !== 'conversation.changed') return;
    for (const item of executor.snapshot(id).pending) if (!pending.has(item.requestId)) {
      pending.add(item.requestId); approvals.push(item.toolName);
      queueMicrotask(() => { executor.respond(id, item.requestId, { behavior: 'allow' }); });
    }
  });
  return { id, directory, project, data, conversationId, executor, server, approvals, reachedFirstPage,
    async dispose() { off(); await executor.shutdown().catch(() => {}); await server.close(); store.flush(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

for (const protocol of ['responses', 'chat-completions'] as const) test(`${protocol}: paged regex hashes drive exact approved edits without declaring task acceptance`, { timeout: 20000 }, async () => {
  const f = await fixture(protocol);
  try {
    const result = await f.executor.send(f.id, 'Locate the requested file and edit it', [], undefined, { requestId: 'first' });
    assert.equal(result.success, true, JSON.stringify(result)); assert.deepEqual(f.server.errors, []);
    const done = receipts(f.server.requests.at(-1));
    const first = done.get('turn-1-search').output, second = done.get('turn-1-next-page').output;
    assert.equal(first.matches.length, 1); assert.equal(first.matches[0].path, 'alpha.txt');
    assert.equal(first.scanComplete, true); assert.equal(first.complete, false); assert.equal(first.pageComplete, false);
    assert.equal(second.matches.length, 1); assert.equal(second.matches[0].path, 'zeta.txt'); assert.equal(second.nextCursor, null);
    assert.equal(second.matches[0].hash, createHash('sha256').update('needle: zeta\nzeta user content\n').digest('hex'));
    assert.equal(second.matches[0].hashStatus, 'complete'); assert.equal(second.matches[0].line, 1);
    assert.deepEqual(f.approvals, ['edit_file']);
    assert.equal(await fs.readFile(path.join(f.project, 'zeta.txt'), 'utf8'), 'updated: zeta\nzeta user content\n');
    assert.equal(await fs.readFile(path.join(f.project, 'alpha.txt'), 'utf8'), 'needle: alpha\nalpha user content\n');
    const task = f.executor.snapshot(f.id).nativeTask!;
    assert.equal(task.execution, 'ended'); assert.equal(task.verification, 'unverified'); assert.equal(task.evidence.length, 0);
    const count = f.server.requests.length;
    assert.equal((await f.executor.send(f.id, 'Locate the requested file and edit it', [], undefined, { requestId: 'first' })).success, true);
    assert.equal(f.server.requests.length, count, 'durable submission acknowledgement never replays an edit');
    const next = await f.executor.send(f.id, 'A new run cannot reuse the prior cursor', [], undefined, { requestId: 'second' });
    assert.equal(next.success, true, 'a rejected read leaves operational completion compatible with queue acknowledgement');
    const nextResults = receipts(f.server.requests.at(-1));
    assert.equal(nextResults.get('turn-2-old-cursor').status, 'failed');
    assert.equal(nextResults.get('turn-2-fresh-search').status, 'completed');
    assert.equal(f.approvals.length, 1); assert.deepEqual(f.server.errors, []);
    const ledger = await NativeRunStore.open({ rootDirectory: path.join(f.data, 'native', 'conversations'), conversationId: f.conversationId });
    try { assert.equal(ledger.listRuns().length, 2); assert.equal(ledger.listRuns()[1].result?.status, 'completed'); assert.equal(JSON.stringify(ledger.replay()).includes(sentinel), false); }
    finally { await ledger.close(); }
  } finally { await f.dispose(); }
});

for (const protocol of ['responses', 'chat-completions'] as const) test(`${protocol}: cancellation retains completed search receipts without reviving cursors in the next run`, { timeout: 20000 }, async () => {
  const f = await fixture(protocol, 'cancel');
  try {
    const running = f.executor.send(f.id, 'Cancel after the first search page', [], undefined, { requestId: 'cancel-first' });
    await Promise.race([f.reachedFirstPage, running.then(result => { throw new Error(`Run ended before cancellation checkpoint: ${JSON.stringify(result)}`); })]);
    await f.executor.stopAndWait(f.id);
    const result = await running; assert.equal(result.interrupted, true); assert.equal(result.success, false);
    assert.equal(f.executor.has(f.id), false); assert.equal(f.approvals.length, 0);
    assert.equal(await fs.readFile(path.join(f.project, 'zeta.txt'), 'utf8'), 'needle: zeta\nzeta user content\n');
    assert.equal((await f.executor.send(f.id, 'Continue in a new run', [], undefined, { requestId: 'after-cancel' })).success, true);
    const done = receipts(f.server.requests.at(-1));
    assert.equal(done.get('turn-1-search').status, 'completed');
    assert.equal(done.get('turn-2-old-cursor').status, 'failed'); assert.equal(done.get('turn-2-fresh-search').status, 'completed');
    assert.notEqual(f.executor.snapshot(f.id).nativeTask?.verification, 'passed'); assert.deepEqual(f.server.errors, []);
  } finally { await f.dispose(); }
});

test('a deep search hit cannot waive unseen scoped instructions before a later edit', { timeout: 20000 }, async () => {
  const f = await fixture('responses', 'deep');
  try {
    const result = await f.executor.send(f.id, 'Search a nested scope and edit the matching file');
    assert.equal(result.success, true, JSON.stringify(result)); assert.deepEqual(f.server.errors, []);
    const done = receipts(f.server.requests.at(-1));
    assert.equal(done.get('turn-1-unseen-edit').status, 'failed'); assert.equal(done.get('turn-1-scoped-edit').status, 'completed');
    assert.doesNotMatch(JSON.stringify(done.get('turn-1-search').output.instructions), /NESTED_REQUIREMENT/);
    assert.match(JSON.stringify(done.get('turn-1-read-rules').output.instructions), /NESTED_REQUIREMENT/);
    assert.deepEqual(f.approvals, ['edit_file']);
    assert.equal(await fs.readFile(path.join(f.project, 'src', 'feature.txt'), 'utf8'), 'updated: feature\nuser content\n');
  } finally { await f.dispose(); }
});

test('an external edit after a search invalidates the returned content hash before approval', { timeout: 20000 }, async () => {
  const f = await fixture('responses', 'external-edit');
  try {
    const result = await f.executor.send(f.id, 'Preserve an external modification');
    assert.equal(result.success, true, JSON.stringify(result)); assert.deepEqual(f.server.errors, []);
    assert.equal(receipts(f.server.requests.at(-1)).get('turn-1-edit').status, 'failed'); assert.deepEqual(f.approvals, []);
    assert.equal(await fs.readFile(path.join(f.project, 'zeta.txt'), 'utf8'), 'external user edit\n');
    assert.notEqual(f.executor.snapshot(f.id).nativeTask?.verification, 'passed');
  } finally { await f.dispose(); }
});

test('the real LocalToolPort regex worker runs from an esbuild CommonJS bundle without a worker asset', { timeout: 20000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-search-bundle-'));
  const project = path.join(directory, 'project'), outfile = path.join(directory, 'search.cjs'), preload = path.join(directory, 'host-preload.cjs'); await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'file.txt'), 'needle: alpha\n');
  await fs.writeFile(preload, "if(!require('node:worker_threads').isMainThread)throw new Error('Host preload must not run inside the regex worker');\n");
  const localTools = fileURLToPath(new URL('../../../packages/agent-node/src/tools/local-tools.ts', import.meta.url));
  const supervisor = fileURLToPath(new URL('../../../packages/agent-node/src/process-supervisor.ts', import.meta.url));
  const source = `import { createLocalToolPort } from ${JSON.stringify(localTools)};
import { ProcessSupervisor } from ${JSON.stringify(supervisor)};
async function main() {
  const identity = {sessionId:'session',conversationId:'conversation',runId:'run',requestId:'request',workerGeneration:1};
  const tools = createLocalToolPort({projectRoot:process.argv[2],ownerId:'run',supervisor:new ProcessSupervisor()});
  const context = {identity,policyRevision:'policy',signal:new AbortController().signal,maxOutputBytes:32768};
  const prepared = await tools.prepare({id:'search',name:'search',arguments:JSON.stringify(${JSON.stringify(query)})},context);
  const result = await tools.execute(prepared,context); process.stdout.write(JSON.stringify(result));
}
main().catch(error=>{process.stderr.write(String(error));process.exitCode=1;});`;
  try {
    await build({ stdin: { contents: source, sourcefile: 'search-bundle-smoke.ts', loader: 'ts', resolveDir: path.dirname(localTools) }, bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' });
    const { stdout } = await execFileAsync(process.execPath, ['--require', preload, outfile, project], { timeout: 15000, maxBuffer: 256 * 1024 });
    const result = JSON.parse(stdout); assert.equal(result.status, 'completed'); assert.equal(result.output.matches[0].path, 'file.txt');
    assert.equal(result.output.matches[0].hash, createHash('sha256').update('needle: alpha\n').digest('hex'));
    assert.equal(result.output.complete, true); assert.equal(result.output.nextCursor, null);
    assert.deepEqual((await fs.readdir(directory)).sort(), ['host-preload.cjs', 'project', 'search.cjs']);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
