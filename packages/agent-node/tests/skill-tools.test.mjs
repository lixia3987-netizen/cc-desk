import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runAgent, canonicalJson, getToolPreparationFeedback } from '@cc-desk/agent-core';
import { SkillToolPort, createSkillToolPort, SkillToolError } from '../dist/skill-tools.js';
import { parseSkillMetadata } from '../dist/skill-metadata.js';
import { contentHash } from '../dist/tools/project-files.js';
import { composeToolPorts } from '../dist/mcp-tools.js';
import { NativeRunStore } from '../dist/run-store.js';
import { LocalToolPort } from '../dist/tools/local-tools.js';
import { ProcessSupervisor } from '../dist/process-supervisor.js';

const clone = value => structuredClone(value);
const unconfirmedFeedback = error => getToolPreparationFeedback(error)?.code === 'context_unconfirmed';
const identity = () => ({ sessionId: 'session', conversationId: 'conversation', runId: 'run', requestId: 'request', workerGeneration: 1 });
const call = (id, name, input = {}) => ({ id, name, arguments: JSON.stringify(input) });
const response = (calls = [], extra = {}) => ({ outputItems: calls.length
  ? calls.map(item => ({ type: 'function_call', call_id: item.id, name: item.name, arguments: item.arguments }))
  : [{ type: 'message', role: 'assistant', content: 'Done.' }], toolCalls: calls, finishReason: calls.length ? 'tool_calls' : 'completed', usage: { inputTokens: 10, outputTokens: 2 }, ...extra });
function skill(index = 0, body = `Private guide ${index}.\n`) {
  const name = `skill-${index}`;
  const content = `---\nname: ${name}\ndescription: Use this guide for task ${index}.\n---\n${body}`;
  const descriptor = { ...parseSkillMetadata(content, { directoryName: name }), skillId: `skill:${index}`, sourceId: 'project-agents', scope: 'project',
    relativePath: `${name}/SKILL.md`, sourceRevision: 1, sourceFingerprint: contentHash(`fingerprint:${index}`), metadataHash: contentHash(`metadata:${index}`), bytes: Buffer.byteLength(content) };
  const loaded = { content, body, version: { skillId: descriptor.skillId, sourceRevision: descriptor.sourceRevision, sourceFingerprint: descriptor.sourceFingerprint,
    fullFileHash: contentHash(content), bodyHash: contentHash(body), bytes: Buffer.byteLength(content), format: 'standard' } };
  return { descriptor, loaded };
}
function fixture(options = {}) {
  const skills = options.skills ?? [skill()];
  const catalog = { schemaVersion: 1, revision: 'catalog-v1', entries: skills.map(item => clone(item.descriptor)), issues: [], truncated: false };
  const controller = new AbortController();
  const state = { loads: 0, persists: 0, verifies: 0, owned: true, current: true, canActivate: true, seq: 0 };
  const ctx = { identity: clone(options.identity ?? identity()), policyRevision: 'host-policy', signal: controller.signal, maxOutputBytes: 65536 };
  const port = createSkillToolPort({ identity: ctx.identity, catalog,
    load: async (descriptor, signal) => { state.loads++; return clone(await options.load?.(descriptor, signal) ?? skills.find(item => item.descriptor.skillId === descriptor.skillId).loaded); },
    persist: async (loaded, signal) => { state.persists++; await options.persist?.(loaded, signal); },
    verify: async (descriptor, signal) => { state.verifies++; if (!state.current) throw new Error('secret source path'); await options.verify?.(descriptor, signal); },
    assertOwnership: async () => { if (!state.owned) throw new Error('secret owner token'); },
    canActivate: async () => state.canActivate,
    ...options.portOptions,
  });
  const observe = event => port.observeCommitted(event, ++state.seq);
  const commit = (prepared, result) => observe({ type: 'tool_completed', call: clone(prepared.call), result: clone(result), resultItems: [{ type: 'function_call_output', call_id: prepared.call.id, output: JSON.stringify(result) }] });
  const confirm = () => { observe({ type: 'model_request_started', attempt: state.seq + 1 }); observe({ type: 'model_response', response: response() }); };
  const loadCall = (id = 'load', index = 0) => call(id, 'load_skill', { skillId: skills[index].descriptor.skillId, catalogRevision: catalog.revision });
  const execute = async (toolCall = loadCall(), context = ctx) => { const prepared = await port.prepare(toolCall, context); await port.validate(prepared, context); return { prepared, result: await port.execute(prepared, context) }; };
  return { port, catalog, controller, state, ctx, skills, observe, commit, confirm, loadCall, execute };
}
function otherTools() {
  const effects = [], preparations = [];
  const definitions = ['read', 'write', 'command'].map(risk => ({ name: `fixture_${risk}`, risk, description: risk, inputSchema: { type: 'object' } }));
  const port = { definitions,
    prepare: async (toolCall, context) => { preparations.push(toolCall.id); const input = JSON.parse(toolCall.arguments); return { call: clone(toolCall), definition: clone(definitions.find(item => item.name === toolCall.name)),
      input, inputDigest: contentHash(canonicalJson(input)), policyRevision: context.policyRevision, requiresApproval: false, preconditions: { original: 'unchanged' } }; },
    validate: async prepared => assert.deepEqual(prepared.preconditions, { original: 'unchanged' }),
    execute: async prepared => { assert.deepEqual(prepared.preconditions, { original: 'unchanged' }); effects.push(prepared.call.id); return { status: 'completed', output: { done: true } }; },
  };
  return { port, effects, preparations };
}

