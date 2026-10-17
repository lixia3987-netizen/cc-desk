import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { runAgent } from '@cc-desk/agent-core';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { ResponsesModel } from '@cc-desk/agent-node/responses-model';
import { SkillRegistry } from '@cc-desk/agent-node/skill-registry';
import { SkillSnapshotStore } from '@cc-desk/agent-node/skill-snapshots';
import { ProjectFiles } from '@cc-desk/agent-node/tools';
import { ProcessSupervisor } from '@cc-desk/agent-node/process-supervisor';
import { McpStdioClient } from '@cc-desk/agent-node/mcp-stdio-client';
import type { NativeSkillSubmission } from '@cc-desk/contracts/native-skills';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { NativeSkillRuntime } from '../src/main/engines/native/skill-runtime';
import { createNativeConfig } from '../src/main/engines/native/config';
import { NativeMcpConnectionStore } from '../src/main/engines/native/mcp-connections';
import { NativeCredentialStore } from '../src/main/engines/native/credentials';
// @ts-expect-error Shared local HTTP/SSE fixture has no TypeScript declaration.
import { startResponsesFixture, assistantMessage, functionCall } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

type Body = { input: Array<Record<string, unknown>>; instructions?: string; tools: Array<{ name: string }> };
type Handler = (request: { body: Body; index: number }) => unknown;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = 'sk-native-catalog-fixture-private';
const guide = 'CATALOG_GUIDE_FULL_BODY: Preserve unrelated files and verify every edit.';
const inlineWorker: NonNullable<NativeExecutorOptions['worker']> = options => runAgent({ ...options.request, signal: options.signal }, {
  model: new ResponsesModel(options.model), tools: options.tools, store: options.store, approvals: options.approvals,
  contextMaintenance: options.contextMaintenance,
  host: { now: Date.now, digest: hash, emit: options.onEvent, deadline: (timeout, parent) => {
    const controller = new AbortController(), abort = () => controller.abort();
    const timer = setTimeout(abort, timeout); parent.addEventListener('abort', abort, { once: true });
    if (parent.aborted) abort();
    return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
  } },
});
async function fixture(options: { handler?: Handler; enabled?: boolean; autoApprove?: boolean; skillBody?: string; stdio?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-skill-runtime-'));
  const data = path.join(directory, 'data'), project = path.join(directory, 'project');
  const skillPath = path.join(project, '.agents/skills/review/SKILL.md');
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(skillPath, `---\nname: review\ndescription: Review project changes.\n---\n${options.skillBody ?? guide}`);
  await fs.writeFile(path.join(project, 'fixture.txt'), 'original\n');
  const server = await startResponsesFixture({ handler: options.handler ?? (() => ({ output: [assistantMessage('final', 'Done.')] })) });
  const store = new StateStore(data), connections = new ConnectionStore(data);
  const connection = connections.upsert({ name: 'local', protocol: 'responses', baseURL: server.baseURL, model: 'catalog-fixture', allowLoopbackHttp: true, enabled: true, auth: { mode: 'memory' } });
  connections.setCredential({ id: connection.id, revision: connection.revision, mode: 'memory', secret });
  const id = randomUUID(), conversationId = randomUUID(), projectId = randomUUID();
  const mcpConnections = new NativeMcpConnectionStore(data, new NativeCredentialStore());
  const mcpLog = path.join(directory, 'mcp-child.jsonl');
  const mcp = options.stdio ? mcpConnections.upsert({ name: 'Skill startup fixture', transport: 'stdio', protocolVersion: '2025-11-25',
    executable: process.execPath, argv: [fileURLToPath(new URL('./fixtures/mcp-stdio-executor.mjs', import.meta.url)), mcpLog,
      'normal', path.join(data, 'native', 'conversations', conversationId, 'journal.jsonl')], environment: {}, enabled: true, auth: { mode: 'none' } }) : undefined;
  store.change(state => {
    state.projects.push({ id: projectId, path: project, name: 'project', createdAt: new Date().toISOString() });
    state.sessions.push({ id, projectId, title: 'skill runtime', kind: 'agent', cwd: project,
      execution: { providerId: 'native', mode: 'structured', conversationId },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: connection.id, autoCompact: 'before_send_and_during_run', ...(mcp ? { mcpConnections: [mcp.id] } : {}) } }),
      started: false, status: 'idle', archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  const registry = () => new SkillRegistry({ projectId, projectRoot: project, sources: [
    { id: 'project-agents', scope: 'project', kind: 'project-agents', rootPath: '.agents/skills', enabled: true, revision: 1 },
  ] });
  const snapshotsDirectory = path.join(data, 'native', 'skill-snapshots');
  const runtime = new NativeSkillRuntime({ registry, snapshots: new SkillSnapshotStore({ directory: snapshotsDirectory }), forbiddenValues: () => [secret] });
  const events = new ExecutionEvents();
  const executor = new NativeStructuredExecutor(store, connections, events, { worker: inlineWorker, mcpConnections, ...(options.enabled === false ? {} : { skills: runtime }) });
  await executor.initialize();
  const approvalIds = new Set<string>();
  const off = events.subscribe(() => {
    if (options.autoApprove === false) return;
    for (const pending of executor.attention()) if (!approvalIds.has(pending.requestId)) {
      approvalIds.add(pending.requestId); queueMicrotask(() => executor.respond(id, pending.requestId, { behavior: 'allow' }));
    }
  });
  return { directory, data, project, skillPath, snapshotsDirectory, id, server, store, executor, registry, runtime, events, mcpLog,
    async submission(): Promise<NativeSkillSubmission> {
      const source = registry(), catalog = await source.discover(), descriptor = catalog.entries[0];
      const loaded = await source.loadCatalogSkill(descriptor);
      return { schemaVersion: 1, explicitSkillRefs: [{ skillId: descriptor.skillId, catalogRevision: catalog.revision, version: loaded.version }], excludedSkillIds: [] };
    },
    async ledger() {
      const ledger = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
      try { return { runs: ledger.listRuns(), records: ledger.replay(), head: ledger.head?.hash }; }
      finally { await ledger.close(); }
    },
    async dispose() { off(); await executor.shutdown().catch(() => {}); await server.close(); store.flush(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}
const output = (body: Body, id: string) => {
  const result = body.input.find(item => item.type === 'function_call_output' && item.call_id === id);
  return result ? JSON.parse(String(result.output)) : undefined;
};

test('ordinary construction keeps catalog tools disabled and rejects explicit refs without a model request', async () => {
  const f = await fixture({ enabled: false });
  try {
    const submission = await f.submission();
    await assert.rejects(f.executor.send(f.id, 'Use guide', [], undefined, { requestId: 'disabled', nativeSkills: submission }), /尚未启用/);
    assert.equal(f.server.requests.length, 0);
    assert.equal((await f.executor.send(f.id, 'Ordinary task')).success, true);
    const body = f.server.requests[0] as Body;
    assert.equal(body.tools.some(tool => tool.name === 'load_skill' || tool.name === 'list_skills'), false);
    assert.doesNotMatch(body.instructions!, /CATALOG_GUIDE_FULL_BODY|Native skill catalog/);
  } finally { await f.dispose(); }
});

for (const order of ['load-first', 'write-first'] as const) test(`a real ${order} model batch cannot write until a later complete request observes the committed body`, async () => {
  let selected: NativeSkillSubmission;
  let project = '';
  const f = await fixture({ handler: ({ body, index }) => {
    if (index === 0) {
      assert.doesNotMatch(body.instructions!, /CATALOG_GUIDE_FULL_BODY/);
      assert.equal(body.tools.some(tool => tool.name.startsWith('delegate_') || tool.name === 'recover_agent'), false);
      const load = functionCall('load', 'load_skill', { skillId: selected.explicitSkillRefs[0].skillId, catalogRevision: selected.explicitSkillRefs[0].catalogRevision });
      const write = functionCall('too-early', 'apply_patch', { path: 'new.txt', content: 'EARLY', expectedHash: null });
      return { output: order === 'load-first' ? [load, write] : [write, load] };
    }
    if (index === 1) {
      assert.equal(existsSync(path.join(project, 'new.txt')), false, 'the early batch has not touched the target');
      const loaded = output(body, 'load');
      assert.equal(loaded.status, 'completed'); assert.equal(loaded.output.body, guide); assert.equal(loaded.output.complete, true);
      assert.notEqual(output(body, 'too-early').status, 'completed');
      return { output: [functionCall('write-after-observation', 'apply_patch', { path: 'new.txt', content: 'observed\n', expectedHash: null })] };
    }
    assert.equal(output(body, 'write-after-observation').status, 'completed');
    return { output: [assistantMessage('final', 'Guide observed and edit completed.')] };
  } });
  project = f.project;
  try {
    selected = await f.submission();
    const result = await f.executor.send(f.id, 'Use the relevant review guide and edit', [], undefined, { requestId: 'model-load' });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(await fs.readFile(path.join(project, 'new.txt'), 'utf8'), 'observed\n');
    assert.equal(f.server.requests.length, 3);
    const persisted = await f.ledger(), run = persisted.runs[0];
    assert.equal(run.configuration.effectiveAutoCompact, 'before_send_and_during_run');
    assert.equal(run.configuration.nativeSkillCatalog !== undefined, true);
    assert.equal(persisted.records.filter(record => record.event.type === 'tool_completed' && record.event.call.id === 'load').length, 1);
    const loadSeq = persisted.records.find(record => record.event.type === 'tool_completed' && record.event.call.id === 'load')!.seq;
    const observedResponseSeq = persisted.records.filter(record => record.event.type === 'model_response')[1].seq;
    const writeSeq = persisted.records.find(record => record.event.type === 'tool_prepared' && record.event.prepared.call.id === 'write-after-observation')!.seq;
    assert.ok(loadSeq < observedResponseSeq && observedResponseSeq < writeSeq);
    assert.equal(JSON.stringify(persisted).includes(secret), false);
    const duplicate = await f.executor.send(f.id, 'Use the relevant review guide and edit', [], undefined, { requestId: 'model-load' });
    assert.equal(duplicate.success, true); assert.equal(f.server.requests.length, 3);
    const fresh = await f.executor.send(f.id, 'Next new turn', [], undefined, { requestId: 'fresh-turn' });
    assert.equal(fresh.success, true, JSON.stringify(fresh)); assert.equal(f.server.requests.length, 4);
    const next = (await f.ledger()).runs[1];
    assert.equal((next.configuration.initialNativeSkills as { activations: unknown[] }).activations.length, 0);
    assert.match(f.server.requests[3].instructions, /earlier turns are historical evidence/);
  } finally { await f.dispose(); }
});

test('explicit immutable guides enter the first request and an original receipt retry never rereads changed sources', async () => {
  const f = await fixture();
  try {
    const selected = await f.submission();
    await f.runtime.prepareSubmission(f.id, selected);
    const input = 'Explicit guide', requestId = 'explicit-version';
    const result = await f.executor.send(f.id, input, [], undefined, { requestId, nativeSkills: selected });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.match(f.server.requests[0].instructions, /CATALOG_GUIDE_FULL_BODY/);
    const persisted = await f.ledger();
    assert.deepEqual(persisted.runs[0].configuration.nativeSkills, selected);
    assert.equal((persisted.runs[0].configuration.initialNativeSkills as { activations: unknown[] }).activations.length, 1);
    await fs.writeFile(f.skillPath, 'changed source');
    assert.equal((await f.executor.send(f.id, input, [], undefined, { requestId, nativeSkills: selected })).success, true);
    assert.equal(f.server.requests.length, 1);
    const other: NativeSkillSubmission = { ...selected, explicitSkillRefs: [], excludedSkillIds: [selected.explicitSkillRefs[0].skillId] };
    const refused = await f.executor.send(f.id, input, [], undefined, { requestId, nativeSkills: other });
    assert.equal(refused.success, false); assert.match(refused.error!, /不同的输入或配置/); assert.equal(f.server.requests.length, 1);
  } finally { await f.dispose(); }
});

test('a queued exact version changed before execution fails before any run/model request', async () => {
  const f = await fixture();
  try {
    const selected = await f.submission(); await f.runtime.prepareSubmission(f.id, selected);
    await fs.writeFile(f.skillPath, 'source changed after acceptance');
    const result = await f.executor.send(f.id, 'Old queued guide', [], undefined, { requestId: 'stale-version', nativeSkills: selected, source: 'queue' });
    assert.equal(result.success, false); assert.match(result.error!, /技能目录、来源或文件版本已改变/);
    assert.equal(f.server.requests.length, 0); assert.equal((await f.ledger()).runs.length, 0);
  } finally { await f.dispose(); }
});

test('credential-bearing skill content cannot enter snapshot objects, model instructions or run records', async () => {
  const f = await fixture({ skillBody: `Never persist ${secret}` });
  try {
    const selected = await f.submission();
    await assert.rejects(f.runtime.prepareSubmission(f.id, selected));
    const objects = await fs.readdir(f.snapshotsDirectory).catch(() => []);
    assert.deepEqual(objects, []);
    const result = await f.executor.send(f.id, 'Secret guide', [], undefined, { requestId: 'protected-guide', nativeSkills: selected });
    assert.equal(result.success, false); assert.equal(f.server.requests.length, 0); assert.equal((await f.ledger()).runs.length, 0);
  } finally { await f.dispose(); }
});

test('source changes during an approved write invalidate the previously loaded guide without an effect', async () => {
  const f = await fixture({ autoApprove: false, handler: ({ body, index }) => index === 0
    ? { output: [functionCall('guarded-write', 'apply_patch', { path: 'new.txt', content: 'must not exist', expectedHash: null })] }
    : { output: [assistantMessage('final', `Write ${output(body, 'guarded-write').status}`)] } });
  let pending: ReturnType<NativeStructuredExecutor['send']> | undefined;
  try {
    const selected = await f.submission(); await f.runtime.prepareSubmission(f.id, selected);
    const approval = new Promise<ReturnType<NativeStructuredExecutor['attention']>[number]>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('Expected approval.')); }, 5000);
      const off = f.events.subscribe(() => {
        const item = f.executor.attention()[0];
        if (item) { clearTimeout(timer); off(); resolve(item); }
      });
    });
    pending = f.executor.send(f.id, 'Load guide and edit', [], undefined, { requestId: 'approval-source-change', nativeSkills: selected });
    const request = await approval;
    await fs.writeFile(f.skillPath, 'changed after approval was prepared');
    f.executor.respond(f.id, request.requestId, { behavior: 'allow' });
    const result = await pending; assert.equal(result.success, true, JSON.stringify(result));
    await assert.rejects(fs.stat(path.join(f.project, 'new.txt')), { code: 'ENOENT' });
    assert.notEqual(output(f.server.requests.at(-1), 'guarded-write').status, 'completed');
  } finally { await f.dispose(); await pending; }
});

