import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runAgent } from '@cc-desk/agent-core';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { ResponsesModel } from '@cc-desk/agent-node/responses-model';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { createNativeConfig } from '../src/main/engines/native/config';
// A real local HTTP/SSE fixture replaces only the remote model.
// @ts-expect-error Local test-only ESM fixture has no declarations.
import { startResponsesFixture, assistantMessage, functionCall } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

type Worker = NonNullable<NativeExecutorOptions['worker']>;
type Body = { input: Array<Record<string, unknown>>; instructions?: string };
type Handler = (request: { body: Body; index: number }) => { output: unknown[] };
const agentsSkill = '.agents/skills/review/SKILL.md';
const claudeSkill = '.claude/skills/review/SKILL.md';
const secret = 'sk-project-skills-local-fixture';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const inlineWorker: Worker = options => runAgent({ ...options.request, signal: options.signal }, {
  model: new ResponsesModel(options.model), tools: options.tools, store: options.store, approvals: options.approvals,
  host: { now: Date.now, digest: hash, emit: options.onEvent,
    deadline: (timeout, parent) => {
      const controller = new AbortController(), abort = () => controller.abort();
      const timer = setTimeout(abort, timeout); parent.addEventListener('abort', abort, { once: true });
      if (parent.aborted) abort();
      return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
    },
  },
});