test('catalog is frozen, uses exact IDs, paginates whole descriptions and exposes only read-risk tools', async () => {
  const f = fixture({ skills: Array.from({ length: 8 }, (_, i) => skill(i)) });
  assert.ok(f.port.definitions.every(item => item.risk === 'read'));
  f.catalog.entries[0].description = 'Changed outside port';
  const publicDefinitions = f.port.definitions; publicDefinitions[0].risk = 'command';
  assert.equal(f.port.definitions[0].risk, 'read');
  const first = await f.execute(call('list-one', 'list_skills', { limit: 2 }));
  assert.equal(first.result.output.entries.length, 2);
  assert.equal(first.result.output.entries[0].description, 'Use this guide for task 0.');
  const second = await f.execute(call('list-two', 'list_skills', { limit: 2, cursor: first.result.output.nextCursor }));
  assert.deepEqual(second.result.output.entries.map(item => item.skillId), ['skill:2', 'skill:3']);
  await assert.rejects(f.port.prepare(call('bad-cursor', 'list_skills', { query: 'different', cursor: first.result.output.nextCursor }), f.ctx));
  await assert.rejects(f.port.prepare(call('name-not-id', 'load_skill', { skillId: 'skill-0', catalogRevision: f.catalog.revision }), f.ctx));
  for (const input of [{ query: null }, { limit: null }, { limit: 0 }, { unknown: true }, { cursor: 3 }]) await assert.rejects(f.port.prepare(call(JSON.stringify(input), 'list_skills', input), f.ctx));
  assert.equal(f.state.loads, 0);
});

test('complete sourced body activates only from its own exact committed tool result', async () => {
  const f = fixture();
  const { prepared, result } = await f.execute();
  assert.equal(result.status, 'completed');
  assert.equal(result.output.body, f.skills[0].loaded.body);
  assert.equal(result.output.complete, true);
  assert.equal(result.output.sourceId, 'project-agents');
  assert.equal(result.output.relativePath, 'skill-0/SKILL.md');
  assert.equal(f.state.persists, 1);
  assert.deepEqual(f.port.snapshot().activations, []);
  f.commit({ ...prepared, call: { ...prepared.call, id: 'foreign-tool' } }, result);
  f.commit(prepared, { ...result, output: { ...result.output, body: 'forged' } });
  assert.deepEqual(f.port.snapshot().activations, []);
  f.commit(prepared, result);
  const activated = f.port.snapshot();
  assert.equal(activated.activations.length, 1);
  assert.equal(activated.activations[0].receiptSeq, f.state.seq);
  assert.equal(activated.activations[0].confirmedByResponseId, undefined);
  const copy = f.port.snapshot(); copy.activations[0].version.bodyHash = 'forged';
  assert.notEqual(f.port.snapshot().activations[0].version.bodyHash, 'forged');
  f.commit(prepared, result);
  assert.equal(f.port.snapshot().activationRevision, activated.activationRevision);
});

test('load idempotency never re-runs persistence or duplicates an activated body', async () => {
  const f = fixture();
  const first = await f.execute();
  assert.deepEqual(await f.port.execute(first.prepared, f.ctx), first.result);
  assert.equal(f.state.loads, 1); assert.equal(f.state.persists, 1);
  assert.equal((await f.port.execute(first.prepared, { ...f.ctx, maxOutputBytes: 128 })).output.error, 'prepared_changed');
  const waiting = await f.execute(f.loadCall('waiting'));
  assert.equal(waiting.result.output.error, 'skill_load_pending_commit');
  f.commit(first.prepared, first.result);
  const repeated = await f.execute(f.loadCall('already-loaded'));
  assert.equal(repeated.result.output.alreadyLoaded, true);
  assert.equal(repeated.result.output.body, undefined);
  assert.equal(f.state.loads, 1); assert.equal(f.state.persists, 1);
  await assert.rejects(f.port.prepare({ ...first.prepared.call, arguments: JSON.stringify({ skillId: 'other', catalogRevision: f.catalog.revision }) }, f.ctx));
});

test('a cancellation between successful load and durable receipt cannot create an active guide', async () => {
  const f = fixture();
  const loaded = await f.execute();
  assert.equal(loaded.result.status, 'completed');
  f.controller.abort();
  f.commit(loaded.prepared, loaded.result);
  assert.equal(f.port.snapshot().activations.length, 0);
});

