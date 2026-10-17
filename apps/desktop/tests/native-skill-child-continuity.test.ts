import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getToolPreparationFeedback, runAgent, type ApprovalPort, type JsonValue, type ModelContext, type RunIdentity, type RunStore, type ToolPort } from '@cc-desk/agent-core';
import { createNativeModel, nativeModelProtocol } from '@cc-desk/agent-node/native-model';
import { requireCompleteContext } from '@cc-desk/agent-node/context-maintenance';
import { composeToolPorts } from '@cc-desk/agent-node/mcp-tools';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { SkillRegistry } from '@cc-desk/agent-node/skill-registry';
import { SkillSnapshotStore } from '@cc-desk/agent-node/skill-snapshots';
import type { NativeSkillSubmission } from '@cc-desk/contracts/native-skills';
import { NativeSkillRuntime, type NativeSkillInheritanceManifest } from '../src/main/engines/native/skill-runtime';
import { runNativeAgentChild, NativeAgentChildNotStartedError, type NativeAgentChildRunnerOptions } from '../src/main/engines/native/agent-child-runner';
import type { NativeAgentChildInput } from '../src/main/engines/native/agent-delegation';
import { createNativeChildBudget } from '../src/main/engines/native/child-budget';
import { parseNativeConfig } from '../src/main/engines/native/config';
import type { NativeWorkerOptions } from '../src/main/engines/native/worker-host';
// @ts-expect-error Shared local HTTP/SSE fixtures have no TypeScript declarations.
import { startResponsesFixture, functionCall, assistantMessage } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';
// @ts-expect-error Shared local HTTP/SSE fixtures have no TypeScript declarations.
import { startChatCompletionsFixture } from '../../../packages/agent-node/tests/fixtures/chat-completions-server.mjs';
// @ts-expect-error Shared local HTTP/SSE fixtures have no TypeScript declarations.
import { startAnthropicFixture } from '../../../packages/agent-node/tests/fixtures/anthropic-server.mjs';

type Protocol = 'responses' | 'chat-completions' | 'anthropic';
type WireBody = { input?: any[]; messages?: any[]; tools?: any[]; instructions?: string; system?: unknown };
const secret = 'sk-child-skill-local-fixture';
const fixedBody = 'CHILD_FIXED_GUIDE_BEGIN Preserve unrelated user files. CHILD_FIXED_GUIDE_END';
const dynamicBody = 'CHILD_DYNAMIC_GUIDE_BEGIN Record actual evidence and limitations. CHILD_DYNAMIC_GUIDE_END';
const optionalBody = 'CHILD_OPTIONAL_GUIDE_BEGIN Check current material before drawing conclusions. CHILD_OPTIONAL_GUIDE_END';
const excludedBody = 'CHILD_EXCLUDED_GUIDE_BEGIN This excluded guide must never be selected. CHILD_EXCLUDED_GUIDE_END';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const identity = (): RunIdentity => ({ sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 });
const approved: ApprovalPort = { request: async request => ({ binding: request.binding, decision: 'approved', expiresAt: request.expiresAt }) };
const instructions = (body: WireBody): string => body.instructions ?? (typeof body.system === 'string' ? body.system
  : JSON.stringify(body.system ?? body.messages?.filter(item => item.role === 'system') ?? ''));
const wireItems = (body: WireBody): JsonValue[] => body.input ?? body.messages!.filter(item => item.role !== 'system');