test('a live managed command blocks new guide activation and retains the original command lifecycle', async () => {
  let selected: NativeSkillSubmission;
  const f = await fixture({ handler: ({ body, index }) => {
    if (index === 0) return { output: [functionCall('live-command', 'start_command', { executable: process.execPath,
      argv: ['-e', 'setInterval(() => {}, 1000)'], cwd: '.' })] };
    if (index === 1) {
      assert.equal(output(body, 'live-command').status, 'completed');
      return { output: [functionCall('blocked-load', 'load_skill', { skillId: selected.explicitSkillRefs[0].skillId,
        catalogRevision: selected.explicitSkillRefs[0].catalogRevision })] };
    }
    assert.deepEqual(output(body, 'blocked-load'), { status: 'not_executed', output: { error: 'activation_blocked_by_operation', executed: false } });
    return { output: [assistantMessage('final', 'Guide activation deferred until command cleanup.')] };
  } });
  try {
    selected = await f.submission();
    const result = await f.executor.send(f.id, 'Start command then load', [], undefined, { requestId: 'command-blocks-load' });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(f.server.requests.length, 3); assert.equal(f.executor.recoveryRequired(f.id), false);
    const command = (await f.ledger()).runs[0].tools.find(tool => tool.call.id === 'live-command')!;
    assert.equal(command.commandProgress?.at(-1)?.status, 'finished');
    assert.deepEqual(await fs.readdir(f.snapshotsDirectory).catch(() => []), []);
  } finally { await f.dispose(); }
});