test('serialized output limits reject the whole body before persistence or activation', async () => {
  const f = fixture({ skills: [skill(0, '"'.repeat(14000))] });
  const { result } = await f.execute(undefined, { ...f.ctx, maxOutputBytes: 20000 });
  assert.equal(result.status, 'not_executed');
  assert.equal(result.output.error, 'output_byte_limit');
  assert.equal(result.output.body, undefined);
  assert.equal(f.state.persists, 0);
  assert.equal(f.port.snapshot().activations.length, 0);
  const list = await f.execute(call('tiny-list', 'list_skills', {}), { ...f.ctx, maxOutputBytes: 128 });
  assert.equal(list.result.output.error, 'output_byte_limit');
});

test('persistence failure, source mutation and cancellation leave no half-activation or leaked error text', async () => {
  for (const failure of ['persist', 'verify', 'cancel']) {
    let f;
    f = fixture({ persist: async () => {
      if (failure === 'persist') throw new Error('SECRET path credential');
      if (failure === 'verify') f.state.current = false;
      if (failure === 'cancel') f.controller.abort();
    } });
    const item = await f.execute();
    assert.equal(item.result.status, 'not_executed');
    assert.doesNotMatch(JSON.stringify(item.result), /SECRET|credential|secret source path/);
    f.commit(item.prepared, item.result);
    assert.equal(f.port.snapshot().activations.length, 0);
  }
});

test('loading enforces caller, frozen revision, cancellation and host live-operation barrier', async () => {
  const f = fixture();
  await assert.rejects(f.port.prepare(f.loadCall(), { ...f.ctx, identity: { ...f.ctx.identity, workerGeneration: 2 } }), /ownership/);
  await assert.rejects(f.port.prepare(call('stale', 'load_skill', { skillId: 'skill:0', catalogRevision: 'other' }), f.ctx));
  f.state.canActivate = false;
  const blocked = await f.execute();
  assert.equal(blocked.result.output.error, 'activation_blocked_by_operation');
  assert.equal(f.state.loads, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.port.prepare(f.loadCall('cancelled'), { ...f.ctx, signal: controller.signal }), /cancelled/);
  f.state.owned = false;
  await assert.rejects(f.port.prepare(f.loadCall('wrong-owner'), f.ctx));
});

test('an operation becoming pending during final source verification blocks activation', async () => {
  let f;
  f = fixture({ verify: async () => { f.state.canActivate = false; } });
  const loaded = await f.execute();
  assert.equal(loaded.result.output.error, 'activation_blocked_by_operation');
  f.commit(loaded.prepared, loaded.result);
  assert.equal(f.port.snapshot().activations.length, 0);
});

test('16 active guides and shared instruction bytes include initial, pending and base instructions', async () => {
  const skills = Array.from({ length: 17 }, (_, i) => skill(i));
  const f = fixture({ skills, portOptions: { initialSkills: skills.slice(0, 16).map(item => ({ ...item, origin: 'pinned' })) } });
  const count = await f.execute(f.loadCall('seventeenth', 16));
  assert.equal(count.result.output.error, 'active_skill_limit');
  assert.equal(f.port.snapshot().activations.length, 16);
  const byteLimited = fixture({ portOptions: { baseInstructionBytes: 128 * 1024 - 1 } });
  const bytes = await byteLimited.execute();
  assert.equal(bytes.result.output.error, 'instruction_byte_limit');
  assert.equal(byteLimited.state.persists, 0);
});

test('concurrent loads cannot oversubscribe the final active slot', async () => {
  const skills = Array.from({ length: 17 }, (_, i) => skill(i));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ skills, persist: async () => gate, portOptions: { initialSkills: skills.slice(0, 15).map(item => ({ ...item, origin: 'pinned' })) } });
  const pending = [f.execute(f.loadCall('one', 15)), f.execute(f.loadCall('two', 16))];
  while (f.state.persists < 2) await new Promise(resolve => setImmediate(resolve));
  release();
  const results = await Promise.all(pending);
  const accepted = results.filter(item => item.result.status === 'completed');
  assert.equal(accepted.length, 1);
  assert.equal(results.find(item => item.result.status !== 'completed').result.output.error, 'active_skill_limit');
  f.commit(accepted[0].prepared, accepted[0].result);
  assert.equal(f.port.snapshot().activations.length, 16);
});