/** Real host runner, core, protocol adapter, HTTP fixture, ledger and CAS; no synthetic worker results. */
async function fixture(t: { after(fn: () => Promise<void>): void }, protocol: Protocol = 'responses', options: { dynamicParent?: boolean } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-child-skills-')));
  const parentRoot = path.join(directory, 'parent'), childRoot = path.join(directory, 'child'), dataDirectory = path.join(directory, 'data');
  const snapshotsDirectory = path.join(dataDirectory, 'native', 'skill-snapshots');
  const projectId = randomUUID(), parentIdentity = identity(), parentTaskId = randomUUID(), abort = new AbortController();
  await fs.mkdir(parentRoot, { recursive: true });
  await fs.writeFile(path.join(parentRoot, 'AGENTS.md'), 'Preserve user files and report only actual local verification.');
  await fs.writeFile(path.join(parentRoot, 'fixture.txt'), 'original material\n');
  for (const [name, body] of [['fixed', fixedBody], ['dynamic', dynamicBody], ['optional', optionalBody], ['excluded', excludedBody]]) {
    const file = path.join(parentRoot, '.agents', 'skills', name, 'SKILL.md');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `---\nname: ${name}\ndescription: Exact ${name} engineering guide.\n---\n${body}`);
  }
  await fs.cp(parentRoot, childRoot, { recursive: true });
  const registry = () => new SkillRegistry({ projectId, projectRoot: parentRoot, excludedRoots: [dataDirectory], sources: [
    { id: 'project-agents', scope: 'project', kind: 'project-agents', rootPath: '.agents/skills', enabled: true, revision: 1 },
  ] });
  const catalog = await registry().discover(), entries = Object.fromEntries(catalog.entries.map(entry => [entry.name, entry]));
  const loaded = await registry().loadCatalogSkill(entries.fixed);
  const submission: NativeSkillSubmission = { schemaVersion: 1, explicitSkillRefs: [{ skillId: loaded.version.skillId, version: loaded.version, catalogRevision: catalog.revision }], excludedSkillIds: [entries.excluded.skillId] };
  const snapshots = new SkillSnapshotStore({ directory: snapshotsDirectory });
  const runtime = new NativeSkillRuntime({ registry, snapshots, forbiddenValues: () => [secret] });
  await runtime.prepareSubmission(parentIdentity.sessionId, submission);
  const call = (id: string, name: string, input: unknown, text = '') => protocol === 'responses'
    ? { output: [...(text ? [assistantMessage(`${id}-notes`, text)] : []), functionCall(id, name, input)] }
    : protocol === 'chat-completions' ? { message: { role: 'assistant', content: text || null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }
      : { content: [...(text ? [{ type: 'text', text }] : []), { type: 'tool_use', id, name, input }] };
  const message = (text: string) => protocol === 'responses' ? { output: [assistantMessage(`answer-${randomUUID()}`, text)] }
    : protocol === 'chat-completions' ? { message: { role: 'assistant', content: text } } : { content: [{ type: 'text', text }] };
  let parentPhase = true, parentRequests = 0, childRequests = 0, summaries = 0;
  let currentWorker: NativeWorkerOptions | undefined;
  let handler: ((body: WireBody, worker: NativeWorkerOptions) => unknown | Promise<unknown>) | undefined;
  let compactedHook: ((worker: NativeWorkerOptions, context: ModelContext) => void | Promise<void>) | undefined;
  const capturedWorkers: NativeWorkerOptions[] = [], bodies: WireBody[] = [];
  const factory = protocol === 'responses' ? startResponsesFixture : protocol === 'chat-completions' ? startChatCompletionsFixture : startAnthropicFixture;
  const server = await factory({ assertReplay: false, handler: ({ body }: { body: WireBody }) => {
    if (parentPhase) {
      const index = parentRequests++;
      if (options.dynamicParent && index === 0) return call('parent-load-dynamic', 'load_skill', { skillId: entries.dynamic.skillId, catalogRevision: catalog.revision });
      if (index === (options.dynamicParent ? 1 : 0)) return call('parent-capture-inheritance', 'capture_inheritance', {});
      return message('Parent evidence captured.');
    }
    assert.ok(currentWorker);
    if (!body.tools?.length) { summaries++; return message('Prior complete child observations summarized; exact guides remain independently retained.'); }
    requireCompleteContext({ protocol: nativeModelProtocol(protocol), items: wireItems(body) });
    bodies.push(structuredClone(body)); childRequests++;
    return handler?.(body, currentWorker) ?? (childRequests % 2 ? call(`child-read-${childRequests}`, 'read_file', { path: 'fixture.txt' }) : message('Child inspected the material.'));
  } });
  const worker = async (request: NativeWorkerOptions) => {
    capturedWorkers.push(request); currentWorker = request; parentPhase = false;
    const model = createNativeModel(request.model), generate = model.generate.bind(model);
    model.generate = candidate => { currentWorker = request; parentPhase = false; return generate(candidate); };
    return runAgent({ ...request.request, signal: request.signal }, {
      model, tools: request.tools, store: request.store, approvals: request.approvals, completionValidation: request.completionValidation,
      ...(request.contextMaintenance ? { contextMaintenance: { maintain: async candidate => {
        const result = await request.contextMaintenance!.maintain(candidate);
        if (result.kind === 'compacted') await compactedHook?.(request, result.context);
        return result;
      } } } : {}),
      host: { now: Date.now, digest, emit: request.onEvent, consumeBudget: request.consumeBudget, deadline: (ms, parent) => {
        const controller = new AbortController(), cancel = () => controller.abort(), timer = setTimeout(cancel, ms);
        parent.addEventListener('abort', cancel, { once: true }); if (parent.aborted) cancel();
        return { signal: controller.signal, dispose() { clearTimeout(timer); parent.removeEventListener('abort', cancel); } };
      } },
    });
  };
  const parentLedger = await NativeRunStore.open({ rootDirectory: path.join(dataDirectory, 'native', 'conversations'), conversationId: parentIdentity.conversationId, forbiddenValues: [secret] });
  let inheritance: NativeSkillInheritanceManifest | undefined;
  let captured!: () => void, captureFailed!: (error: unknown) => void, releaseParent!: () => void;
  const capturedPromise = new Promise<void>((resolve, reject) => { captured = resolve; captureFailed = reject; });
  const releasePromise = new Promise<void>(resolve => { releaseParent = resolve; });
  const parentRun = await runtime.createRun({ sessionId: parentIdentity.sessionId, identity: parentIdentity, submission, baseInstructionBytes: 1024,
    signal: abort.signal, assertOwnership: async () => {} });
  const capture: ToolPort = {
    definitions: [{ name: 'capture_inheritance', description: 'Capture exact committed parent skill evidence for the fixture.', risk: 'read', inputSchema: { type: 'object', additionalProperties: false } }],
    prepare: async (tool, context) => ({ call: tool, definition: capture.definitions[0], input: {}, inputDigest: digest('{}'), policyRevision: context.policyRevision, requiresApproval: false, preconditions: {} }),
    validate: async () => {}, execute: async () => {
      inheritance = await parentRun.prepareInheritance(parentLedger); captured();
      // The actual parent remains live while its delegated children run. A
      // terminal parent is intentionally not an authority for a new child.
      await releasePromise;
      return { status: 'completed', output: { captured: true } };
    },
  };
  const parentTools = composeToolPorts([parentRun.tools, parentRun.tools.guard(capture)]);
  const parentStore: RunStore = {
    beginRun: request => parentLedger.beginRun(request),
    append: async (run, event) => { const receipt = await parentLedger.append(run, event); parentRun.tools.observeCommitted(event, receipt.seq); return receipt; },
    checkpoint: (run, context) => parentLedger.checkpoint(run, context), ensureCapacity: (run, bytes) => parentLedger.ensureCapacity(run, bytes),
  };
  const model = { protocol, baseURL: server.baseURL, model: 'child-skill-fixture', apiKey: secret, allowLoopbackHttp: true };
  const adapter = createNativeModel({ ...model, instructions: parentRun.initialInstructions, toolDefinitions: parentTools.definitions });
  const generateParent = adapter.generate.bind(adapter);
  adapter.generate = request => { parentPhase = true; return generateParent(request); };
  const parentCompletion = runAgent({ identity: parentIdentity, input: 'Capture current committed skill inheritance.', policyRevision: 'parent-policy', signal: abort.signal,
    configuration: JSON.parse(JSON.stringify({ modelInstructions: parentRun.initialInstructions, nativeSkills: submission,
      nativeSkillCatalog: { revision: parentRun.catalogRevision, entries: parentRun.catalog.entries.map(({ skillId, sourceId, relativePath, sourceRevision, sourceFingerprint, metadataHash, format }) =>
        ({ skillId, sourceId, relativePath, sourceRevision, sourceFingerprint, metadataHash, format })), truncated: parentRun.catalog.truncated }, initialNativeSkills: parentRun.tools.snapshot() })),
    budget: { maxModelRequests: 10, maxToolCalls: 10, maxActiveMs: 60000, maxInputTokens: 240000, maxOutputTokens: 4096 } }, {
    model: adapter, tools: parentTools, store: parentStore, approvals: approved,
    host: { now: Date.now, digest, emit() {}, deadline: (_ms, signal) => ({ signal, dispose() {} }) },
  }).then(result => {
    assert.equal(result.status, 'completed', JSON.stringify({ reason: result.reason, serverErrors: server.errors,
      events: parentLedger.replay().slice(-6).map(record => record.event.type === 'tool_completed' ? { type: record.event.type, call: record.event.call.name, result: record.event.result }
        : { type: record.event.type }) }));
    assert.ok(inheritance); return result;
  });
  void parentCompletion.catch(captureFailed);
  t.after(async () => {
    releaseParent();
    try { await parentCompletion; }
    finally { abort.abort(); await parentLedger.close().catch(() => {}); await server.close(); await fs.rm(directory, { recursive: true, force: true }); }
  });
  await capturedPromise; assert.ok(inheritance); parentPhase = false;
  const config = parseNativeConfig({ schemaVersion: 1, options: { autoCompact: 'off', maxInputTokens: 240000, maxModelRequests: 10, maxToolCalls: 20, maxActiveMs: 60000 } });
  const childInput = (overrides: Partial<NativeAgentChildInput> = {}): NativeAgentChildInput => {
    const childIdentity = identity();
    return { identity: childIdentity, childId: randomUUID(), taskId: randomUUID(), parentIdentity, parentTaskId, title: 'Independent child inspection',
      goal: 'Inspect fixture.txt and report actual evidence.', cwd: childRoot, toolPolicy: 'read_only', signal: abort.signal,
      budget: createNativeChildBudget(childIdentity, config, abort.signal), nativeSkills: structuredClone(inheritance!), ...overrides };
  };
  const childOptions: NativeAgentChildRunnerOptions = { dataDirectory, model, config, forbiddenValues: [secret], approvals: approved, assertOwnership: async () => {}, worker, skills: runtime };
  const readChild = async (input: NativeAgentChildInput) => {
    const ledger = await NativeRunStore.open({ rootDirectory: path.join(dataDirectory, 'native', 'conversations'), conversationId: input.identity.conversationId, forbiddenValues: [secret] });
    try { return { runs: ledger.listRuns(), records: ledger.replay(), context: ledger.loadContext(), recovery: ledger.getRecoveryReport() }; }
    finally { await ledger.close(); }
  };
  return { directory, parentRoot, childRoot, dataDirectory, snapshotsDirectory, runtime, snapshots, entries, inheritance: inheritance!, parentIdentity,
    childInput, childOptions, readChild, server, capturedWorkers, bodies, call, message, config,
    get parentRequests() { return parentRequests; }, get childRequests() { return childRequests; }, get summaries() { return summaries; },
    setHandler(value: typeof handler) { handler = value; }, setCompactedHook(value: typeof compactedHook) { compactedHook = value; } };
}