async function fixture(options: { handler?: Handler; worker?: Worker } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-project-skills-'));
  const data = path.join(directory, 'data'), project = path.join(directory, 'project');
  await fs.mkdir(project); await fs.writeFile(path.join(project, 'fixture.txt'), 'original\n');
  await fs.writeFile(path.join(project, 'AGENTS.md'), 'Keep unrelated files intact.\n');
  const server = await startResponsesFixture({ handler: options.handler ?? (({ index }: { index: number }) => ({ output: [assistantMessage(`answer-${index}`, 'Recorded.')] })) });
  let store = new StateStore(data), connections = new ConnectionStore(data);
  const connection = connections.upsert({ name: 'local', protocol: 'responses', baseURL: server.baseURL, model: 'skills-fixture', allowLoopbackHttp: true, enabled: true, auth: { mode: 'memory' } });
  const connectionId = connection.id;
  connections.setCredential({ id: connectionId, revision: connection.revision, mode: 'memory', secret });
  const id = randomUUID(), conversationId = randomUUID(), projectId = randomUUID();
  store.change(state => {
    state.projects.push({ id: projectId, path: project, name: 'project', createdAt: new Date().toISOString() });
    state.sessions.push({ id, projectId, title: 'project skills', kind: 'agent', cwd: project,
      execution: { providerId: 'native', mode: 'structured', conversationId },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId } }),
      started: false, status: 'idle', archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  const events = new ExecutionEvents();
  let executor = new NativeStructuredExecutor(store, connections, events, { worker: options.worker ?? inlineWorker });
  await executor.initialize();
  return { data, project, id, server,
    get store() { return store; }, get executor() { return executor; },
    async writeSkill(relative: string, content: string) {
      const file = path.join(project, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content);
    },
    async configure(projectSkills: string[]) {
      const config = structuredClone(store.state.sessions.find(item => item.id === id)!.engineConfig);
      config.options.projectSkills = projectSkills; await executor.updateConfig(id, config);
    },
    async ledger() {
      const ledger = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
      try { return { runs: ledger.listRuns(), records: ledger.replay(), context: ledger.loadContext() }; }
      finally { await ledger.close(); }
    },
    async restart(withCredential = true) {
      await executor.shutdown(); store = new StateStore(data); connections = new ConnectionStore(data);
      if (withCredential) {
        const connection = connections.list().connections.find(item => item.id === connectionId)!;
        connections.setCredential({ id: connectionId, revision: connection.revision, mode: 'memory', secret });
      }
      executor = new NativeStructuredExecutor(store, connections, events, { worker: options.worker ?? inlineWorker });
      await executor.initialize();
    },
    async approval() {
      const current = executor.attention()[0]; if (current) return current;
      return new Promise<ReturnType<NativeStructuredExecutor['attention']>[number]>((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error('Expected tool approval within 10 seconds.')); }, 10_000);
        const off = events.subscribe(() => {
          const pending = executor.attention()[0];
          if (pending) { clearTimeout(timer); off(); resolve(pending); }
        });
      });
    },
    async dispose() { await executor.shutdown().catch(() => {}); await server.close(); store.flush(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

test('existing sessions do not automatically send discovered project Skills to the model', async () => {
  const f = await fixture();
  try {
    await f.writeSkill(agentsSkill, 'UNSELECTED_AGENTS_SKILL');
    await f.writeSkill(claudeSkill, 'UNSELECTED_CLAUDE_SKILL');
    assert.deepEqual(f.store.state.sessions.find(item => item.id === f.id)!.engineConfig.options.projectSkills, []);
    const result = await f.executor.send(f.id, '只遵守项目规则');
    assert.equal(result.success, true, JSON.stringify(result)); assert.equal(f.server.requests.length, 1);
    assert.match(f.server.requests[0].instructions, /Keep unrelated files intact/);
    assert.doesNotMatch(f.server.requests[0].instructions, /UNSELECTED_|SKILL\.md/);
    const run = (await f.ledger()).runs[0];
    assert.deepEqual(run.configuration.instructions, [{ path: 'AGENTS.md', scope: '.', hash: hash('Keep unrelated files intact.\n') }]);
  } finally { await f.dispose(); }
});

test('an explicitly selected custom project Skill reaches the model and persists across restart', async () => {
  const f = await fixture();
  try {
    const source = 'tools/quality/review/SKILL.md';
    await f.writeSkill(source, 'CUSTOM_PROJECT_GUIDE');
    await f.configure([source]);
    const first = await f.executor.send(f.id, '检查自定义项目来源');
    assert.equal(first.success, true, JSON.stringify(first));
    assert.match(f.server.requests[0].instructions, /CUSTOM_PROJECT_GUIDE/);
    assert.deepEqual((await f.ledger()).runs[0].configuration.instructions, [
      { path: 'AGENTS.md', scope: '.', hash: hash('Keep unrelated files intact.\n') },
      { path: source, scope: '.', hash: hash('CUSTOM_PROJECT_GUIDE') },
    ]);
    await f.restart();
    assert.deepEqual(f.store.state.sessions.find(item => item.id === f.id)!.engineConfig.options.projectSkills, [source]);
    await f.writeSkill(source, 'UPDATED_CUSTOM_GUIDE');
    const next = await f.executor.send(f.id, '再次读取');
    assert.equal(next.success, true, JSON.stringify(next));
    assert.match(f.server.requests.at(-1).instructions, /UPDATED_CUSTOM_GUIDE/);
    assert.doesNotMatch(f.server.requests.at(-1).instructions, /CUSTOM_PROJECT_GUIDE/);
  } finally { await f.dispose(); }
});

test('selected same-name Skills from both roots persist, record source hashes, and reload new content after restart', async () => {
  const f = await fixture();
  try {
    const original = 'AGENTS_SKILL_VERSION_ONE', other = 'CLAUDE_SKILL_MARKER';
    await f.writeSkill(agentsSkill, original); await f.writeSkill(claudeSkill, other);
    await f.configure([agentsSkill, claudeSkill]);
    const first = await f.executor.send(f.id, '检查项目', [], undefined, { requestId: 'skills-first' });
    assert.equal(first.success, true, JSON.stringify(first)); assert.equal(f.server.requests.length, 1);
    assert.ok(f.server.requests[0].instructions.includes(original)); assert.ok(f.server.requests[0].instructions.includes(other));
    const before = await f.ledger();
    const sources = before.runs[0].configuration.instructions as Array<{ path: string; hash: string }>;
    for (const [relative, content] of [[agentsSkill, original], [claudeSkill, other]]) assert.equal(sources.find(source => source.path === relative)?.hash, hash(content));
    assert.equal(JSON.stringify(before.records).includes(secret), false);
    await f.restart();
    assert.deepEqual(f.store.state.sessions.find(item => item.id === f.id)!.engineConfig.options.projectSkills, [agentsSkill, claudeSkill]);
    await f.writeSkill(agentsSkill, 'AGENTS_SKILL_VERSION_TWO');
    const second = await f.executor.send(f.id, '继续检查', [], undefined, { requestId: 'skills-second' });
    assert.equal(second.success, true, JSON.stringify(second)); assert.equal(f.server.requests.length, 2);
    assert.match(f.server.requests[1].instructions, /AGENTS_SKILL_VERSION_TWO/);
    assert.doesNotMatch(f.server.requests[1].instructions, /AGENTS_SKILL_VERSION_ONE/);
    assert.ok(f.server.requests[1].instructions.includes(other));
    assert.deepEqual(f.server.requests[1].input.slice(0, before.context!.items.length), before.context!.items);
    const after = await f.ledger();
    const freshSources = after.runs[1].configuration.instructions as Array<{ path: string; hash: string }>;
    assert.equal(freshSources.find(source => source.path === agentsSkill)?.hash, hash('AGENTS_SKILL_VERSION_TWO'));
    assert.notEqual(after.runs[0].policyRevision, after.runs[1].policyRevision);
    assert.deepEqual(f.server.errors, []);
  } finally { await f.dispose(); }
});

test('invalid Skill selections preserve saved config and a missing selected file prevents any model request', async () => {
  const f = await fixture();
  try {
    const before = structuredClone(f.store.state.sessions.find(item => item.id === f.id)!.engineConfig);
    const disk = await fs.readFile(f.store.file, 'utf8');
    for (const invalid of [
      ['../outside/SKILL.md'], ['/tmp/SKILL.md'], ['.agents/skills/../SKILL.md'], ['.claude/skills/.env/SKILL.md'],
      [agentsSkill, agentsSkill], Array.from({ length: 17 }, (_, index) => `.agents/skills/skill-${index}/SKILL.md`),
    ]) await assert.rejects(f.configure(invalid));
    assert.deepEqual(f.store.state.sessions.find(item => item.id === f.id)!.engineConfig, before);
    assert.equal(await fs.readFile(f.store.file, 'utf8'), disk); assert.equal(f.server.requests.length, 0);
    await f.configure([agentsSkill]);
    const result = await f.executor.send(f.id, '不能忽略丢失的Skill');
    assert.equal(result.success, false); assert.equal(f.server.requests.length, 0);
    assert.equal((await f.ledger()).runs.length, 0, 'missing selection fails before a model run is accepted');
    assert.equal(f.executor.has(f.id), false);
  } finally { await f.dispose(); }
});

for (const tool of ['apply_patch', 'run_command'] as const) test(`changing a selected Skill during ${tool} approval invalidates the effect`, async () => {
  const f = await fixture({ handler: ({ body }) => {
    const result = body.input.find(item => item.type === 'function_call_output' && item.call_id === 'effect');
    if (result) return { output: [assistantMessage('done', 'Effect was handled.')] };
    if (tool === 'run_command') return { output: [functionCall('effect', tool, { executable: process.execPath, argv: ['-e', 'require("node:fs").writeFileSync("command-marker.txt", "executed")'], cwd: '.' })] };
    const read = body.input.find(item => item.type === 'function_call_output' && item.call_id === 'read');
    if (!read) return { output: [functionCall('read', 'read_file', { path: 'fixture.txt' })] };
    const observed = JSON.parse(String(read.output));
    return { output: [functionCall('effect', tool, { path: 'fixture.txt', content: 'changed\n', expectedHash: observed.output.hash })] };
  } });
  let pending: ReturnType<NativeStructuredExecutor['send']> | undefined;
  try {
    await f.writeSkill(agentsSkill, 'SKILL_APPROVAL_VERSION_ONE'); await f.configure([agentsSkill]);
    pending = f.executor.send(f.id, '执行审批操作');
    const approval = await f.approval();
    await assert.rejects(f.configure([]), /停止运行/, 'selection cannot change while the request holds the session');
    await f.writeSkill(agentsSkill, 'SKILL_APPROVAL_VERSION_TWO');
    f.executor.respond(f.id, approval.requestId, { behavior: 'allow' }); await pending;
    assert.equal(await fs.readFile(path.join(f.project, 'fixture.txt'), 'utf8'), 'original\n');
    await assert.rejects(fs.stat(path.join(f.project, 'command-marker.txt')), { code: 'ENOENT' });
    const effect = f.server.requests.at(-1).input.find((item: Record<string, unknown>) => item.type === 'function_call_output' && item.call_id === 'effect');
    assert.deepEqual(JSON.parse(effect.output), { status: 'failed', output: { error: 'tool_preconditions_changed', executed: false } });
    assert.equal(f.executor.attention().length, 0); assert.deepEqual(f.server.errors, []);
    await f.configure([]);
    assert.deepEqual(f.store.state.sessions.find(item => item.id === f.id)!.engineConfig.options.projectSkills, []);
  } finally { await f.dispose(); await pending; }
});

test('legacy receipts without projectSkills replay without credentials, but changing the selection rejects reuse', async () => {
  const f = await fixture({ worker: options => {
    const request = structuredClone(options.request);
    delete (request.configuration.sessionOptions as Record<string, unknown>).projectSkills;
    return inlineWorker({ ...options, request });
  } });
  try {
    const input = '旧配置的已完成请求', requestId = 'legacy-skills-receipt';
    assert.equal((await f.executor.send(f.id, input, [], undefined, { requestId })).success, true);
    const before = await f.ledger();
    await f.restart(false);
    const duplicate = await f.executor.send(f.id, input, [], undefined, { requestId });
    assert.equal(duplicate.success, true, JSON.stringify(duplicate)); assert.equal(f.server.requests.length, 1);
    assert.deepEqual(await f.ledger(), before);
    await f.writeSkill(agentsSkill, 'NEW_SELECTION'); await f.configure([agentsSkill]);
    const changed = await f.executor.send(f.id, input, [], undefined, { requestId });
    assert.equal(changed.success, false); assert.match(changed.error!, /不同的输入或配置/);
    assert.equal(f.server.requests.length, 1); assert.deepEqual(await f.ledger(), before);
  } finally { await f.dispose(); }
});
