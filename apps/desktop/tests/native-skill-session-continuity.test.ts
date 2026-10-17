import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runAgent, type JsonValue, type ModelContext } from '@cc-desk/agent-core';
import { createNativeModel, nativeModelProtocol } from '@cc-desk/agent-node/native-model';
import { requireCompleteContext } from '@cc-desk/agent-node/context-maintenance';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { SkillRegistry } from '@cc-desk/agent-node/skill-registry';
import { SkillSnapshotStore } from '@cc-desk/agent-node/skill-snapshots';
import type { NativeSkillSubmission } from '@cc-desk/contracts/native-skills';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { NativeSkillRuntime } from '../src/main/engines/native/skill-runtime';
import { createNativeConfig } from '../src/main/engines/native/config';
// @ts-expect-error Shared local HTTP/SSE fixtures have no TypeScript declarations.
import { startResponsesFixture, functionCall, assistantMessage } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';
// @ts-expect-error Shared local HTTP/SSE fixtures have no TypeScript declarations.
import { startChatCompletionsFixture } from '../../../packages/agent-node/tests/fixtures/chat-completions-server.mjs';
// @ts-expect-error Shared local HTTP/SSE fixtures have no TypeScript declarations.
import { startAnthropicFixture } from '../../../packages/agent-node/tests/fixtures/anthropic-server.mjs';

type Protocol = 'responses' | 'chat-completions' | 'anthropic';
type WireBody = { input?: any[]; messages?: any[]; tools?: any[]; instructions?: string; system?: unknown };
type Worker = NonNullable<NativeExecutorOptions['worker']>;
type WorkerOptions = Parameters<Worker>[0];
const secret = 'sk-native-skill-session-continuity-fixture';
const oldGuide = 'HISTORICAL_GUIDE_VERSION_ONE_BEGIN Preserve complete original evidence. HISTORICAL_GUIDE_VERSION_ONE_END';
const newGuide = 'CURRENT_GUIDE_VERSION_TWO_BEGIN Verify the new implementation before reporting completion. CURRENT_GUIDE_VERSION_TWO_END';
const summary = 'The earlier local fixture task completed. Evidence remains historical and human acceptance is unverified.';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const occurrences = (value: string, needle: string) => value.split(needle).length - 1;
const items = (body: WireBody): JsonValue[] => body.input ?? body.messages!.filter(item => item.role !== 'system');
const instructionText = (body: WireBody): string => body.instructions ?? (typeof body.system === 'string' ? body.system
  : JSON.stringify(body.system ?? body.messages?.filter(item => item.role === 'system') ?? ''));
const initialActivations = (request: WorkerOptions) => (request.request.configuration.initialNativeSkills as unknown as { activations: unknown[] }).activations;