test('explicit guide and execution policy bind a real stdio startup receipt without duplicate launch', async () => {
  const f = await fixture({ stdio: true });
  try {
    const selected = await f.submission(); await f.runtime.prepareSubmission(f.id, selected);
    const submission = { requestId: 'skills-stdio-startup', nativeSkills: selected, nativeExecutionPolicy: { toolPolicy: 'standard' as const } };
    const result = await f.executor.send(f.id, 'Start approved local service with guide', [], undefined, submission);
    assert.equal(result.success, true, JSON.stringify(result)); assert.match(f.server.requests[0].instructions, /CATALOG_GUIDE_FULL_BODY/);
    const children = (await fs.readFile(f.mcpLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const spawns = children.filter(item => item.event === 'spawn'); assert.equal(spawns.length, 1);
    assert.throws(() => process.kill(spawns[0].pid, 0), { code: 'ESRCH' });
    await fs.writeFile(f.skillPath, 'Changed after completion');
    assert.equal((await f.executor.send(f.id, 'Start approved local service with guide', [], undefined, submission)).success, true);
    assert.equal(f.server.requests.length, 1);
    assert.equal((await fs.readFile(f.mcpLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(item => item.event === 'spawn').length, 1);
  } finally { await f.dispose(); }
});

test('read-only Native policy permits bounded skill reads and offers no write, command or delegation tool', async () => {
  let selected: NativeSkillSubmission;
  const f = await fixture({ handler: ({ body, index }) => {
    for (const name of ['apply_patch', 'apply_change_set', 'run_command', 'start_command', 'delegate_review', 'delegate_implement', 'recover_agent']) {
      assert.equal(body.tools.some(tool => tool.name === name), false, name);
    }
    assert.equal(body.tools.some(tool => tool.name === 'list_skills'), true);
    assert.equal(body.tools.some(tool => tool.name === 'load_skill'), true);
    if (index === 0) return { output: [functionCall('readonly-guide', 'load_skill', { skillId: selected.explicitSkillRefs[0].skillId,
      catalogRevision: selected.explicitSkillRefs[0].catalogRevision })] };
    assert.equal(output(body, 'readonly-guide').output.body, guide);
    return { output: [assistantMessage('final', 'Read-only guide observed.')] };
  } });
  try {
    selected = await f.submission();
    const result = await f.executor.send(f.id, 'Read-only guide review', [], undefined,
      { requestId: 'readonly-guide', nativeExecutionPolicy: { toolPolicy: 'read_only' } });
    assert.equal(result.success, true, JSON.stringify(result)); assert.equal(f.server.requests.length, 2);
  } finally { await f.dispose(); }
});

test('the complete initial catalog, including its instructions and envelope, stays within 16 KiB and 64 entries', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 70; index++) {
      const file = path.join(f.project, '.agents/skills', `guide-${index}`, 'SKILL.md');
      await fs.mkdir(path.dirname(file));
      await fs.writeFile(file, `---\nname: guide-${index}\ndescription: ${'description '.repeat(40)}\n---\nBODY_NOT_TO_LOAD_${index}`);
    }
    const run = await f.runtime.createRun({ sessionId: f.id, identity: { sessionId: f.id, conversationId: randomUUID(), runId: randomUUID(),
      requestId: 'bounded-catalog', workerGeneration: 1 }, baseInstructionBytes: 0, signal: new AbortController().signal, assertOwnership() {} });
    assert.ok(Buffer.byteLength(run.initialInstructions) <= 16 * 1024);
    assert.doesNotMatch(run.initialInstructions, /BODY_NOT_TO_LOAD/);
    const initial = JSON.parse(run.initialInstructions.split('Native skill catalog: ')[1]);
    assert.ok(initial.entries.length > 0 && initial.entries.length <= 64); assert.equal(initial.truncated, true);
    assert.equal(run.catalog.entries.length, 71); assert.equal(f.server.requests.length, 0);
  } finally { await f.dispose(); }
});

for (const kind of ['legacy', 'invalid', 'empty'] as const) test(`a ${kind}-only source offers no empty catalog or unusable model skill tools`, async () => {
  const f = await fixture();
  try {
    if (kind === 'empty') await fs.rm(f.skillPath);
    else await fs.writeFile(f.skillPath, kind === 'legacy' ? 'LEGACY_MANUAL_GUIDE' : '---\nname: [bad metadata\n---\nINVALID_GUIDE');
    const result = await f.executor.send(f.id, 'No eligible model guide');
    assert.equal(result.success, true, JSON.stringify(result));
    const body = f.server.requests[0] as Body;
    assert.equal(body.tools.some(tool => tool.name === 'list_skills' || tool.name === 'load_skill'), false);
    assert.doesNotMatch(body.instructions!, /Native skill catalog|Available skills are optional|LEGACY_MANUAL_GUIDE|INVALID_GUIDE/);
  } finally { await f.dispose(); }
});

test('an explicit legacy guide remains loadable without advertising ineligible model catalog tools', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(f.skillPath, 'EXPLICIT_LEGACY_BODY');
    const selected = await f.submission(); await f.runtime.prepareSubmission(f.id, selected);
    const result = await f.executor.send(f.id, 'Manual legacy guide', [], undefined, { requestId: 'explicit-legacy', nativeSkills: selected });
    assert.equal(result.success, true, JSON.stringify(result));
    const body = f.server.requests[0] as Body;
    assert.match(body.instructions!, /EXPLICIT_LEGACY_BODY/); assert.doesNotMatch(body.instructions!, /Native skill catalog/);
    assert.equal(body.tools.some(tool => tool.name === 'list_skills' || tool.name === 'load_skill'), false);
  } finally { await f.dispose(); }
});