test('guard binds dynamic skill digest without changing the host policy or underlying operation', async () => {
  const f = fixture();
  const other = otherTools(), guarded = f.port.guard(other.port);
  const before = await guarded.prepare(call('before', 'fixture_write'), f.ctx);
  assert.equal(before.policyRevision, f.ctx.policyRevision);
  assert.equal(before.preconditions.original, 'unchanged');
  assert.equal(before.preconditions.nativeSkillGuard.activationRevision, 0);
  const loaded = await f.execute(); f.commit(loaded.prepared, loaded.result);
  await assert.rejects(guarded.validate(before, f.ctx), /observation/);
  f.confirm();
  await assert.rejects(guarded.validate(before, f.ctx), /active_skills_changed/);
  assert.equal((await guarded.execute(before, f.ctx)).output.error, 'active_skills_changed');
  const fresh = await guarded.prepare(call('fresh', 'fixture_write'), f.ctx);
  await guarded.validate(fresh, f.ctx);
  assert.equal((await guarded.execute(fresh, f.ctx)).status, 'completed');
  assert.deepEqual(other.effects, ['fresh']);
  assert.deepEqual(await guarded.execute(fresh, f.ctx), { status: 'completed', output: { done: true } });
  assert.deepEqual(other.effects, ['fresh']);
});

test('guard preserves object preconditions and rejects collisions with its reserved binding key', async () => {
  const f = fixture(), other = otherTools(), originalPrepare = other.port.prepare;
  other.port.prepare = async (item, context) => ({ ...await originalPrepare(item, context), preconditions: { nativeSkillGuard: { forged: true } } });
  await assert.rejects(f.port.guard(other.port).prepare(call('collision', 'fixture_write'), f.ctx), error => error instanceof SkillToolError && error.code === 'guard_key_collision');
  other.port.prepare = async (item, context) => ({ ...await originalPrepare(item, context), preconditions: null });
  other.port.validate = async prepared => assert.equal(prepared.preconditions, null);
  other.port.execute = async prepared => { assert.equal(prepared.preconditions, null); return { status: 'completed', output: {} }; };
  const guarded = f.port.guard(other.port);
  const prepared = await guarded.prepare(call('scalar', 'fixture_write'), f.ctx);
  assert.equal(prepared.preconditions.operation, null);
  assert.ok(prepared.preconditions.nativeSkillGuard);
  await guarded.validate(prepared, f.ctx);
  assert.equal((await guarded.execute(prepared, f.ctx)).status, 'completed');
});

test('final side-effect hook checks the run, observation and live source without a synthetic policy context', async () => {
  const f = fixture();
  await f.port.assertSideEffectsCurrent(f.controller.signal);
  const loaded = await f.execute(); f.commit(loaded.prepared, loaded.result);
  await assert.rejects(f.port.assertSideEffectsCurrent(f.controller.signal), /observation/);
  f.confirm();
  await f.port.assertSideEffectsCurrent(f.controller.signal);
  f.state.current = false;
  await assert.rejects(f.port.assertSideEffectsCurrent(f.controller.signal), /source_changed/);
  f.state.current = true; f.state.owned = false;
  await assert.rejects(f.port.assertSideEffectsCurrent(f.controller.signal));
  f.state.owned = true; f.controller.abort();
  await assert.rejects(f.port.assertSideEffectsCurrent(f.controller.signal), /cancelled/);
});

test('final ownership await cannot hide an activation committed while its callback is suspended', async () => {
  let gated = false, checks = 0, entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ skills: [skill(0), skill(1)], portOptions: { assertOwnership: async () => {
    if (gated && ++checks === 3) { entered(); await gate; }
  } } });
  const first = await f.execute(); f.commit(first.prepared, first.result); f.confirm();
  const second = await f.execute(f.loadCall('second', 1));
  gated = true;
  const final = f.port.assertSideEffectsCurrent(f.controller.signal);
  await waiting;
  f.commit(second.prepared, second.result);
  release();
  await assert.rejects(final, /active_skills_changed/);
});

test('more than 512 distinct committed own and guarded reads can continue without a lifetime call limit', async () => {
  const f = fixture(), other = otherTools(), guarded = f.port.guard(other.port);
  let firstOwn, firstGuard;
  for (let index = 0; index < 600; index++) {
    const own = await f.execute(call(`list-${index}`, 'list_skills', { limit: 1 }));
    f.commit(own.prepared, own.result);
    const prepared = await guarded.prepare(call(`read-${index}`, 'fixture_read'), f.ctx);
    const result = await guarded.execute(prepared, f.ctx);
    f.commit(prepared, result);
    if (index === 0) { firstOwn = own; firstGuard = { prepared, result }; }
  }
  assert.equal(other.effects.length, 600);
  assert.deepEqual(await guarded.execute(firstGuard.prepared, f.ctx), firstGuard.result);
  await assert.rejects(guarded.prepare(firstGuard.prepared.call, f.ctx), error => error.code === 'call_already_committed');
  await assert.rejects(f.port.prepare(firstOwn.prepared.call, f.ctx), error => error.code === 'call_already_committed');
  assert.equal(other.effects.length, 600);
  assert.equal((await guarded.execute(firstGuard.prepared, { ...f.ctx, policyRevision: 'changed' })).output.error, 'prepared_changed');
  assert.equal((await guarded.execute(firstGuard.prepared, { ...f.ctx, maxOutputBytes: 128 })).output.error, 'prepared_changed');
  const forged = clone(firstGuard.prepared); forged.input.extra = true;
  assert.equal((await guarded.execute(forged, f.ctx)).output.error, 'prepared_changed');
  f.state.owned = false;
  assert.equal((await guarded.execute(firstGuard.prepared, f.ctx)).status, 'not_executed');
});