async function fixture(protocol: Protocol = 'responses', options: { longAnswers?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-skill-session-'));
  const project = path.join(directory, 'project'), data = path.join(directory, 'data');
  const snapshotsDirectory = path.join(data, 'native', 'skill-snapshots');
  const skillPath = path.join(project, '.agents', 'skills', 'engineering', 'SKILL.md');
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  const writeGuide = (body: string) => fs.writeFile(skillPath, `---\nname: engineering\ndescription: An exact engineering guide.\n---\n${body}`);
  await writeGuide(oldGuide);
  await fs.writeFile(path.join(project, 'AGENTS.md'), 'Preserve unrelated files and report actual verification.');
  await fs.writeFile(path.join(project, 'fixture.txt'), 'Project evidence.\n');
  const id = randomUUID(), projectId = randomUUID(), conversationId = randomUUID();
  const registry = () => new SkillRegistry({ projectId, projectRoot: project, excludedRoots: [data], sources: [
    { id: 'project-agents', scope: 'project', kind: 'project-agents', rootPath: '.agents/skills', enabled: true, revision: 1 },
  ] });
  const runtime = new NativeSkillRuntime({ registry, snapshots: new SkillSnapshotStore({ directory: snapshotsDirectory }), forbiddenValues: () => [secret] });
  const message = (text: string) => protocol === 'responses' ? { output: [assistantMessage(`answer-${randomUUID()}`, text)] }
    : protocol === 'chat-completions' ? { message: { role: 'assistant', content: text } } : { content: [{ type: 'text', text }] };
  const call = (callId: string, name: string, args: unknown, text = '') => protocol === 'responses'
    ? { output: [...(text ? [assistantMessage(`${callId}-notes`, text, 'commentary')] : []), functionCall(callId, name, args)] }
    : protocol === 'chat-completions' ? { message: { role: 'assistant', content: text || null, tool_calls: [{ id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }
      : { content: [...(text ? [{ type: 'text', text }] : []), { type: 'tool_use', id: callId, name, input: args }] };
  let handler: ((body: WireBody, request: WorkerOptions) => unknown) | undefined;
  let summaryHook: (() => void | Promise<void>) | undefined;
  let current: WorkerOptions | undefined;
  let summaries = 0;
  const normalRequests: Array<{ body: WireBody; request: WorkerOptions }> = [];
  const factory = protocol === 'responses' ? startResponsesFixture : protocol === 'chat-completions' ? startChatCompletionsFixture : startAnthropicFixture;
  const server = await factory({ assertReplay: false, handler: ({ body }: { body: WireBody }) => {
    assert.ok(current);
    if (!body.tools?.length) { summaries++; return message(summary); }
    requireCompleteContext({ protocol: nativeModelProtocol(protocol), items: items(body) });
    normalRequests.push({ body: structuredClone(body), request: current });
    return handler?.(body, current) ?? message('Completed fixture task. ' + (options.longAnswers ? 'Historical inspection detail. '.repeat(400) : ''));
  } });
  let store = new StateStore(data), connections = new ConnectionStore(data), executor: NativeStructuredExecutor;
  const created = connections.upsert({ name: 'local skill session', protocol, baseURL: server.baseURL,
    model: 'fixture-model', enabled: true, allowLoopbackHttp: true, auth: { mode: 'memory' } });
  const connectionId = created.id;
  connections.setCredential({ id: connectionId, revision: created.revision, mode: 'memory', secret });
  store.change(state => {
    state.projects.push({ id: projectId, path: project, name: 'project', createdAt: new Date().toISOString() });
    state.sessions.push({ id, projectId, title: 'skill session continuity', kind: 'agent', cwd: project,
      execution: { providerId: 'native', mode: 'structured', conversationId },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId, autoCompact: 'off', maxInputTokens: 240000 } }),
      started: false, archived: false, status: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  const events = new ExecutionEvents();
  const worker: Worker = async request => {
    current = request;
    const model = createNativeModel(request.model), generate = model.generate.bind(model);
    model.generate = candidate => { current = request; return generate(candidate); };
    const result = await runAgent({ ...request.request, signal: request.signal }, {
      model, tools: request.tools, store: request.store, approvals: request.approvals,
      contextMaintenance: request.contextMaintenance,
      host: { now: Date.now, digest: hash, emit: request.onEvent, deadline: (ms, parent) => {
        const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, ms);
        parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort();
        return { signal: controller.signal, dispose() { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
      } },
    });
    if (request.request.configuration.purpose === 'context_summary') await summaryHook?.();
    return result;
  };
  const createExecutor = () => new NativeStructuredExecutor(store, connections, events, { worker, skills: runtime });
  executor = createExecutor(); await executor.initialize();
  const approvals = new Set<string>();
  const off = events.subscribe(() => {
    for (const pending of executor.attention()) if (!approvals.has(pending.requestId)) {
      approvals.add(pending.requestId); queueMicrotask(() => executor.respond(id, pending.requestId, { behavior: 'allow' }));
    }
  });
  return { directory, data, project, id, skillPath, snapshotsDirectory, conversationId, server, runtime, registry, writeGuide, message, call, normalRequests,
    get executor() { return executor; }, get summaries() { return summaries; },
    setHandler(value: typeof handler) { handler = value; }, setSummaryHook(value: typeof summaryHook) { summaryHook = value; },
    async selection(): Promise<NativeSkillSubmission> {
      const source = registry(), catalog = await source.discover(), descriptor = catalog.entries[0];
      const loaded = await source.loadCatalogSkill(descriptor);
      const submission: NativeSkillSubmission = { schemaVersion: 1, explicitSkillRefs: [{ skillId: descriptor.skillId, catalogRevision: catalog.revision, version: loaded.version }], excludedSkillIds: [] };
      await runtime.prepareSubmission(id, submission);
      return submission;
    },
    async send(input: string, selection?: NativeSkillSubmission, requestId: string = randomUUID()) {
      return executor.send(id, input, [], undefined, { requestId, ...(selection ? { nativeSkills: selection } : {}) });
    },
    async ledger() {
      const ledger = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
      try { return { records: ledger.replay(), context: ledger.loadContext(), runs: ledger.listRuns(), head: ledger.head, compaction: ledger.getLastCompaction(), auto: ledger.getAutoCompactionForCurrentContext() }; }
      finally { await ledger.close(); }
    },
    async configure(changes: Record<string, unknown>) {
      const config = structuredClone(store.state.sessions.find(session => session.id === id)!.engineConfig);
      Object.assign(config.options, changes); await executor.updateConfig(id, config);
    },
    async enableBeforeSend(input: string) {
      const context = (await this.ledger()).context!, last = normalRequests.at(-1)!.request;
      const model = createNativeModel(last.model);
      const pending: ModelContext = { ...context, items: [...context.items, ...model.userItems(input)] };
      const usage = model.estimateInputUsage!(pending, last.request.budget!.maxOutputTokens!);
      const maximum = Math.floor(Math.max(usage.estimatedInputTokens, usage.serializedBytes) / 0.95);
      await this.configure({ autoCompact: 'before_send', maxInputTokens: maximum });
      return maximum;
    },
    async restart(withRuntime = true) {
      await executor.shutdown(); store.flush(); store = new StateStore(data); connections = new ConnectionStore(data);
      const connection = connections.list().connections.find(item => item.id === connectionId)!;
      connections.setCredential({ id: connection.id, revision: connection.revision, mode: 'memory', secret });
      executor = withRuntime ? createExecutor() : new NativeStructuredExecutor(store, connections, events, { worker });
      await executor.initialize();
    },
    async dispose() { off(); await executor.shutdown().catch(() => {}); await server.close(); store.flush(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

for (const protocol of ['responses', 'chat-completions', 'anthropic'] as const) test(`${protocol}: new turns bind current exact guide versions while old receipts remain historical`, { timeout: 25000 }, async () => {
  const f = await fixture(protocol);
  try {
    const oldSelection = await f.selection(), ref = oldSelection.explicitSkillRefs[0];
    let phase = 0;
    f.setHandler((body, request) => {
      assert.equal(body.tools?.some(tool => ['delegate_review', 'delegate_implement', 'recover_agent'].includes(tool.name ?? tool.function?.name)), false);
      if (request.request.input === 'Load the original guide') {
        if (phase++ === 0) {
          assert.deepEqual(initialActivations(request), []);
          return f.call('old-guide-load', 'load_skill', { skillId: ref.skillId, catalogRevision: ref.catalogRevision });
        }
        assert.ok(JSON.stringify(body).includes(oldGuide));
      }
      return f.message('Completed exact version fixture.');
    });
    assert.equal((await f.send('Load the original guide', undefined, 'historical-original')).success, true);
    const first = await f.ledger();
    const loadReceipt = first.records.find(record => record.event.type === 'tool_completed' && record.event.call.id === 'old-guide-load');
    assert.ok(loadReceipt);
    await f.writeGuide(newGuide);
    const beforeStale = f.server.requests.length;
    const stale = await f.send('A new submission cannot reuse the changed original version', oldSelection);
    assert.equal(stale.success, false);
    assert.equal(f.server.requests.length, beforeStale);
    const nextSelection = await f.selection();
    assert.equal(nextSelection.explicitSkillRefs[0].skillId, ref.skillId);
    assert.notEqual(nextSelection.explicitSkillRefs[0].version.fullFileHash, ref.version.fullFileHash);
    assert.equal((await f.send('Use the new exact guide', nextSelection)).success, true);
    const next = f.normalRequests.at(-1)!;
    assert.ok(instructionText(next.body).includes(newGuide));
    assert.equal(instructionText(next.body).includes(oldGuide), false);
    assert.equal(initialActivations(next.request).length, 1);
    assert.deepEqual((initialActivations(next.request)[0] as { version: unknown }).version, nextSelection.explicitSkillRefs[0].version);
    assert.ok(JSON.stringify(items(next.body)).includes(oldGuide), 'the original full historical body remains readable');
    const excluded: NativeSkillSubmission = { schemaVersion: 1, explicitSkillRefs: [], excludedSkillIds: [ref.skillId] };
    assert.equal((await f.send('Continue with the guide excluded', excluded)).success, true);
    const last = f.normalRequests.at(-1)!;
    assert.deepEqual(initialActivations(last.request), []);
    assert.equal(instructionText(last.body).includes(oldGuide), false);
    assert.equal(instructionText(last.body).includes(newGuide), false);
    assert.equal(last.body.tools?.some(tool => (tool.name ?? tool.function?.name) === 'load_skill'), false);
    const historical = await f.ledger();
    assert.deepEqual(historical.records.filter(record => record.seq <= loadReceipt.seq), first.records.filter(record => record.seq <= loadReceipt.seq));
    assert.equal(historical.runs.length, 3);
    assert.equal(JSON.stringify(historical).includes(secret), false);
    await fs.rm(f.skillPath);
    await f.restart();
    const beforeDuplicate = f.server.requests.length;
    assert.equal((await f.send('Load the original guide', undefined, 'historical-original')).success, true);
    assert.equal(f.server.requests.length, beforeDuplicate, 'durable original request returns its original receipt without source discovery');
    assert.equal((await f.send('Continue after deleting the historical source')).success, true);
    assert.deepEqual(initialActivations(f.normalRequests.at(-1)!.request), []);
    assert.deepEqual(f.server.errors, []);
  } finally { await f.dispose(); }
});

for (const protocol of ['responses', 'chat-completions', 'anthropic'] as const) test(`${protocol}: manual idle compaction preserves both exact historical versions without source access or activation`, { timeout: 25000 }, async () => {
  const f = await fixture(protocol, { longAnswers: true });
  try {
    const oldSelection = await f.selection();
    assert.equal((await f.send('Use first fixed version', oldSelection)).success, true);
    await f.writeGuide(newGuide);
    const newSelection = await f.selection();
    assert.equal((await f.send('Use second fixed version', newSelection)).success, true);
    assert.equal((await f.send('Latest ordinary task')).success, true);
    const before = await f.ledger();
    await fs.rm(f.skillPath);
    await f.executor.compactContext(f.id, before.head!.hash);
    assert.equal(f.summaries, 1);
    const compacted = await f.ledger();
    const wire = JSON.stringify(compacted.context);
    assert.ok(wire.includes('native_skill_history'));
    assert.equal(occurrences(wire, oldGuide), 1);
    assert.equal(occurrences(wire, newGuide), 1);
    assert.ok(wire.includes(oldSelection.explicitSkillRefs[0].version.fullFileHash));
    assert.ok(wire.includes(newSelection.explicitSkillRefs[0].version.fullFileHash));
    requireCompleteContext(compacted.context!);
    assert.equal(compacted.runs.length, before.runs.length, 'manual summary does not create a task run or re-activate a guide');
    await f.restart();
    assert.equal((await f.send('Continue with historical versions only')).success, true);
    assert.deepEqual(initialActivations(f.normalRequests.at(-1)!.request), []);
    assert.ok(JSON.stringify(f.normalRequests.at(-1)!.body).includes(oldGuide));
    assert.ok(JSON.stringify(f.normalRequests.at(-1)!.body).includes(newGuide));
    assert.deepEqual(f.server.errors, []);
  } finally { await f.dispose(); }
});

for (const mode of ['missing', 'corrupt'] as const) test(`manual compaction refuses a ${mode} historical snapshot before charging a summary request`, async () => {
  const f = await fixture();
  try {
    const selection = await f.selection();
    assert.equal((await f.send('Use fixed guide', selection)).success, true);
    assert.equal((await f.send('Another completed turn')).success, true);
    const before = await f.ledger(), object = path.join(f.snapshotsDirectory, `${selection.explicitSkillRefs[0].version.fullFileHash}.skill`);
    if (mode === 'missing') await fs.rm(object); else await fs.writeFile(object, 'Corrupt historical snapshot bytes.');
    await assert.rejects(f.executor.compactContext(f.id, before.head!.hash), /snapshot|版本|技能|快照|continuity/i);
    assert.equal(f.summaries, 0);
    const after = await f.ledger();
    assert.deepEqual(after.context, before.context);
    assert.equal(after.compaction, null);
  } finally { await f.dispose(); }
});

for (const mode of ['missing', 'corrupt'] as const) test(`manual compaction rechecks a historical snapshot made ${mode} during a paid summary`, async () => {
  const f = await fixture('responses', { longAnswers: true });
  try {
    const selection = await f.selection();
    assert.equal((await f.send('Use fixed guide', selection)).success, true);
    assert.equal((await f.send('Another completed turn')).success, true);
    const before = await f.ledger(), object = path.join(f.snapshotsDirectory, `${selection.explicitSkillRefs[0].version.fullFileHash}.skill`);
    f.setSummaryHook(() => mode === 'missing' ? fs.rm(object) : fs.writeFile(object, 'Changed after paid summary.'));
    await assert.rejects(f.executor.compactContext(f.id, before.head!.hash), /snapshot|版本|技能|快照|continuity/i);
    assert.equal(f.summaries, 1);
    const after = await f.ledger();
    assert.deepEqual(after.context, before.context);
    assert.equal(after.compaction, null);
    assert.equal(after.records.filter(record => record.event.type === 'context_compacted').length, 0);
  } finally { await f.dispose(); }
});

test('manual compaction does not charge when exact historical guide metadata already makes the smallest replacement larger', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.send('First compact completed turn', await f.selection())).success, true);
    await f.writeGuide(newGuide);
    assert.equal((await f.send('Second compact completed turn', await f.selection())).success, true);
    assert.equal((await f.send('Latest short completed turn')).success, true);
    const before = await f.ledger();
    await assert.rejects(f.executor.compactContext(f.id, before.head!.hash), /完整技能历史|未请求摘要/);
    assert.equal(f.summaries, 0, 'unavoidable exact historical metadata is checked before the paid model request');
    const after = await f.ledger();
    assert.deepEqual(after.context, before.context);
    assert.deepEqual(after.records, before.records);
    assert.equal(after.compaction, null);
  } finally { await f.dispose(); }
});

test('an executor without the internal skill runtime keeps historical skill sessions blocked after restart', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.send('Use fixed guide', await f.selection())).success, true);
    await f.restart(false);
    const count = f.server.requests.length, before = await f.ledger();
    const result = await f.send('Ordinary production host must not continue unsupported skill history');
    assert.equal(result.success, false);
    await assert.rejects(f.executor.compactContext(f.id, before.head!.hash));
    assert.equal(f.server.requests.length, count);
    assert.deepEqual((await f.ledger()).context, before.context);
  } finally { await f.dispose(); }
});

for (const protocol of ['responses', 'chat-completions', 'anthropic'] as const) test(`${protocol}: before-send compaction retains historical fixed guides after their source is removed`, { timeout: 25000 }, async () => {
  const f = await fixture(protocol, { longAnswers: true });
  try {
    const selection = await f.selection();
    assert.equal((await f.send('First exact guide turn', selection)).success, true);
    assert.equal((await f.send('Second historical task')).success, true);
    assert.equal((await f.send('Third historical task')).success, true);
    const input = 'Continue after automatic historical preservation';
    await f.enableBeforeSend(input);
    const before = await f.ledger();
    await fs.rm(f.skillPath);
    const result = await f.send(input, undefined, 'before-send-skills');
    assert.equal(result.success, true, JSON.stringify({ result, serverErrors: f.server.errors }));
    assert.equal(f.summaries, 1);
    assert.equal(result.nativeReceipt?.usage.modelRequests, 2);
    const next = f.normalRequests.at(-1)!;
    assert.deepEqual(initialActivations(next.request), []);
    assert.equal(instructionText(next.body).includes(oldGuide), false);
    assert.ok(JSON.stringify(items(next.body)).includes('native_skill_history'));
    assert.equal(occurrences(JSON.stringify(items(next.body)), oldGuide), 1);
    const after = await f.ledger();
    assert.equal(after.runs.length, before.runs.length + 1);
    assert.equal(after.records.filter(record => record.event.type === 'context_compaction_attempted').length, 1);
    assert.equal(after.records.filter(record => record.event.type === 'context_compacted').length, 1);
    assert.deepEqual(after.records.slice(0, before.records.length), before.records);
    requireCompleteContext(after.context!);
    assert.deepEqual(f.server.errors, []);
  } finally { await f.dispose(); }
});

for (const mode of ['missing', 'corrupt'] as const) test(`before-send compaction refuses a ${mode} historical snapshot before a paid summary`, async () => {
  const f = await fixture('responses', { longAnswers: true });
  try {
    const selection = await f.selection();
    assert.equal((await f.send('First exact guide turn', selection)).success, true);
    assert.equal((await f.send('Second historical task')).success, true);
    assert.equal((await f.send('Third historical task')).success, true);
    const input = 'Do not summarize unavailable guide evidence'; await f.enableBeforeSend(input);
    const before = await f.ledger(), object = path.join(f.snapshotsDirectory, `${selection.explicitSkillRefs[0].version.fullFileHash}.skill`);
    if (mode === 'missing') await fs.rm(object); else await fs.writeFile(object, 'Invalid historical bytes.');
    const result = await f.send(input, undefined, 'missing-preflight-history');
    assert.equal(result.success, false);
    assert.equal(f.summaries, 0);
    const after = await f.ledger();
    assert.deepEqual(after.context, before.context);
    assert.equal(after.runs.length, before.runs.length);
    assert.equal(after.records.filter(record => record.event.type === 'context_compaction_attempted').length, 0);
  } finally { await f.dispose(); }
});

for (const mode of ['missing', 'corrupt'] as const) test(`a ${mode} snapshot after paid automatic summary preserves the old context and its charge across restart`, async () => {
  const f = await fixture('responses', { longAnswers: true });
  try {
    const selection = await f.selection();
    assert.equal((await f.send('First exact guide turn', selection)).success, true);
    assert.equal((await f.send('Second historical task')).success, true);
    assert.equal((await f.send('Third historical task')).success, true);
    const input = 'Continue this captured queued message', requestId = 'uncertain-auto-skill-history';
    await f.enableBeforeSend(input);
    const before = await f.ledger(), object = path.join(f.snapshotsDirectory, `${selection.explicitSkillRefs[0].version.fullFileHash}.skill`);
    const original = await fs.readFile(object);
    f.setSummaryHook(() => mode === 'missing' ? fs.rm(object) : fs.writeFile(object, 'Changed during paid automatic summary.'));
    const result = await f.send(input, undefined, requestId);
    assert.equal(result.success, false);
    assert.equal(f.summaries, 1);
    const failed = await f.ledger();
    assert.deepEqual(failed.context, before.context);
    assert.equal(failed.runs.length, before.runs.length);
    assert.equal(failed.records.filter(record => record.event.type === 'context_compaction_attempted').length, 1);
    assert.equal(failed.records.filter(record => record.event.type === 'context_compacted').length, 0);
    await fs.writeFile(object, original); f.setSummaryHook(undefined);
    await f.restart();
    assert.equal((await f.send(input, undefined, requestId)).success, false);
    assert.equal((await f.send('A different request cannot repeat that summary charge')).success, false);
    assert.equal(f.summaries, 1);
    const afterRetry = await f.ledger();
    assert.deepEqual(afterRetry.context, before.context);
    assert.equal(afterRetry.records.filter(record => record.event.type === 'context_compaction_attempted').length, 1);
  } finally { await f.dispose(); }
});

test('a current explicit source changed during before-send summary cannot commit historical compaction or start the new run', async () => {
  const f = await fixture('responses', { longAnswers: true });
  try {
    const selection = await f.selection();
    assert.equal((await f.send('First exact guide turn', selection)).success, true);
    assert.equal((await f.send('Second historical task')).success, true);
    assert.equal((await f.send('Third historical task')).success, true);
    const input = 'Continue with the exact currently selected guide'; await f.enableBeforeSend(input);
    const before = await f.ledger();
    f.setSummaryHook(() => f.writeGuide(newGuide));
    const result = await f.send(input, selection, 'current-guide-changed-during-summary');
    assert.equal(result.success, false);
    assert.equal(f.summaries, 1);
    const after = await f.ledger();
    assert.deepEqual(after.context, before.context);
    assert.equal(after.runs.length, before.runs.length);
    assert.equal(after.records.filter(record => record.event.type === 'context_compacted').length, 0);
  } finally { await f.dispose(); }
});

test('in-run compaction of a later turn restores the earlier initial-only guide as history without activating it', { timeout: 25000 }, async () => {
  const f = await fixture('responses', { longAnswers: true });
  try {
    const selection = await f.selection();
    assert.equal((await f.send('Initial fixed guide turn', selection)).success, true);
    await fs.rm(f.skillPath);
    await fs.writeFile(path.join(f.project, 'pressure.txt'), 'Recent read evidence. '.repeat(600));
    const budget = 110000;
    await f.configure({ autoCompact: 'before_send_and_during_run', maxInputTokens: budget });
    let phase = 0, largeObservation = '';
    f.setHandler((body, request) => {
      assert.deepEqual(initialActivations(request), []);
      assert.equal(instructionText(body).includes(oldGuide), false);
      if (phase++ === 0) {
        const historyBytes = budget * 0.9 - 8000 - Buffer.byteLength(JSON.stringify(body));
        assert.ok(Number.isSafeInteger(historyBytes) && historyBytes > 20000);
        largeObservation = 'Previously read evidence. '.repeat(Math.ceil(historyBytes / 25)).slice(0, historyBytes);
        return f.call('earlier-pressure-observation', 'read_file', { path: 'fixture.txt' }, largeObservation);
      }
      if (phase === 2) {
        assert.ok(Buffer.byteLength(JSON.stringify(body)) < budget * 0.9);
        return f.call('latest-pressure-read', 'read_file', { path: 'pressure.txt' });
      }
      assert.equal(phase, 3);
      const wire = JSON.stringify(body);
      assert.ok(wire.includes('native_skill_history'));
      assert.equal(occurrences(wire, oldGuide), 1);
      assert.equal(wire.includes(largeObservation), false);
      assert.equal(wire.includes('earlier-pressure-observation'), false);
      assert.equal(wire.includes('latest-pressure-read'), true);
      return f.message('Historical guide preserved without activating it in this run.');
    });
    const result = await f.send('Inspect more files and retain historical evidence');
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(f.summaries, 1);
    assert.equal(phase, 3);
    const ledger = await f.ledger();
    assert.equal(ledger.runs.length, 2);
    const compacted = ledger.records.find(record => record.event.type === 'run_context_compacted');
    assert.ok(compacted);
    if (compacted.event.type === 'run_context_compacted') {
      assert.deepEqual(compacted.event.plan.nativeSkills!.manifest.entries, []);
      const historical = compacted.event.plan.historicalSkills!;
      assert.equal(historical.manifest.entries.length, 1);
      assert.deepEqual(historical.manifest.entries[0].version, selection.explicitSkillRefs[0].version);
      assert.equal(historical.manifest.entries[0].identity.runId, ledger.runs[0].identity.runId);
      assert.equal(historical.bodies[0].body, oldGuide);
    }
    requireCompleteContext(ledger.context!);
    assert.deepEqual(f.server.errors, []);
  } finally { await f.dispose(); }
});