for (const protocol of ['responses', 'chat-completions', 'anthropic'] as const) test(`${protocol}: actual delegated runner rebinds exact inherited guides without copying parent observation or conversation`, { timeout: 25000 }, async t => {
  const f = await fixture(t, protocol, { dynamicParent: true }), input = f.childInput();
  const result = await runNativeAgentChild(input, f.childOptions);
  assert.equal(result.status, 'completed'); assert.equal(result.committed, true);
  const child = await f.readChild(input), run = child.runs[0];
  assert.equal(child.runs.length, 1); assert.equal(child.recovery, null);
  const initial = run.configuration.initialNativeSkills as unknown as { activations: Array<Record<string, any>> };
  assert.equal(initial.activations.length, 2);
  for (const activation of initial.activations) {
    assert.equal(activation.runId, input.identity.runId); assert.equal(activation.requestId, input.identity.requestId);
    assert.equal(activation.receiptSeq, 0);
    assert.equal(activation.offeredToRequestId, undefined); assert.equal(activation.confirmedByResponseId, undefined);
    const original = f.inheritance.versions.find(version => version.skillId === activation.skillId)!;
    assert.ok(original); assert.equal(activation.version.fullFileHash, original.fullFileHash); assert.equal(activation.version.bodyHash, original.bodyHash);
    assert.notEqual(activation.version.sourceFingerprint, original.sourceFingerprint, 'identical copied bytes must bind the actual child file objects');
  }
  const text = instructions(f.bodies[0]);
  assert.equal(text.split(fixedBody).length - 1, 1); assert.equal(text.split(dynamicBody).length - 1, 1);
  assert.equal(text.includes(excludedBody), false); assert.equal(JSON.stringify(wireItems(f.bodies[0])).includes('parent-capture-inheritance'), false);
  for (const body of f.bodies) for (const tool of body.tools ?? []) assert.equal(['apply_patch', 'run_command', 'start_command', 'delegate_review', 'delegate_implement', 'recover_agent'].includes(tool.name ?? tool.function?.name), false);
  assert.ok(run.configuration.nativeSkillInheritance);
  assert.deepEqual(f.server.errors, []);
});