test('large committed load results become explicit historical receipt references without reinjection', async () => {
  const f = fixture({ skills: [skill(0, 'Complete guide.\n'.repeat(300))] });
  const loaded = await f.execute(); f.commit(loaded.prepared, loaded.result);
  const revision = f.port.snapshot().activationRevision;
  const replay = await f.port.execute(loaded.prepared, f.ctx);
  assert.equal(replay.status, 'not_executed');
  assert.equal(replay.output.error, 'tool_call_already_committed');
  assert.equal(replay.output.previousStatus, 'completed');
  assert.equal(replay.output.bodyIncluded, false);
  assert.equal(replay.output.body, undefined); assert.equal(replay.output.complete, undefined);
  assert.equal(f.state.loads, 1); assert.equal(f.state.persists, 1);
  assert.equal(f.port.snapshot().activationRevision, revision);
});

test('only unfinished prepared states consume the 512-slot bound, including non-executed terminal receipts', async () => {
  const f = fixture(), other = otherTools(), guarded = f.port.guard(other.port);
  const own = [], ordinary = [];
  for (let index = 0; index < 512; index++) {
    own.push(await f.port.prepare(call(`own-${index}`, 'list_skills'), f.ctx));
    ordinary.push(await guarded.prepare(call(`ordinary-${index}`, 'fixture_read'), f.ctx));
  }
  await assert.rejects(f.port.prepare(call('own-overflow', 'list_skills'), f.ctx), /prepared_limit/);
  await assert.rejects(guarded.prepare(call('ordinary-overflow', 'fixture_read'), f.ctx), /prepared_limit/);
  assert.equal(other.preparations.length, 512);
  for (const [index, status] of ['denied', 'cancelled', 'failed'].entries()) {
    const result = { status, output: { executed: false } };
    f.commit(own[index], result); f.commit(ordinary[index], result);
    assert.equal((await f.port.execute(own[index], f.ctx)).status, status);
    assert.equal((await guarded.execute(ordinary[index], f.ctx)).status, status);
    assert.ok(await f.port.prepare(call(`own-freed-${index}`, 'list_skills'), f.ctx));
    assert.ok(await guarded.prepare(call(`ordinary-freed-${index}`, 'fixture_read'), f.ctx));
  }
  assert.deepEqual(other.effects, []);
  await assert.rejects(guarded.prepare(call('still-bounded', 'fixture_read'), f.ctx), /prepared_limit/);
});

test('concurrent preparations are bounded before downstream asynchronous I/O starts', async () => {
  const f = fixture(), other = otherTools(), originalPrepare = other.port.prepare;
  let count = 0, entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  other.port.prepare = async (item, context) => { if (++count === 512) entered(); await gate; return originalPrepare(item, context); };
  const guarded = f.port.guard(other.port);
  const pending = Array.from({ length: 512 }, (_, index) => guarded.prepare(call(`pending-${index}`, 'fixture_read'), f.ctx));
  await waiting;
  await assert.rejects(guarded.prepare(call('overflow', 'fixture_read'), f.ctx), /prepared_limit/);
  assert.equal(count, 512);
  release();
  assert.equal((await Promise.all(pending)).length, 512);
});

test('an executed write with unknown outcome cannot be freed by a fabricated failed completion', async () => {
  const f = fixture(), other = otherTools();
  other.port.execute = async () => { other.effects.push('started'); throw new Error('unknown outcome'); };
  const guarded = f.port.guard(other.port);
  const prepared = await guarded.prepare(call('unknown-write', 'fixture_write'), f.ctx);
  await assert.rejects(guarded.execute(prepared, f.ctx), /unknown outcome/);
  f.commit(prepared, { status: 'failed', output: { executed: false } });
  for (let index = 0; index < 511; index++) await guarded.prepare(call(`uncommitted-${index}`, 'fixture_read'), f.ctx);
  await assert.rejects(guarded.prepare(call('overflow', 'fixture_read'), f.ctx), /prepared_limit/);
  await assert.rejects(guarded.execute(prepared, f.ctx), /unknown outcome/);
  assert.deepEqual(other.effects, ['started']);
});