test('a source changed during temporary-file I/O is rejected at the final patch publication hook', async t => {
  const f = await fixture({ handler: ({ body, index }) => index === 0
    ? { output: [functionCall('late-patch', 'apply_patch', { path: 'new.txt', content: 'must not publish', expectedHash: null })] }
    : { output: [assistantMessage('final', `Patch ${output(body, 'late-patch').status}`)] } });
  const original = ProjectFiles.prototype.applyPatch;
  let changed = false;
  t.mock.method(ProjectFiles.prototype, 'applyPatch', function (this: ProjectFiles, ...args: Parameters<typeof original>) {
    const [prepared, signal, beforePublish] = args;
    return original.call(this, prepared, signal, async () => {
      assert.equal(typeof beforePublish, 'function');
      changed = true; await fs.writeFile(f.skillPath, 'Skill changed after final validation and temporary-file I/O.');
      await beforePublish!();
    });
  });
  try {
    const selected = await f.submission(); await f.runtime.prepareSubmission(f.id, selected);
    const result = await f.executor.send(f.id, 'Publish guarded patch', [], undefined, { requestId: 'late-patch', nativeSkills: selected });
    assert.equal(result.success, true, JSON.stringify(result)); assert.equal(changed, true);
    assert.equal(output(f.server.requests.at(-1), 'late-patch').status, 'not_executed');
    await assert.rejects(fs.stat(path.join(f.project, 'new.txt')), { code: 'ENOENT' });
    assert.equal((await fs.readdir(f.project)).some(file => file.startsWith('.native-patch-')), false);
    assert.equal(f.executor.recoveryRequired(f.id), false);
  } finally { await f.dispose(); }
});