test('read-only child can load an inherited candidate with its own exact receipt and independent budget', async t => {
  const f = await fixture(t), input = f.childInput(); let step = 0;
  f.setHandler((body, request) => {
    const catalog = request.request.configuration.nativeSkillCatalog as unknown as { revision: string };
    if (++step === 1) return f.call('child-optional-load', 'load_skill', { skillId: f.entries.optional.skillId, catalogRevision: catalog.revision });
    if (step === 2) { assert.ok(JSON.stringify(body).includes(optionalBody)); return f.call('child-material-read', 'read_file', { path: 'fixture.txt' }); }
    return f.message('Actual optional guide and material were read.');
  });
  const result = await runNativeAgentChild(input, f.childOptions), child = await f.readChild(input);
  assert.equal(result.status, 'completed'); assert.equal(result.modelRequests, 3); assert.equal(result.toolCalls, 2);
  assert.deepEqual(input.budget.snapshot(), { modelRequests: 3, toolCalls: 2 });
  const load = child.records.find(record => record.event.type === 'tool_completed' && record.event.call.id === 'child-optional-load');
  assert.ok(load); assert.equal(load.event.type, 'tool_completed');
  if (load.event.type === 'tool_completed') { assert.equal(load.event.result.status, 'completed'); assert.equal((load.event.result.output as any).body, optionalBody); }
  assert.equal(f.parentRequests, 1); assert.equal(f.inheritance.context.parentManifest.entries.length, 1);
  assert.deepEqual(f.server.errors, []);
});