test('real LocalToolPort change sets retain top-level approved previews and commit actual file receipts to NativeRunStore', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'native-skills-change-set-'));
  const projectRoot = path.join(parent, 'project'), rootDirectory = path.join(parent, 'ledger');
  await fs.mkdir(projectRoot);
  await fs.writeFile(path.join(projectRoot, 'a.txt'), 'before\n');
  const runIdentity = { ...identity(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID() };
  let ledger = await NativeRunStore.open({ rootDirectory, conversationId: runIdentity.conversationId });
  const supervisor = new ProcessSupervisor();
  t.after(async () => { await ledger.close().catch(() => {}); await supervisor.dispose(); await fs.rm(parent, { recursive: true, force: true }); });
  const f = fixture({ identity: runIdentity });
  const local = new LocalToolPort({ projectRoot, excludedRoots: [rootDirectory], supervisor, ownerId: runIdentity.runId,
    recordChangeSetEvent: (id, item, event) => ledger.recordChangeSetEvent(id, item, event) });
  const guarded = f.port.guard(local);
  const item = call('actual-change-set', 'apply_change_set', { changes: [{ path: 'a.txt', content: 'after\n', expectedHash: contentHash('before\n') }] });
  await ledger.beginRun({ identity: runIdentity, input: 'Apply one exact change.', inputDigest: 'submission-digest', userItems: [{ role: 'user', content: 'Apply one exact change.' }],
    protocol: { id: 'openai-responses', version: 1 }, configuration: {}, policyRevision: f.ctx.policyRevision });
  for (const event of [{ type: 'model_request_started', attempt: 1 }, { type: 'model_response', response: response([item]) }]) {
    const receipt = await ledger.append(runIdentity, event); f.port.observeCommitted(event, receipt.seq);
  }
  const prepared = await guarded.prepare(item, f.ctx);
  assert.equal(prepared.preconditions.changeSet.files[0].path, 'a.txt');
  assert.equal(prepared.preconditions.nativeSkillGuard.activationRevision, 0);
  const approval = { binding: { ...runIdentity, toolCallId: item.id, inputDigest: prepared.inputDigest, policyRevision: f.ctx.policyRevision }, decision: 'approved', expiresAt: Date.now() + 60000 };
  await guarded.validate(prepared, f.ctx);
  await ledger.append(runIdentity, { type: 'tool_prepared', prepared, approval });
  const result = await guarded.execute(prepared, f.ctx, approval);
  assert.equal(result.status, 'completed');
  assert.equal(result.output.receiptCommitted, true);
  assert.equal(await fs.readFile(path.join(projectRoot, 'a.txt'), 'utf8'), 'after\n');
  assert.deepEqual(ledger.getToolState(runIdentity.runId, item.id).changeSetProgress.map(event => event.status), ['prepared', 'applied']);
  await ledger.append(runIdentity, { type: 'tool_completed', call: item, result, resultItems: [{ type: 'function_call_output', call_id: item.id, output: JSON.stringify(result) }] });
  await ledger.append(runIdentity, { type: 'run_finished', result: { identity: runIdentity, status: 'completed', reason: 'completed', modelRequests: 1, toolCalls: 1, usage: null, context: ledger.loadContext(), committed: true } });
  await ledger.close(); ledger = await NativeRunStore.open({ rootDirectory, conversationId: runIdentity.conversationId });
  assert.equal(ledger.recoveryRequired, false);
  const persisted = ledger.getToolState(runIdentity.runId, item.id).prepared.prepared;
  assert.deepEqual(persisted.preconditions.changeSet, prepared.preconditions.changeSet);
  assert.deepEqual(persisted.preconditions.nativeSkillGuard, prepared.preconditions.nativeSkillGuard);
});

test('offered requests and incomplete or failed responses never unlock writes', async () => {
  const f = fixture(), other = otherTools(), guarded = f.port.guard(other.port);
  const loaded = await f.execute(); f.commit(loaded.prepared, loaded.result);
  f.observe({ type: 'model_request_started', attempt: 2 });
  assert.ok(f.port.snapshot().activations[0].offeredToRequestId);
  await assert.rejects(guarded.prepare(call('offered', 'fixture_command'), f.ctx), unconfirmedFeedback);
  f.observe({ type: 'model_request_failed', attempt: 2, failure: { category: 'network', retryable: false }, partial: true });
  f.observe({ type: 'model_response', response: response() });
  assert.equal(f.port.snapshot().activations[0].confirmedByResponseId, undefined);
  f.observe({ type: 'model_request_started', attempt: 3 });
  f.observe({ type: 'model_response', response: response([], { finishReason: 'incomplete' }) });
  assert.equal(f.port.snapshot().activations[0].confirmedByResponseId, undefined);
  await assert.rejects(guarded.prepare(call('incomplete', 'fixture_write'), f.ctx), unconfirmedFeedback);
  const read = await guarded.prepare(call('read', 'fixture_read'), f.ctx);
  assert.equal((await guarded.execute(read, f.ctx)).status, 'completed');
  f.confirm();
  assert.ok(f.port.snapshot().activations[0].confirmedByResponseId);
  assert.ok(await guarded.prepare(call('confirmed', 'fixture_command'), f.ctx));
});

