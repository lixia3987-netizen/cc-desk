import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getToolPreparationFeedback, runAgent, type JsonValue, type ModelContext } from '@cc-desk/agent-core';
import { createNativeModel, nativeModelProtocol, type NativeModelOptions } from '@cc-desk/agent-node/native-model';
import { requireCompleteContext } from '@cc-desk/agent-node/context-maintenance';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { SkillRegistry } from '@cc-desk/agent-node/skill-registry';
import { SkillSnapshotStore } from '@cc-desk/agent-node/skill-snapshots';
import { SkillToolPort } from '@cc-desk/agent-node/skill-tools';
import type { NativeSkillSubmission } from '@cc-desk/contracts/native-skills';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { NativeSkillRuntime } from '../src/main/engines/native/skill-runtime';
import { createNativeConfig } from '../src/main/engines/native/config';
// @ts-expect-error Shared local HTTP/SSE fixture has no TypeScript declaration.
import { startResponsesFixture, functionCall, assistantMessage } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';
// @ts-expect-error Shared local HTTP/SSE fixture has no TypeScript declaration.
import { startChatCompletionsFixture } from '../../../packages/agent-node/tests/fixtures/chat-completions-server.mjs';
// @ts-expect-error Shared local HTTP/SSE fixture has no TypeScript declaration.
import { startAnthropicFixture } from '../../../packages/agent-node/tests/fixtures/anthropic-server.mjs';

type Protocol = 'responses' | 'chat-completions' | 'anthropic';
type WireBody = { input?: any[]; messages?: any[]; tools?: any[]; instructions?: string; system?: unknown };
type Mode = 'normal' | 'source-changed' | 'snapshot-missing' | 'snapshot-corrupt' | 'guides-exceed-budget'
  | 'snapshot-missing-during-summary' | 'snapshot-corrupt-during-summary';
const secret = 'sk-native-skill-compaction-local-fixture';
const input = 'Use the exact engineering guides, inspect fixture.txt, and create observed.txt after retaining all guide constraints.';
const summary = 'Historical task: inspect the file and preserve guide constraints. The inspection completed; create observed.txt next. Human acceptance remains unverified.';
const fixedGuide = 'FIXED_GUIDE_BEGIN Preserve unrelated user files and require human acceptance. FIXED_GUIDE_END';
const removedGuide = `REMOVED_GUIDE_BEGIN ${'Complete first guide clause; preserve exact constraints. '.repeat(220)}REMOVED_GUIDE_END`;
const retainedGuide = `RETAINED_GUIDE_BEGIN ${'Complete latest guide clause; do not infer tool authority. '.repeat(220)}RETAINED_GUIDE_END`;
const budget = 110000;
const unknownCache = { cacheReadInputTokens: null, cacheCreationInputTokens: null, nonCachedInputTokens: null };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const occurrences = (text: string, value: string) => text.split(value).length - 1;

function contextItems(body: WireBody): any[] { return body.input ?? body.messages!.filter(item => item.role !== 'system'); }
function pairCounts(body: WireBody, callId: string) {
  const items = contextItems(body);
  const calls = items.reduce((sum, item) => sum + (item.type === 'function_call' && item.call_id === callId ? 1 : 0)
    + (item.tool_calls?.filter((call: any) => call.id === callId).length ?? 0)
    + (Array.isArray(item.content) ? item.content.filter((block: any) => block.type === 'tool_use' && block.id === callId).length : 0), 0);
  const results = items.reduce((sum, item) => sum + (item.type === 'function_call_output' && item.call_id === callId ? 1 : 0)
    + (item.role === 'tool' && item.tool_call_id === callId ? 1 : 0)
    + (Array.isArray(item.content) ? item.content.filter((block: any) => block.type === 'tool_result' && block.tool_use_id === callId).length : 0), 0);
  return { calls, results };
}