for (const mode of ['child-file-changed', 'snapshot-missing', 'snapshot-corrupt'] as const) test(`child launch refuses ${mode} before any child provider request`, async t => {
  const f = await fixture(t), input = f.childInput();
  if (mode === 'child-file-changed') await fs.appendFile(path.join(f.childRoot, '.agents', 'skills', 'fixed', 'SKILL.md'), '\nChanged only in the copied child worktree.');
  else {
    const active = f.inheritance.context.parentManifest.entries.find(entry => entry.skillId === f.entries.fixed.skillId)!;
    const object = path.join(f.snapshotsDirectory, `${active.version.fullFileHash}.skill`);
    if (mode === 'snapshot-missing') await fs.rm(object); else await fs.writeFile(object, 'Corrupt inherited immutable snapshot.');
  }
  await assert.rejects(runNativeAgentChild(input, f.childOptions), error => error instanceof NativeAgentChildNotStartedError
    && error.childNotStarted === true && error.code === 'child_start_preconditions_failed');
  assert.equal(f.childRequests, 0); assert.equal(f.capturedWorkers.length, 0);
  assert.equal(await fs.readFile(path.join(f.childRoot, 'fixture.txt'), 'utf8'), 'original material\n');
});

test('a child exhausting its own model budget preserves a fresh sibling budget and the live parent', async t => {
  const f = await fixture(t), limits = { ...f.config, maxModelRequests: 2, maxToolCalls: 2 };
  const firstIdentity = identity(), first = f.childInput({ identity: firstIdentity,
    budget: createNativeChildBudget(firstIdentity, limits, new AbortController().signal) });
  let phase = 0;
  f.setHandler((_body, request) => {
    if (++phase === 1) return f.call('limited-child-load', 'load_skill', { skillId: f.entries.optional.skillId,
      catalogRevision: (request.request.configuration.nativeSkillCatalog as any).revision });
    if (phase === 2) return f.call('limited-child-read', 'read_file', { path: 'fixture.txt' });
    assert.fail('The exhausted child cannot issue a third model request.');
  });
  const exhausted = await runNativeAgentChild(first, { ...f.childOptions, config: limits });
  assert.equal(exhausted.status, 'budget_exhausted'); assert.equal(exhausted.committed, true);
  assert.deepEqual(first.budget.snapshot(), { modelRequests: 2, toolCalls: 2 });
  const second = f.childInput(); phase = 0;
  assert.deepEqual(second.budget.snapshot(), { modelRequests: 0, toolCalls: 0 });
  f.setHandler(() => ++phase === 1 ? f.call('fresh-sibling-read', 'read_file', { path: 'fixture.txt' }) : f.message('Fresh sibling inspected actual material.'));
  const succeeded = await runNativeAgentChild(second, f.childOptions);
  assert.equal(succeeded.status, 'completed'); assert.equal(succeeded.committed, true);
  assert.deepEqual(second.budget.snapshot(), { modelRequests: 2, toolCalls: 1 });
  assert.equal(f.parentRequests, 1);
  assert.notEqual(first.identity.runId, second.identity.runId); assert.notEqual(first.identity.conversationId, second.identity.conversationId);
  assert.equal((await f.readChild(first)).runs[0].result?.status, 'budget_exhausted');
  assert.equal((await f.readChild(second)).runs[0].result?.status, 'completed');
});