test('all guarded side effects recheck source changes and reject forged read downgrades', async () => {
  const f = fixture(), other = otherTools(), guarded = f.port.guard(other.port);
  const loaded = await f.execute(); f.commit(loaded.prepared, loaded.result); f.confirm();
  const prepared = await guarded.prepare(call('write', 'fixture_write'), f.ctx);
  const forged = clone(prepared); forged.call.name = 'fixture_read'; forged.definition.risk = 'read';
  assert.equal((await guarded.execute(forged, f.ctx)).output.error, 'prepared_changed');
  f.state.current = false;
  await assert.rejects(guarded.validate(prepared, f.ctx), /source_changed/);
  assert.equal((await guarded.execute(prepared, f.ctx)).output.error, 'skill_source_changed');
  assert.deepEqual(other.effects, []);
});

test('guard rejects caller/policy mutation and does not disguise an unknown operation outcome', async () => {
  const f = fixture(), other = otherTools();
  other.port.execute = async () => { other.effects.push('started'); throw new Error('unknown operation outcome'); };
  const guarded = f.port.guard(other.port);
  const prepared = await guarded.prepare(call('write', 'fixture_write'), f.ctx);
  assert.equal((await guarded.execute(prepared, { ...f.ctx, policyRevision: 'forged' })).output.error, 'prepared_changed');
  assert.equal((await guarded.execute(prepared, { ...f.ctx, identity: { ...f.ctx.identity, runId: 'other' } })).output.error, 'ownership_changed');
  await assert.rejects(guarded.execute(prepared, f.ctx), /unknown operation outcome/);
  await assert.rejects(guarded.execute(prepared, f.ctx), /unknown operation outcome/);
  assert.deepEqual(other.effects, ['started']);
});