for (const tool of ['run_command', 'start_command'] as const) test(`a source changed after guardian preparation blocks the actual ${tool} launch`, async t => {
  const f = await fixture({ handler: ({ body, index }) => index === 0 ? { output: [functionCall('late-command', tool, {
    executable: process.execPath, argv: ['-e', 'require("node:fs").writeFileSync("command-effect.txt", "must not run")'], cwd: '.',
  })] } : { output: [assistantMessage('final', `Command ${output(body, 'late-command').status}`)] } });
  let checkedAfterGuardian = false;
  let guardProvided = false;
  const wrap = async (beforeLaunch?: () => void | Promise<void>) => {
    checkedAfterGuardian = true; await fs.writeFile(f.skillPath, 'Source changed after the guardian exists.');
    guardProvided = typeof beforeLaunch === 'function'; await beforeLaunch?.();
  };
  if (tool === 'run_command') {
    const original = ProcessSupervisor.prototype.run;
    t.mock.method(ProcessSupervisor.prototype, 'run', function (this: ProcessSupervisor, ...args: Parameters<typeof original>) {
      return original.call(this, args[0], args[1], args[2], args[3], () => wrap(args[4]));
    });
  } else {
    const original = ProcessSupervisor.prototype.start;
    t.mock.method(ProcessSupervisor.prototype, 'start', function (this: ProcessSupervisor, ...args: Parameters<typeof original>) {
      return original.call(this, args[0], args[1], args[2], args[3], () => wrap(args[4]));
    });
  }
  try {
    const selected = await f.submission(); await f.runtime.prepareSubmission(f.id, selected);
    const result = await f.executor.send(f.id, 'Guard command launch', [], undefined, { requestId: `late-${tool}`, nativeSkills: selected });
    assert.equal(result.success, true, JSON.stringify(result)); assert.equal(checkedAfterGuardian, true); assert.equal(guardProvided, true);
    await assert.rejects(fs.stat(path.join(f.project, 'command-effect.txt')), { code: 'ENOENT' });
    assert.equal(f.executor.recoveryRequired(f.id), false);
    if (tool === 'run_command') {
      assert.equal(output(f.server.requests.at(-1), 'late-command').status, 'not_executed');
      assert.equal(output(f.server.requests.at(-1), 'late-command').output.exitCode, null);
    }
    else {
      const command = (await f.ledger()).runs[0].tools.find(item => item.call.id === 'late-command')!;
      assert.equal(command.commandProgress?.at(-1)?.status, 'finished');
    }
  } finally { await f.dispose(); }
});