test('an inherited child source changed during its actual write approval prevents the write', async t => {
  const f = await fixture(t), input = f.childInput({ toolPolicy: 'workspace_write' }); let step = 0, approvals = 0;
  f.setHandler(() => ++step === 1 ? f.call('write-child-read', 'read_file', { path: 'fixture.txt' }) : step === 2
    ? f.call('write-child-patch', 'apply_patch', { path: 'fixture.txt', content: 'must not be published\n', expectedHash: digest('original material\n') })
    : f.message('A changed guide cannot authorize the old approved operation.'));
  const result = await runNativeAgentChild(input, { ...f.childOptions, approvals: { request: async request => {
    approvals++; assert.equal(request.tool.name, 'apply_patch'); assert.equal(request.binding.runId, input.identity.runId);
    await fs.appendFile(path.join(f.childRoot, '.agents', 'skills', 'fixed', 'SKILL.md'), '\nChanged while the child approval was pending.');
    return approved.request(request, input.signal);
  } } });
  assert.equal(approvals, 1); assert.notEqual(result.status, 'recovery_required');
  assert.equal(await fs.readFile(path.join(f.childRoot, 'fixture.txt'), 'utf8'), 'original material\n');
  const child = await f.readChild(input), patch = child.records.find(record => record.event.type === 'tool_completed' && record.event.call.id === 'write-child-patch');
  assert.ok(patch); assert.equal(patch.event.type, 'tool_completed');
  if (patch.event.type === 'tool_completed') {
    assert.equal(patch.event.result.status, 'failed');
    assert.deepEqual(patch.event.result.output, { error: 'tool_preconditions_changed', executed: false });
  }
  assert.equal(await fs.readFile(path.join(f.parentRoot, 'fixture.txt'), 'utf8'), 'original material\n');
});