async function actualRun(t, options = {}) {
  const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-skill-tools-'));
  const runIdentity = { ...identity(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID() };
  let faultCount = 0;
  const ledger = await NativeRunStore.open({ rootDirectory, conversationId: runIdentity.conversationId, fault: async (point, type) => {
    if (point === 'before_append' && type === options.failEvent && ++faultCount === (options.failOrdinal ?? 1)) throw Object.assign(new Error('injected durable write failure'), { code: 'EIO' });
  } });
  t.after(async () => { await ledger.close().catch(() => {}); await fs.rm(rootDirectory, { recursive: true, force: true }); });
  const f = fixture({ identity: runIdentity });
  const other = otherTools();
  const tools = composeToolPorts([f.port, f.port.guard(other.port)]);
  const protocol = { id: 'openai-responses', version: 1 };
  const inputs = [], snapshots = [];
  const responses = options.responses(f);
  const result = await runAgent({ identity: runIdentity, input: 'Use a relevant skill, then change the project.', policyRevision: f.ctx.policyRevision,
    configuration: { model: 'skill-fixture' }, budget: { maxToolOutputBytes: 65536 }, signal: f.controller.signal }, {
    tools,
    model: { protocol, userItems: input => [{ role: 'user', content: input }], toolResultItems: (item, result) => [{ type: 'function_call_output', call_id: item.id, output: JSON.stringify(result) }],
      estimateInputTokens: () => 100,
      generate: async request => { inputs.push(clone(request.context)); const next = responses.shift(); assert.ok(next, 'unexpected extra request'); if (next instanceof Error) throw next; return next; },
    },
    host: { now: () => Date.now(), activeNow: () => performance.now(), digest: contentHash, emit: () => {}, deadline: (_milliseconds, signal) => ({ signal, dispose: () => {} }) },
    approvals: { request: async request => ({ binding: request.binding, decision: 'approved', expiresAt: request.expiresAt }) },
    store: { beginRun: request => ledger.beginRun(request), ensureCapacity: (id, bytes) => ledger.ensureCapacity(id, bytes), checkpoint: (id, context) => ledger.checkpoint(id, context),
      append: async (id, event) => { const receipt = await ledger.append(id, event); f.port.observeCommitted(event, receipt.seq); snapshots.push({ type: event.type, snapshot: f.port.snapshot() }); return receipt; },
    },
  });
  return { ...f, ledger, inputs, snapshots, effects: other.effects, result };
}

for (const writeFirst of [false, true]) test(`real runAgent and durable store block same-response writes (${writeFirst ? 'write first' : 'load first'}) until the next complete response`, async t => {
  const f = await actualRun(t, { responses: fixture => {
    const load = fixture.loadCall(), write = call('same-response-write', 'fixture_write');
    return [response(writeFirst ? [write, load] : [load, write]), response([call('next-response-write', 'fixture_write')]), response()];
  } });
  assert.equal(f.result.status, 'completed'); assert.equal(f.result.committed, true);
  assert.deepEqual(f.effects, ['next-response-write']);
  const output = f.inputs[1].items.find(item => item.type === 'function_call_output' && item.call_id === 'load');
  assert.equal(JSON.parse(output.output).output.body, f.skills[0].loaded.body);
  const blocked = f.inputs[1].items.find(item => item.type === 'function_call_output' && item.call_id === 'same-response-write');
  assert.deepEqual(JSON.parse(blocked.output), { status: 'failed', output: {
    error: 'skill_precondition_failed', code: 'context_unconfirmed', action: 'continue_model', executed: false,
  } });
  const activated = f.snapshots.find(item => item.type === 'tool_completed' && item.snapshot.activations.length);
  assert.equal(activated.snapshot.activations[0].confirmedByResponseId, undefined);
  assert.ok(f.port.snapshot().activations[0].confirmedByResponseId);
  assert.equal(f.ledger.replay(0, 1000).filter(item => item.event.type === 'tool_completed' && item.event.call.id === 'load').length, 1);
});

test('real durable tool_completed write failure never activates or performs the same-batch write', async t => {
  const f = await actualRun(t, { failEvent: 'tool_completed', responses: fixture => [response([fixture.loadCall(), call('write', 'fixture_write')])] });
  assert.equal(f.result.committed, false);
  assert.equal(f.port.snapshot().activations.length, 0);
  assert.deepEqual(f.effects, []);
  assert.equal(f.ledger.replay(0, 1000).some(item => item.event.type === 'tool_completed'), false);
});

test('real complete model_response write failure preserves an unconfirmed activation and never unlocks commands', async t => {
  const f = await actualRun(t, { failEvent: 'model_response', failOrdinal: 2,
    responses: fixture => [response([fixture.loadCall()]), response([call('command', 'fixture_command')])] });
  assert.equal(f.result.committed, false);
  assert.equal(f.port.snapshot().activations.length, 1);
  assert.ok(f.port.snapshot().activations[0].offeredToRequestId);
  assert.equal(f.port.snapshot().activations[0].confirmedByResponseId, undefined);
  assert.deepEqual(f.effects, []);
});

test('real failed model request after loading records only offered state', async t => {
  const f = await actualRun(t, { responses: fixture => [response([fixture.loadCall()]), new Error('transport failed')] });
  assert.equal(f.result.status, 'failed');
  assert.equal(f.port.snapshot().activations.length, 1);
  assert.ok(f.port.snapshot().activations[0].offeredToRequestId);
  assert.equal(f.port.snapshot().activations[0].confirmedByResponseId, undefined);
  assert.deepEqual(f.effects, []);
});

test('initial trusted bodies share budgets and remain unconfirmed until the initial full response', async () => {
  const initial = skill();
  const f = fixture({ skills: [initial], portOptions: { initialSkills: [{ ...initial, origin: 'explicit' }] } });
  const other = otherTools(), guarded = f.port.guard(other.port);
  assert.equal(f.port.snapshot().activations[0].origin, 'explicit');
  await assert.rejects(guarded.prepare(call('early', 'fixture_write'), f.ctx), unconfirmedFeedback);
  f.confirm();
  const prepared = await guarded.prepare(call('ready', 'fixture_write'), f.ctx);
  assert.equal((await guarded.execute(prepared, f.ctx)).status, 'completed');
  assert.deepEqual(other.effects, ['ready']);
});

test('guard.prepare publishes only branded skill errors as finite recovery feedback', async () => {
  for (const [internalCode, code, action] of [
    ['skill_model_observation_required', 'context_unconfirmed', 'continue_model'],
    ['skill_source_changed', 'source_changed', 'restart_turn'],
    ['active_skills_changed', 'activation_changed', 'prepare_again'],
    ['activation_blocked_by_operation', 'activation_blocked', 'settle_operations'],
    ['output_byte_limit', 'output_limit', 'adjust_skill_limits'],
    ['active_skill_limit', 'skill_limit', 'adjust_skill_limits'],
    ['instruction_byte_limit', 'skill_limit', 'adjust_skill_limits'],
  ]) {
    const f = fixture(), other = otherTools();
    other.port.prepare = async () => { const error = new SkillToolError(internalCode); error.message = 'SECRET source path'; throw error; };
    const guarded = f.port.guard(other.port);
    await assert.rejects(guarded.prepare(call('write', 'fixture_write'), f.ctx), error => {
      assert.deepEqual(getToolPreparationFeedback(error), { error: 'skill_precondition_failed', code, action });
      assert.doesNotMatch(error.message, /SECRET|source path/);
      return true;
    });
  }
  let reads = 0;
  for (const error of [
    new Error('SECRET ordinary error'), new SkillToolError('SECRET unknown code'),
    Object.assign(Object.create(SkillToolError.prototype), { code: 'skill_source_changed' }),
    Object.defineProperty(new SkillToolError('skill_source_changed'), 'code', { get() { reads++; throw new Error('SECRET getter') } }),
  ]) {
    const f = fixture(), other = otherTools(); other.port.prepare = async () => { throw error; };
    await assert.rejects(f.port.guard(other.port).prepare(call('write', 'fixture_write'), f.ctx), actual => { assert.equal(getToolPreparationFeedback(actual), null); return true; });
  }
  assert.equal(reads, 0);
});