test('a source changed during the MCP execution catalog refresh prevents its remote side effect', async t => {
  const f = await fixture({ stdio: true, handler: ({ body, index }) => index === 0
    ? { output: [functionCall('late-mcp', body.tools.find(item => item.name.startsWith('mcp_'))!.name, { note: 'must not call' })] }
    : { output: [assistantMessage('final', `Remote ${output(body, 'late-mcp').status}`)] } });
  const original = McpStdioClient.prototype.discoverTools;
  let discoveries = 0;
  t.mock.method(McpStdioClient.prototype, 'discoverTools', async function (this: McpStdioClient, ...args: Parameters<typeof original>) {
    const result = await original.apply(this, args);
    if (++discoveries === 3) await fs.writeFile(f.skillPath, 'Source changed inside the final remote catalog refresh.');
    return result;
  });
  try {
    const selected = await f.submission(); await f.runtime.prepareSubmission(f.id, selected);
    const result = await f.executor.send(f.id, 'Guard external operation', [], undefined, { requestId: 'late-mcp', nativeSkills: selected });
    assert.equal(result.success, true, JSON.stringify(result)); assert.equal(discoveries, 3);
    assert.equal(output(f.server.requests.at(-1), 'late-mcp').status, 'not_executed');
    const events = (await fs.readFile(f.mcpLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.some(item => item.method === 'tools/call'), false);
    assert.equal(f.executor.recoveryRequired(f.id), false);
  } finally { await f.dispose(); }
});

test('a skill changed during stdio guardian preparation invalidates startup before any service or model effect', async t => {
  const f = await fixture({ stdio: true });
  const original = ProcessSupervisor.prototype.openStdio;
  let finalChecks = 0, guardProvided = false;
  t.mock.method(ProcessSupervisor.prototype, 'openStdio', function (this: ProcessSupervisor, ...args: Parameters<typeof original>) {
    return original.call(this, args[0], args[1], args[2], args[3], async () => {
      finalChecks++; guardProvided = typeof args[4] === 'function';
      await fs.writeFile(f.skillPath, 'Skill changed while the guardian was prepared.');
      await args[4]?.();
    });
  });
  try {
    const selected = await f.submission(); await f.runtime.prepareSubmission(f.id, selected);
    const submission = { requestId: 'late-stdio-startup', nativeSkills: selected };
    const result = await f.executor.send(f.id, 'Start approved service with exact guide', [], undefined, submission);
    assert.equal(result.success, false); assert.equal(guardProvided, true); assert.equal(finalChecks, 1);
    assert.equal(f.server.requests.length, 0); await assert.rejects(fs.stat(f.mcpLog), { code: 'ENOENT' });
    assert.equal(f.executor.has(f.id), false); assert.equal(f.executor.recoveryRequired(f.id), false);
    const persisted = await f.ledger(); assert.equal(persisted.runs.length, 0);
    assert.equal(persisted.records.filter(record => record.event.type === 'startup_prepared').length, 1);
    assert.equal(persisted.records.filter(record => record.event.type === 'startup_closed').length, 1);
    assert.equal(JSON.stringify(persisted).includes(secret), false);
    const duplicate = await f.executor.send(f.id, 'Start approved service with exact guide', [], undefined, submission);
    assert.equal(duplicate.success, false); assert.match(duplicate.error!, /不会重复启动/);
    assert.equal(finalChecks, 1); assert.equal(f.server.requests.length, 0);
    await assert.rejects(fs.stat(f.mcpLog), { code: 'ENOENT' });
  } finally { await f.dispose(); }
});