async function fixture(protocol: Protocol, options: { mode?: Mode; autoCompact?: 'off' | 'before_send' | 'before_send_and_during_run' } = {}) {
  const inputBudget = options.mode === 'guides-exceed-budget' ? 90000 : budget;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-skill-compaction-'));
  const project = path.join(directory, 'project'), data = path.join(directory, 'data');
  const snapshotsDirectory = path.join(data, 'native', 'skill-snapshots');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'fixture.txt'), 'original project evidence\n');
  await fs.writeFile(path.join(project, 'AGENTS.md'), 'Preserve user files and never invent a verification result.');
  const guides = [{ name: 'fixed', body: fixedGuide }, { name: 'removed', body: removedGuide }, { name: 'retained', body: retainedGuide }]
    .map(guide => options.mode === 'guides-exceed-budget' ? { ...guide, body: guide.body.padEnd(24 * 1024, 'x') } : guide);
  for (const guide of guides) {
    const file = path.join(project, '.agents', 'skills', guide.name, 'SKILL.md');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `---\nname: ${guide.name}\ndescription: Exact ${guide.name} engineering guide.\n---\n${guide.body}`);
  }
  const registry = () => new SkillRegistry({ projectId, projectRoot: project, excludedRoots: [data], sources: [
    { id: 'project-agents', scope: 'project', kind: 'project-agents', rootPath: '.agents/skills', enabled: true, revision: 1 },
  ] });
  const id = randomUUID(), projectId = randomUUID(), conversationId = randomUUID();
  const catalog = await registry().discover();
  const entries = Object.fromEntries(catalog.entries.map(entry => [entry.name, entry]));
  const loaded = Object.fromEntries(await Promise.all(catalog.entries.map(async entry => [entry.name, await registry().loadCatalogSkill(entry)])));
  const submission: NativeSkillSubmission = { schemaVersion: 1, explicitSkillRefs: [{ skillId: entries.fixed.skillId,
    catalogRevision: catalog.revision, version: loaded.fixed.version }], excludedSkillIds: [] };
  let ordinary = 0, summaries = 0, barrierChecks = 0, history = '', pressureBytes = 0, activeMode: string | undefined;
  let lastModel: NativeModelOptions | undefined, lastOutputLimit = 0;
  let replacementContext: ModelContext | undefined;
  const call = (callId: string, name: string, args: unknown, text = '') => protocol === 'responses'
    ? { output: [...(text ? [assistantMessage(`${callId}-notes`, text, 'commentary')] : []), functionCall(callId, name, args)] }
    : protocol === 'chat-completions'
      ? { message: { role: 'assistant', content: text || null, tool_calls: [{ id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }
      : { content: [...(text ? [{ type: 'text', text }] : []), { type: 'tool_use', id: callId, name, input: args }] };
  const message = (text: string) => protocol === 'responses' ? { output: [assistantMessage('final', text)] }
    : protocol === 'chat-completions' ? { message: { role: 'assistant', content: text } } : { content: [{ type: 'text', text }] };
  const serverFactory = protocol === 'responses' ? startResponsesFixture : protocol === 'chat-completions' ? startChatCompletionsFixture : startAnthropicFixture;
  const server = await serverFactory({ assertReplay: false, handler: async ({ body }: { body: WireBody }) => {
    if (!body.tools?.length) { summaries++; return message(summary); }
    requireCompleteContext({ protocol: nativeModelProtocol(protocol), items: contextItems(body) });
    assert.ok(body.tools.every(tool => !['delegate_review', 'delegate_implement', 'recover_agent'].includes(tool.name ?? tool.function?.name)));
    const index = ordinary++;
    if (index === 0) return call('load-removed', 'load_skill', { skillId: entries.removed.skillId, catalogRevision: catalog.revision });
    if (index === 1) {
      if (options.mode === 'guides-exceed-budget') {
        assert.ok(Buffer.byteLength(JSON.stringify(body)) < inputBudget * 0.9, 'first complete dynamic guide must fit without maintenance');
        return call('load-retained', 'load_skill', { skillId: entries.retained.skillId, catalogRevision: catalog.revision });
      }
      // Use the real adapter payload, including all tools and fixed instructions.
      // The read receipt keeps the next request below 90%; the following complete
      // 12 KiB guide crosses it while the minimum exact replacement still fits.
      const historyBytes = inputBudget * 0.9 - 8000 - Buffer.byteLength(JSON.stringify(body));
      assert.ok(Number.isSafeInteger(historyBytes) && historyBytes > 20000);
      history = 'historical file inspection observation '.repeat(Math.ceil(historyBytes / 38)).slice(0, historyBytes);
      assert.equal(Buffer.byteLength(history), historyBytes);
      return call('read-before-compaction', 'read_file', { path: 'fixture.txt' }, history);
    }
    if (index === 2) {
      assert.notEqual(options.mode, 'guides-exceed-budget', 'unavoidable full guide input must block before a third ordinary request');
      assert.ok(Buffer.byteLength(JSON.stringify(body)) < inputBudget * 0.9, 'the read batch must not compact before the latest guide is loaded');
      if (options.mode === 'snapshot-missing') await fs.rm(path.join(snapshotsDirectory, `${loaded.removed.version.fullFileHash}.skill`));
      if (options.mode === 'snapshot-corrupt') await fs.writeFile(path.join(snapshotsDirectory, `${loaded.removed.version.fullFileHash}.skill`), 'corrupt historical guide');
      return call('load-retained', 'load_skill', { skillId: entries.retained.skillId, catalogRevision: catalog.revision });
    }
    if (options.autoCompact === 'off' || options.autoCompact === 'before_send') return message('No in-run compaction authorized.');
    if (index === 3) {
      const wire = JSON.stringify(body);
      assert.ok(wire.includes(summary)); assert.ok(wire.includes('native_skill_continuity'));
      assert.equal(occurrences(wire, removedGuide), 1, 'the complete removed guide must survive independently of the summary');
      assert.equal(occurrences(wire, retainedGuide), 1, 'the retained complete load receipt must not be duplicated');
      assert.equal(occurrences(wire, fixedGuide), 1, 'fixed guide appears only in unchanged instructions');
      assert.equal(JSON.stringify(contextItems(body)).includes(fixedGuide), false);
      assert.equal(wire.includes(history), false);
      assert.deepEqual(pairCounts(body, 'load-removed'), { calls: 0, results: 0 });
      assert.deepEqual(pairCounts(body, 'load-retained'), { calls: 1, results: 1 });
      return call('write-after-replacement-observation', 'apply_patch', { path: 'observed.txt', content: 'exact guides observed\n', expectedHash: null });
    }
    assert.equal(index, 4);
    return message('Exact guides observed; edit complete, human acceptance still unverified.');
  } });
  const store = new StateStore(data), connections = new ConnectionStore(data), events = new ExecutionEvents();
  const first = connections.upsert({ name: 'skill compaction fixture', protocol, baseURL: server.baseURL, model: 'fixture-model', enabled: true,
    allowLoopbackHttp: true, auth: { mode: 'memory' } });
  const connection = connections.setCredential({ id: first.id, revision: first.revision, mode: 'memory', secret });
  store.change(state => {
    state.projects.push({ id: projectId, path: project, name: 'project', createdAt: new Date().toISOString() });
    state.sessions.push({ id, projectId, title: 'skill compaction', kind: 'agent', cwd: project,
      execution: { providerId: 'native', mode: 'structured', conversationId },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: connection.id, maxInputTokens: inputBudget,
        autoCompact: options.autoCompact ?? 'before_send_and_during_run' } }),
      started: false, archived: false, status: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  const runtime = new NativeSkillRuntime({ registry, snapshots: new SkillSnapshotStore({ directory: snapshotsDirectory }), forbiddenValues: () => [secret] });
  await runtime.prepareSubmission(id, submission);
  const worker: NonNullable<NativeExecutorOptions['worker']> = async request => {
    const model = createNativeModel(request.model);
    if (request.request.configuration.purpose !== 'context_summary') { lastModel = request.model; lastOutputLimit = request.request.budget!.maxOutputTokens ?? 4096; }
    const maintenance = request.contextMaintenance;
    const result = await runAgent({ ...request.request, signal: request.signal }, {
      model, tools: request.tools, store: request.store, approvals: request.approvals,
      ...(maintenance ? { contextMaintenance: { maintain: async candidate => {
        const estimate = model.estimateInputUsage?.(candidate.context, candidate.budget.maxOutputTokens);
        if (estimate && estimate.serializedBytes >= inputBudget * 0.9) pressureBytes = estimate.serializedBytes;
        const result = await maintenance.maintain(candidate);
        if (result.kind === 'compacted') {
          replacementContext = structuredClone(result.context);
          activeMode = executor.snapshot(id).nativeContextMaintenance?.autoCompact?.mode;
          await assert.rejects(request.tools.prepare({ id: 'premature-replacement-write', name: 'apply_patch',
            arguments: JSON.stringify({ path: 'premature.txt', content: 'must not happen', expectedHash: null }) },
          { identity: request.request.identity, policyRevision: request.request.policyRevision, signal: request.signal, maxOutputBytes: 65536 }), error => {
            assert.deepEqual(getToolPreparationFeedback(error), { error: 'skill_precondition_failed', code: 'context_unconfirmed', action: 'continue_model' });
            return true;
          });
          barrierChecks++;
        }
        return result;
      } } } : {}),
      host: { now: Date.now, digest: hash, emit: request.onEvent, deadline: (ms, parent) => {
        const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, ms);
        parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort();
        return { signal: controller.signal, dispose() { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
      } },
    });
    if (request.request.configuration.purpose === 'context_summary' && options.mode === 'source-changed') {
      await fs.appendFile(path.join(project, '.agents', 'skills', 'removed', 'SKILL.md'), ' changed during paid summary');
    }
    if (request.request.configuration.purpose === 'context_summary' && options.mode === 'snapshot-missing-during-summary') {
      await fs.rm(path.join(snapshotsDirectory, `${loaded.removed.version.fullFileHash}.skill`));
    }
    if (request.request.configuration.purpose === 'context_summary' && options.mode === 'snapshot-corrupt-during-summary') {
      await fs.writeFile(path.join(snapshotsDirectory, `${loaded.removed.version.fullFileHash}.skill`), 'corrupt after paid summary');
    }
    return result;
  };
  let executor = new NativeStructuredExecutor(store, connections, events, { worker, skills: runtime });
  await executor.initialize();
  const approved = new Set<string>();
  const off = events.subscribe(() => {
    for (const attention of executor.attention()) if (!approved.has(attention.requestId)) {
      approved.add(attention.requestId); queueMicrotask(() => executor.respond(id, attention.requestId, { behavior: 'allow' }));
    }
  });
  return { id, project, server, loaded, submission, get executor() { return executor; }, get ordinary() { return ordinary; }, get summaries() { return summaries; },
    get barrierChecks() { return barrierChecks; }, get pressureBytes() { return pressureBytes; }, get replacementContext() { return replacementContext; }, get activeMode() { return activeMode; },
    wireBytes(context: ModelContext) { assert.ok(lastModel); return createNativeModel(lastModel).estimateInputUsage!(context, lastOutputLimit).serializedBytes; },
    fullGuideInputLowerBoundBytes() {
      assert.ok(lastModel);
      const model = createNativeModel(lastModel), text = loaded.removed.body + loaded.retained.body;
      const guideItem: JsonValue = protocol === 'responses' ? { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
        : protocol === 'chat-completions' ? { role: 'assistant', content: text } : { role: 'assistant', content: [{ type: 'text', text }] };
      // This omits the required continuity metadata and retained tool call/result
      // envelope, so even this lower bound exceeding the limit proves no exact
      // legal replacement could fit the unchanged instructions and tools.
      return model.estimateInputUsage!({ protocol: nativeModelProtocol(protocol), items: [...model.userItems(input), guideItem] }, lastOutputLimit).serializedBytes;
    },
    send: () => executor.send(id, input, [], undefined, { requestId: 'skill-compaction-submission', nativeSkills: submission }),
    async ledger() {
      const ledger = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
      try { return { runs: ledger.listRuns(), records: ledger.replay(), context: ledger.loadContext(), head: ledger.head, recovery: ledger.getRecoveryReport() }; }
      finally { await ledger.close(); }
    },
    async restart() { await executor.shutdown(); executor = new NativeStructuredExecutor(store, connections, events, { worker, skills: runtime }); await executor.initialize(); },
    async dispose() { off(); await executor.shutdown().catch(() => {}); await server.close(); store.flush(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

for (const protocol of ['responses', 'chat-completions', 'anthropic'] as const) test(`${protocol}: skill compaction restores exact full guides and unlocks effects only after a new durable response`, { timeout: 25000 }, async () => {
  const f = await fixture(protocol);
  try {
    const result = await f.send(); assert.equal(result.success, true, JSON.stringify(result)); assert.deepEqual(f.server.errors, []);
    assert.equal(f.summaries, 1); assert.equal(f.ordinary, 5); assert.equal(f.barrierChecks, 1);
    assert.equal(f.activeMode, 'during_run');
    assert.ok(f.pressureBytes >= budget * 0.9 && f.pressureBytes <= budget, `actual wire pressure ${f.pressureBytes} must cross 90% without exceeding the original budget`);
    assert.ok(f.replacementContext); requireCompleteContext(f.replacementContext);
    assert.ok(f.wireBytes(f.replacementContext) < budget * 0.9);
    assert.equal(await fs.readFile(path.join(f.project, 'observed.txt'), 'utf8'), 'exact guides observed\n');
    await assert.rejects(fs.stat(path.join(f.project, 'premature.txt')), { code: 'ENOENT' });
    const ledger = await f.ledger(), run = ledger.runs[0];
    assert.equal(ledger.runs.length, 1); assert.equal(ledger.recovery, null);
    assert.equal(run.configuration.effectiveAutoCompact, 'during_run');
    assert.equal(run.result!.modelRequests, 6);
    assert.deepEqual(run.result!.usage, protocol === 'anthropic'
      ? { outputTokens: 42, ...unknownCache, nonCachedInputTokens: 66 }
      : { inputTokens: 66, outputTokens: 42, totalTokens: 108, ...unknownCache });
    assert.equal(ledger.records.filter(record => record.event.type === 'run_context_compaction_attempted').length, 1);
    assert.equal(ledger.records.filter(record => record.event.type === 'run_context_compacted').length, 1);
    assert.equal(ledger.records.filter(record => record.event.type === 'model_response').length, 5);
    const compacted = ledger.records.find(record => record.event.type === 'run_context_compacted')!;
    assert.equal(compacted.event.type, 'run_context_compacted');
    if (compacted.event.type === 'run_context_compacted') {
      const section = compacted.event.plan.nativeSkills!;
      assert.ok(section);
      assert.deepEqual(section.bodies, [{ skillId: f.loaded.removed.version.skillId, body: removedGuide }]);
      for (const [name, placement] of [['fixed', 'initial_instructions'], ['removed', 'compacted_context'], ['retained', 'retained_receipt']] as const) {
        const entry = section.manifest.entries.find(item => item.skillId === f.loaded[name].version.skillId)!;
        assert.equal(entry.placement, placement); assert.deepEqual(entry.version, f.loaded[name].version);
      }
    }
    const response = ledger.records.find(record => record.seq > compacted.seq && record.event.type === 'model_response')!;
    const write = ledger.records.find(record => record.event.type === 'tool_prepared' && record.event.prepared.call.id === 'write-after-replacement-observation')!;
    assert.ok(compacted.seq < response.seq && response.seq < write.seq);
    assert.equal(ledger.records.filter(record => record.event.type === 'tool_completed' && record.event.call.id === 'load-retained').length, 1);
    assert.equal(ledger.records.some(record => record.event.type === 'tool_prepared' && record.event.prepared.call.id === 'premature-replacement-write'), false);
    assert.equal(JSON.stringify(ledger).includes(secret), false);
    assert.deepEqual(f.executor.snapshot(f.id).nativeContextMaintenance!.inTurn!.summaryUsage,
      protocol === 'anthropic' ? { outputTokens: 7 } : { inputTokens: 11, outputTokens: 7 });
    const ordinaryRequests = f.server.requests.filter((body: WireBody) => body.tools?.length);
    const instructions = (body: WireBody) => protocol === 'responses' ? body.instructions : protocol === 'chat-completions' ? body.messages![0] : body.system;
    assert.deepEqual(instructions(ordinaryRequests[0]), instructions(ordinaryRequests[3]));
    const requests = f.server.requests.length;
    await f.restart(); assert.equal((await f.send()).success, true); assert.equal(f.server.requests.length, requests);
    assert.deepEqual((await f.ledger()).context, ledger.context);
    const next = await f.executor.send(f.id, 'A fresh turn still needs explicit continuity support.', [], undefined, { requestId: 'skill-compaction-next-turn' });
    assert.equal(next.success, false); assert.match(next.error!, /跨回合连续性尚未开放/);
    await assert.rejects(f.executor.compactContext(f.id, ledger.head!.hash), /压缩连续性尚未开放/);
    assert.equal(f.server.requests.length, requests);
  } finally { await f.dispose(); }
});

for (const mode of ['snapshot-missing', 'snapshot-corrupt'] as const) test(`${mode}: exact skill CAS preflight fails before reserving or charging a summary`, { timeout: 20000 }, async () => {
  const f = await fixture('responses', { mode });
  try {
    const result = await f.send(); assert.equal(result.success, false); assert.deepEqual(f.server.errors, []);
    assert.equal(f.ordinary, 3); assert.equal(f.summaries, 0); assert.equal(f.barrierChecks, 0);
    const ledger = await f.ledger(); assert.equal(ledger.runs[0].result!.modelRequests, 3);
    assert.equal(ledger.records.filter(record => record.event.type === 'run_context_compaction_attempted').length, 0);
    assert.equal(ledger.records.filter(record => record.event.type === 'run_context_compacted').length, 0);
    assert.equal(JSON.stringify(ledger.context).includes(summary), false);
    assert.ok(JSON.stringify(ledger.context).includes(removedGuide)); requireCompleteContext(ledger.context!);
    await assert.rejects(fs.stat(path.join(f.project, 'observed.txt')), { code: 'ENOENT' });
  } finally { await f.dispose(); }
});

test('a skill source changed during the real summary response prevents replacement and all later effects', { timeout: 20000 }, async () => {
  const f = await fixture('responses', { mode: 'source-changed' });
  try {
    const result = await f.send(); assert.equal(result.success, false); assert.deepEqual(f.server.errors, []);
    assert.equal(f.ordinary, 3); assert.equal(f.summaries, 1); assert.equal(f.barrierChecks, 0);
    const ledger = await f.ledger(); assert.equal(ledger.runs[0].result!.modelRequests, 4);
    assert.deepEqual(ledger.runs[0].result!.usage, { inputTokens: 44, outputTokens: 28, totalTokens: 72, ...unknownCache });
    assert.equal(ledger.records.filter(record => record.event.type === 'run_context_compaction_attempted').length, 1);
    assert.equal(ledger.records.filter(record => record.event.type === 'run_context_compaction_failed').length, 1);
    assert.equal(ledger.records.filter(record => record.event.type === 'run_context_compacted').length, 0);
    assert.equal(JSON.stringify(ledger.context).includes(summary), false); assert.ok(JSON.stringify(ledger.context).includes(removedGuide));
    await assert.rejects(fs.stat(path.join(f.project, 'observed.txt')), { code: 'ENOENT' });
  } finally { await f.dispose(); }
});

test('lost skill compaction commit acknowledgment cannot resume requests or replay the paid summary after restart', { timeout: 20000 }, async () => {
  const f = await fixture('responses'), original = NativeRunStore.prototype.commitRunCompaction;
  let injected = false;
  NativeRunStore.prototype.commitRunCompaction = async function (...args) {
    const receipt = await original.apply(this, args);
    if (args[0].sessionId === f.id) { injected = true; throw new Error('Injected acknowledgment loss after durable exact skill replacement'); }
    return receipt;
  };
  try {
    const result = await f.send(); assert.equal(result.success, false); assert.equal(injected, true);
    assert.equal(f.summaries, 1); assert.equal(f.ordinary, 3); assert.equal(f.barrierChecks, 0);
    const ledger = await f.ledger(); assert.ok(JSON.stringify(ledger.context).includes(summary));
    assert.ok(JSON.stringify(ledger.context).includes(removedGuide)); requireCompleteContext(ledger.context!);
    assert.equal(ledger.records.filter(record => record.event.type === 'run_context_compacted').length, 1);
    assert.equal(ledger.records.some(record => record.event.type === 'run_finished'), false);
    await assert.rejects(fs.stat(path.join(f.project, 'observed.txt')), { code: 'ENOENT' });
    const requests = f.server.requests.length;
    NativeRunStore.prototype.commitRunCompaction = original;
    await f.restart(); assert.equal((await f.send()).success, false); assert.equal(f.server.requests.length, requests);
    assert.deepEqual((await f.ledger()).context, ledger.context);
  } finally { NativeRunStore.prototype.commitRunCompaction = original; await f.dispose(); }
});

test('unavoidable complete guide input exceeding the real wire budget blocks before any summary charge', { timeout: 20000 }, async () => {
  const f = await fixture('responses', { mode: 'guides-exceed-budget' });
  try {
    const result = await f.send(); assert.equal(result.success, false); assert.deepEqual(f.server.errors, []);
    assert.equal(f.ordinary, 2); assert.equal(f.summaries, 0); assert.equal(f.barrierChecks, 0);
    assert.ok(f.pressureBytes > 90000, `complete actual wire payload ${f.pressureBytes} must exceed the original 90k budget`);
    assert.ok(f.fullGuideInputLowerBoundBytes() > 90000, 'full guides alone with unchanged instructions/tools cannot fit, even without continuity or tool pair overhead');
    const ledger = await f.ledger(), run = ledger.runs[0];
    assert.equal(run.result!.modelRequests, 2);
    assert.ok(['context_maintenance_unhelpful', 'input_budget_exhausted'].includes(run.result!.reason), run.result!.reason);
    assert.deepEqual(run.result!.usage, { inputTokens: 22, outputTokens: 14, totalTokens: 36, ...unknownCache });
    assert.equal(ledger.records.filter(record => record.event.type === 'run_context_compaction_attempted').length, 0);
    assert.equal(ledger.records.filter(record => record.event.type === 'run_context_compacted').length, 0);
    assert.equal(JSON.stringify(ledger.context).includes(summary), false); requireCompleteContext(ledger.context!);
    assert.ok(typeof run.configuration.modelInstructions === 'string' && run.configuration.modelInstructions.includes(f.loaded.fixed.body));
    for (const [name, callId] of [['removed', 'load-removed'], ['retained', 'load-retained']] as const) {
      const completed = ledger.records.find(record => record.event.type === 'tool_completed' && record.event.call.id === callId)!;
      assert.equal(completed.event.type, 'tool_completed');
      if (completed.event.type === 'tool_completed') {
        assert.equal(completed.event.result.status, 'completed'); assert.notEqual(completed.event.result.truncated, true);
        const output = completed.event.result.output as { complete: boolean; body: string; version: unknown };
        assert.equal(output.complete, true); assert.equal(output.body, f.loaded[name].body);
        assert.deepEqual(output.version, f.loaded[name].version); assert.equal(Buffer.byteLength(output.body), 24 * 1024);
        assert.ok(JSON.stringify(ledger.context).includes(output.body), 'the old complete load receipt remains available without truncation');
      }
    }
    await assert.rejects(fs.stat(path.join(f.project, 'observed.txt')), { code: 'ENOENT' });
  } finally { await f.dispose(); }
});

for (const mode of ['snapshot-missing-during-summary', 'snapshot-corrupt-during-summary'] as const) test(`${mode}: paid summary cannot commit without the exact historical CAS object`, { timeout: 20000 }, async () => {
  const f = await fixture('responses', { mode });
  try {
    const result = await f.send(); assert.equal(result.success, false); assert.deepEqual(f.server.errors, []);
    assert.equal(f.ordinary, 3); assert.equal(f.summaries, 1); assert.equal(f.barrierChecks, 0);
    const ledger = await f.ledger(), run = ledger.runs[0].result!;
    assert.equal(run.modelRequests, 4); assert.equal(run.reason, 'context_maintenance_failed');
    assert.deepEqual(run.usage, { inputTokens: 44, outputTokens: 28, totalTokens: 72, ...unknownCache });
    assert.equal(ledger.records.filter(record => record.event.type === 'run_context_compaction_attempted').length, 1);
    assert.equal(ledger.records.filter(record => record.event.type === 'run_context_compaction_failed').length, 1);
    assert.equal(ledger.records.filter(record => record.event.type === 'run_context_compacted').length, 0);
    assert.equal(JSON.stringify(ledger.context).includes(summary), false);
    assert.ok(JSON.stringify(ledger.context).includes(removedGuide)); assert.ok(JSON.stringify(ledger.context).includes(retainedGuide));
    requireCompleteContext(ledger.context!);
    await assert.rejects(fs.stat(path.join(f.project, 'observed.txt')), { code: 'ENOENT' });
  } finally { await f.dispose(); }
});

test('an observation hook failure after durable replacement stops without relabeling the committed compaction or replaying it', { timeout: 20000 }, async () => {
  const f = await fixture('responses'), original = SkillToolPort.prototype.observeContextReplacement;
  let injected = false;
  SkillToolPort.prototype.observeContextReplacement = function (...args) {
    if (args[1].identity.sessionId === f.id) { injected = true; throw new Error('Injected observation reset failure after durable replacement'); }
    return original.apply(this, args);
  };
  try {
    const result = await f.send(); assert.equal(result.success, false); assert.equal(injected, true); assert.deepEqual(f.server.errors, []);
    assert.equal(f.ordinary, 3); assert.equal(f.summaries, 1); assert.equal(f.barrierChecks, 0);
    const ledger = await f.ledger(); assert.ok(JSON.stringify(ledger.context).includes(summary));
    assert.ok(JSON.stringify(ledger.context).includes(removedGuide)); requireCompleteContext(ledger.context!);
    assert.equal(ledger.records.filter(record => record.event.type === 'run_context_compacted').length, 1);
    assert.equal(ledger.records.filter(record => record.event.type === 'run_context_compaction_failed').length, 0, 'a committed replacement cannot be rewritten as a failed summary');
    assert.equal(ledger.records.some(record => record.event.type === 'run_finished'), false);
    await assert.rejects(fs.stat(path.join(f.project, 'observed.txt')), { code: 'ENOENT' });
    const requests = f.server.requests.length;
    SkillToolPort.prototype.observeContextReplacement = original;
    await f.restart(); assert.equal((await f.send()).success, false); assert.equal(f.server.requests.length, requests);
    assert.deepEqual((await f.ledger()).context, ledger.context);
  } finally { SkillToolPort.prototype.observeContextReplacement = original; await f.dispose(); }
});

for (const autoCompact of ['off', 'before_send'] as const) test(`${autoCompact}: skill runtime never starts an in-run paid summary`, { timeout: 20000 }, async () => {
  const f = await fixture('responses', { autoCompact });
  try {
    await f.send(); assert.equal(f.summaries, 0); assert.deepEqual(f.server.errors, []);
    assert.equal((await f.ledger()).records.filter(record => record.event.type === 'run_context_compaction_attempted').length, 0);
  } finally { await f.dispose(); }
});