test('actual child in-run compaction retains inherited and loaded guides, rechecks observation, and survives reopening', { timeout: 25000 }, async t => {
  const f = await fixture(t), inputBudget = 110000;
  const config = { ...f.config, autoCompact: 'before_send_and_during_run' as const, maxInputTokens: inputBudget };
  const childIdentity = identity(), input = f.childInput({ identity: childIdentity, toolPolicy: 'workspace_write',
    budget: createNativeChildBudget(childIdentity, config, new AbortController().signal) });
  let step = 0, history = '', barrierChecks = 0;
  f.setHandler((body, request) => {
    const index = step++;
    if (index === 0) return f.call('child-load-before-compaction', 'load_skill', { skillId: f.entries.optional.skillId,
      catalogRevision: (request.request.configuration.nativeSkillCatalog as any).revision });
    if (index === 1) {
      const historyBytes = Math.floor(inputBudget * 0.9) - 4000 - Buffer.byteLength(JSON.stringify(body));
      assert.ok(historyBytes > 20000);
      const chunk = 'HISTORICAL_CHILD_OBSERVATION ';
      history = chunk.repeat(Math.ceil(historyBytes / chunk.length)).slice(0, historyBytes);
      return f.call('child-read-old-batch', 'read_file', { path: 'fixture.txt' }, history);
    }
    if (index === 2) return f.call('child-read-retained-batch', 'read_file', { path: 'fixture.txt' }, 'Latest complete child observations. '.repeat(160));
    if (index === 3) {
      const wire = JSON.stringify(body);
      assert.ok(wire.includes('native_skill_continuity')); assert.equal(wire.includes(history), false);
      assert.equal(wire.split(fixedBody).length - 1, 1); assert.equal(wire.split(optionalBody).length - 1, 1);
      return f.call('child-write-after-new-observation', 'apply_patch', { path: 'observed-child.txt', content: 'child exact guides observed\n', expectedHash: null });
    }
    assert.equal(index, 4); return f.message('Actual child write completed after exact compacted guides were observed.');
  });
  f.setCompactedHook(async (request, context) => {
    requireCompleteContext(context);
    await assert.rejects(request.tools.prepare({ id: 'premature-child-compaction-write', name: 'apply_patch',
      arguments: JSON.stringify({ path: 'premature-child.txt', content: 'must not happen', expectedHash: null }) },
    { identity: input.identity, policyRevision: request.request.policyRevision, signal: request.signal, maxOutputBytes: 65536 }), error => {
      assert.deepEqual(getToolPreparationFeedback(error), { error: 'skill_precondition_failed', code: 'context_unconfirmed', action: 'continue_model' }); return true;
    });
    barrierChecks++;
  });
  const result = await runNativeAgentChild(input, { ...f.childOptions, config });
  assert.equal(result.status, 'completed'); assert.equal(result.committed, true); assert.equal(f.summaries, 1); assert.equal(barrierChecks, 1);
  assert.equal(result.modelRequests, 6); assert.deepEqual(input.budget.snapshot(), { modelRequests: 6, toolCalls: 4 });
  assert.equal(await fs.readFile(path.join(f.childRoot, 'observed-child.txt'), 'utf8'), 'child exact guides observed\n');
  await assert.rejects(fs.stat(path.join(f.childRoot, 'premature-child.txt')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.parentRoot, 'observed-child.txt')), { code: 'ENOENT' });
  const child = await f.readChild(input), compacted = child.records.find(record => record.event.type === 'run_context_compacted');
  assert.ok(compacted); assert.equal(compacted.event.type, 'run_context_compacted');
  if (compacted.event.type === 'run_context_compacted') {
    const inherited = compacted.event.plan.nativeSkills!.manifest.entries.find(entry => entry.skillId === f.entries.fixed.skillId)!;
    assert.equal(inherited.origin, 'inherited'); assert.ok(inherited.inheritedFrom);
    assert.equal(inherited.placement, 'initial_instructions');
  }
  assert.equal(child.runs[0].result?.status, 'completed'); assert.equal(child.recovery, null);
  requireCompleteContext(child.context!); assert.deepEqual(f.server.errors, []);
});

test('actual recovered child keeps original skill provenance with a fresh identity, context and budget and never replays prior tools', async t => {
  const f = await fixture(t), limited = { ...f.config, maxModelRequests: 1 }, firstIdentity = identity();
  const first = f.childInput({ identity: firstIdentity, budget: createNativeChildBudget(firstIdentity, limited, new AbortController().signal) });
  f.setHandler(() => f.call('prior-child-only-read', 'read_file', { path: 'fixture.txt' }, 'A partial independent inspection needs a fresh continuation.'));
  const failed = await runNativeAgentChild(first, { ...f.childOptions, config: limited });
  assert.equal(failed.status, 'budget_exhausted'); assert.equal(failed.committed, true); assert.equal(failed.modelRequests, 1); assert.equal(failed.toolCalls, 1);
  const before = await f.readChild(first), recovered = f.childInput({ recovery: { previousChildId: first.childId!, previousRunId: first.identity.runId,
    summary: failed.summary, reason: failed.reason, receiptPath: failed.evidence!.runJournalPath! } });
  assert.deepEqual(recovered.budget.snapshot(), { modelRequests: 0, toolCalls: 0 });
  let phase = 0;
  f.setHandler((body, request) => {
    if (++phase === 1) {
      assert.equal(JSON.stringify(wireItems(body)).includes('prior-child-only-read'), false);
      assert.equal(wireItems(body).length, 1, 'recovery starts from one new user request, not the prior context');
      assert.equal(request.request.identity.runId, recovered.identity.runId);
      const initial = request.request.configuration.initialNativeSkills as any;
      assert.ok(initial.activations.every((activation: any) => activation.runId === recovered.identity.runId
        && activation.requestId === recovered.identity.requestId && !activation.offeredToRequestId && !activation.confirmedByResponseId));
      assert.deepEqual(request.request.configuration.nativeSkillInheritance, f.inheritance.context);
      return f.call('recovered-child-new-read', 'read_file', { path: 'fixture.txt' });
    }
    return f.message('Fresh recovery inspected current material without replaying old effects.');
  });
  const result = await runNativeAgentChild(recovered, f.childOptions), current = await f.readChild(recovered);
  assert.equal(result.status, 'completed'); assert.equal(result.committed, true);
  assert.deepEqual(recovered.budget.snapshot(), { modelRequests: 2, toolCalls: 1 });
  assert.deepEqual(first.budget.snapshot(), { modelRequests: 1, toolCalls: 1 });
  assert.notEqual(recovered.identity.runId, first.identity.runId); assert.notEqual(recovered.identity.conversationId, first.identity.conversationId);
  assert.deepEqual(await f.readChild(first), before, 'the original committed journal remains byte-for-byte logically unchanged');
  assert.equal(current.records.filter(record => record.event.type === 'tool_completed' && record.event.call.id === 'prior-child-only-read').length, 0);
  assert.equal(current.records.filter(record => record.event.type === 'tool_completed' && record.event.call.id === 'recovered-child-new-read').length, 1);
  assert.equal(f.parentRequests, 1); assert.deepEqual(f.server.errors, []);
});
