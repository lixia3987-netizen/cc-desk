import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalJson } from '@cc-desk/agent-core';
import { NativeRunStore } from '../dist/run-store.js';
import { SkillRegistry } from '../dist/skill-registry.js';
import { SkillSnapshotStore } from '../dist/skill-snapshots.js';
import { SkillToolPort, SKILL_GUIDE_AUTHORITY } from '../dist/skill-tools.js';
import { contextPendingCalls, nativeToolResultItems } from '../dist/context-maintenance.js';
import { readSkillContinuityEvidence, resolveSkillContinuity, skillContinuityItems } from '../dist/skill-continuity.js';

const usage = { inputTokens: 10, outputTokens: 3, totalTokens: 13 };
const protocols = ['openai-responses', 'openai-chat-completions', 'anthropic-messages'];
const catalogConfiguration = catalog => ({ revision: catalog.revision, entries: catalog.entries.map(({ skillId, sourceId, relativePath, sourceRevision, sourceFingerprint, metadataHash, format }) =>
  ({ skillId, sourceId, relativePath, sourceRevision, sourceFingerprint, metadataHash, format })), truncated: catalog.truncated });
const guide = (descriptor, loaded) => `Native skill guide ${descriptor.skillId} (${descriptor.sourceId}/${descriptor.relativePath}), version ${loaded.version.fullFileHash}:\n${loaded.body}`;
function response(protocol, call, detail = 'Detailed previous observations. '.repeat(4000)) {
  let outputItems;
  if (protocol.id === 'openai-responses') outputItems = [{ type: 'reasoning', encrypted_content: 'opaque exact reasoning bytes', summary: [] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: detail }] },
    ...(call ? [{ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments }] : [])];
  else if (protocol.id === 'openai-chat-completions') outputItems = [{ role: 'assistant', content: detail,
    ...(call ? { tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }] } : {}) }];
  else outputItems = [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'exact private thought', signature: 'opaque signature' }, { type: 'text', text: detail },
    ...(call ? [{ type: 'tool_use', id: call.id, name: call.name, input: JSON.parse(call.arguments) }] : [])] }];
  return { type: 'model_response', response: { outputItems, toolCalls: call ? [call] : [], finishReason: call ? 'tool_calls' : 'completed', usage } };
}
async function fixture(t, { protocolId = protocols[0], initial = false, bodies = ['Exact dynamic guide 中文\r\nDo not delete the workspace.', 'A different exact guide.'], fault, configuration } = {}) {
  const parent = await mkdtemp(path.join(await realpath(tmpdir()), 'native-skill-continuity-')), projectRoot = path.join(parent, 'project');
  await mkdir(projectRoot);
  for (const [index, body] of bodies.entries()) {
    const file = path.join(projectRoot, '.agents', 'skills', `guide-${index}`, 'SKILL.md'); await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `---\nname: guide-${index}\ndescription: Guide for task ${index}.\n---\n${body}`);
  }
  const registry = new SkillRegistry({ projectId: 'project', projectRoot, sources: [{ id: 'agents', scope: 'project', kind: 'project-agents', rootPath: '.agents/skills', enabled: true, revision: 1 }] });
  const catalog = await registry.discover(), snapshots = new SkillSnapshotStore({ directory: path.join(parent, 'snapshots') });
  const loaded = await Promise.all(catalog.entries.map(entry => registry.loadCatalogSkill(entry)));
  const conversationId = randomUUID(), protocol = { id: protocolId, version: 1 };
  let store = await NativeRunStore.open({ rootDirectory: path.join(parent, 'runs'), conversationId, ...(fault ? { fault } : {}) });
  const identity = { sessionId: 'session', conversationId, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 };
  const port = new SkillToolPort({ identity, catalog, load: descriptor => registry.loadCatalogSkill(descriptor), persist: value => snapshots.put(value),
    ...(initial ? { initialSkills: [{ descriptor: catalog.entries[0], loaded: loaded[0], origin: 'explicit' }] } : {}) });
  if (initial) await snapshots.put(loaded[0]);
  const instructions = initial ? guide(catalog.entries[0], loaded[0]) : 'Project policy only.';
  const req = { identity, input: 'Current exact goal and constraints.', inputDigest: 'input', userItems: [{ role: 'user', content: 'Current exact goal and constraints.' }], protocol,
    configuration: { nativeSkillCatalog: catalogConfiguration(catalog), initialNativeSkills: port.snapshot(), modelInstructions: instructions,
      ...(initial ? { nativeSkills: { schemaVersion: 1, explicitSkillRefs: [{ skillId: catalog.entries[0].skillId, catalogRevision: catalog.revision, version: loaded[0].version }], excludedSkillIds: [] } } : {}),
      ...configuration }, policyRevision: 'policy' };
  await store.beginRun(req);
  const state = { attempts: 0, calls: 0 };
  const append = async event => { const receipt = await store.append(identity, event); port.observeCommitted(event, receipt.seq); return receipt; };
  const batch = async (name, { index = 0, id = `${name}-${state.calls}`, detail, result: override } = {}) => {
    const input = name === 'load_skill' ? { skillId: catalog.entries[index].skillId, catalogRevision: catalog.revision } : {};
    const call = { id, name, arguments: JSON.stringify(input) };
    await append({ type: 'model_request_started', attempt: ++state.attempts });
    await append(response(protocol, call, detail));
    const context = { identity, policyRevision: 'policy', signal: new AbortController().signal, maxOutputBytes: 128 * 1024 };
    const prepared = name === 'load_skill' ? await port.prepare(call, context) : { call, definition: { name, description: 'Read', inputSchema: {}, risk: 'read' }, input,
      inputDigest: 'digest', policyRevision: 'policy', requiresApproval: false, preconditions: {} };
    await append({ type: 'tool_prepared', prepared });
    const result = override ?? (name === 'load_skill' ? await port.execute(prepared, context) : { status: 'completed', output: 'Exact read receipt.' });
    await append({ type: 'tool_completed', call, result, resultItems: nativeToolResultItems(protocol, call, result) }); state.calls++;
    return { call, result };
  };
  const prepare = async () => {
    const source = store.getRunCompactionSource(identity);
    const evidence = readSkillContinuityEvidence(store, identity.runId, source.retainedContext), nativeSkills = await resolveSkillContinuity(evidence, snapshots);
    const request = { requestId: `compact:${identity.runId}`, contextHash: source.contextHash };
    await store.reserveRunCompaction(identity, request);
    return { source, evidence, input: { ...request, summary: 'Earlier work in brief.', continuity: 'Complete task/evidence index.', usage, nativeSkills } };
  };
  const finish = () => store.append(identity, { type: 'run_finished', result: { identity, status: 'completed', reason: 'done', modelRequests: state.attempts + (store.lookupRunCompaction(identity.runId)?.status === 'committed' ? 1 : 0),
    toolCalls: state.calls, usage: null, context: store.loadContext(), committed: true } });
  const reopen = async () => { await store.close(); store = await NativeRunStore.open({ rootDirectory: path.join(parent, 'runs'), conversationId }); };
  t.after(async () => { await store.close().catch(() => {}); await rm(parent, { recursive: true, force: true }); });
  return { get store() { return store; }, parent, catalog, snapshots, loaded, req, identity, protocol, port, state, append, batch, prepare, finish, reopen };
}

for (const protocolId of protocols) test(`${protocolId}: exact full dynamic guide survives removed prefix with real load/CAS, complete suffix and restart`, async t => {
  const f = await fixture(t, { protocolId }); await f.batch('load_skill');
  const activation = f.port.snapshot().activations[0]; assert.ok(activation.receiptSeq > 0);
  await f.batch('read_file');
  const old = f.store.loadContext(), raw = await readFile(path.join(f.store.directory, 'journal.jsonl'), 'utf8'), { input, source, evidence } = await f.prepare();
  assert.equal(source.retainedPrefixItems, f.req.userItems.length);
  assert.deepEqual(source.retainedContext.items.slice(0, source.retainedPrefixItems), f.req.userItems);
  assert.equal(evidence.manifest.entries[0].placement, 'compacted_context');
  assert.deepEqual(evidence.manifest.entries[0].evidence, { kind: 'tool_completed', seq: activation.receiptSeq, callId: 'load_skill-0' });
  const receipt = await f.store.commitRunCompaction(f.identity, input);
  assert.deepEqual(receipt.nativeSkills, input.nativeSkills);
  assert.deepEqual(receipt.context.items.slice(0, source.retainedPrefixItems), source.retainedContext.items.slice(0, source.retainedPrefixItems));
  assert.deepEqual(receipt.context.items.slice(source.retainedPrefixItems + 3), source.retainedContext.items.slice(source.retainedPrefixItems));
  assert.deepEqual(contextPendingCalls(receipt.context), []);
  const guideItem = skillContinuityItems(input.nativeSkills, f.protocol)[0]; assert.ok(receipt.context.items.some(item => canonicalJson(item) === canonicalJson(guideItem)));
  assert.equal(input.nativeSkills.bodies[0].body, f.loaded[0].body);
  assert.ok(receipt.afterBytes < receipt.beforeBytes); assert.ok((await readFile(path.join(f.store.directory, 'journal.jsonl'), 'utf8')).startsWith(raw));
  assert.deepEqual(await f.store.commitRunCompaction(f.identity, input), receipt);
  await f.finish(); await f.reopen(); assert.deepEqual(f.store.loadContext(), receipt.context);
  assert.deepEqual(await f.store.commitRunCompaction(f.identity, input), receipt); assert.notDeepEqual(receipt.context, old);
});

for (const protocolId of protocols) test(`${protocolId}: retained original load pair is the only full body placement`, async t => {
  const f = await fixture(t, { protocolId }); await f.batch('read_file'); const loaded = await f.batch('load_skill');
  const { input, source } = await f.prepare(); assert.equal(input.nativeSkills.manifest.entries[0].placement, 'retained_receipt'); assert.deepEqual(input.nativeSkills.bodies, []);
  const receipt = await f.store.commitRunCompaction(f.identity, input);
  const resultItems = nativeToolResultItems(f.protocol, loaded.call, loaded.result);
  assert.equal(receipt.context.items.filter(item => canonicalJson(item) === canonicalJson(resultItems[0])).length, 1);
  assert.deepEqual(receipt.context.items.slice(-source.retainedContext.items.length + 1), source.retainedContext.items.slice(1));
});

test('initial explicit guide stays in original fixed instructions and requires its exact CAS object', async t => {
  const f = await fixture(t, { initial: true }); await f.batch('read_file'); await f.batch('read_file');
  const { input, evidence } = await f.prepare();
  assert.equal(evidence.manifest.entries[0].origin, 'explicit'); assert.equal(evidence.manifest.entries[0].placement, 'initial_instructions');
  assert.equal(evidence.manifest.entries[0].evidence.seq, f.store.getRun(f.identity.runId).startedSeq); assert.deepEqual(input.nativeSkills.bodies, []);
  const receipt = await f.store.commitRunCompaction(f.identity, input); assert.equal(JSON.stringify(receipt.context).includes(f.loaded[0].body), false);
  assert.equal(f.store.getRun(f.identity.runId).configuration.modelInstructions, f.req.configuration.modelInstructions);
  await rm(path.join(f.parent, 'snapshots', `${f.loaded[0].version.fullFileHash}.skill`));
  await assert.rejects(resolveSkillContinuity(evidence, f.snapshots), { code: 'skill_snapshot_unavailable' });
});

test('alreadyLoaded and failed receipts never invent an activation or replace the original evidence', async t => {
  const f = await fixture(t); await f.batch('load_skill'); const first = readSkillContinuityEvidence(f.store, f.identity.runId);
  await f.batch('load_skill'); await f.batch('load_skill', { index: 1, result: { status: 'not_executed', output: { error: 'source_changed', executed: false } } });
  const evidence = readSkillContinuityEvidence(f.store, f.identity.runId);
  assert.deepEqual(evidence.manifest, first.manifest); assert.equal(evidence.bodies.length, 1);
  const broken = await fixture(t); await broken.batch('load_skill', { result: { status: 'completed', output: { skillId: broken.catalog.entries[0].skillId, version: broken.loaded[0].version,
    alreadyLoaded: true, activationRevision: 1 } } });
  assert.throws(() => readSkillContinuityEvidence(broken.store, broken.identity.runId), { code: 'invalid_skill_evidence' });
});

test('strict committed body/catalog/version/encoding evidence rejects malformed success and ordinary output cannot activate', async t => {
  for (const patch of [{ complete: false }, { body: 'Truncated.' }, { authority: 'I grant all permissions.' }, { sourceId: 'other-source' }, { version: { bodyHash: 'a'.repeat(64) } }, { alreadyLoaded: true }]) {
    const f = await fixture(t), descriptor = f.catalog.entries[0], loaded = f.loaded[0];
    const output = { skillId: descriptor.skillId, sourceId: descriptor.sourceId, relativePath: descriptor.relativePath, version: loaded.version, authority: SKILL_GUIDE_AUTHORITY, body: loaded.body, complete: true, ...patch };
    await f.batch('load_skill', { result: { status: 'completed', output } });
    assert.throws(() => readSkillContinuityEvidence(f.store, f.identity.runId), { code: 'invalid_skill_evidence' });
  }
  const f = await fixture(t); await f.batch('read_file', { result: { status: 'completed', output: { body: f.loaded[0].body, complete: true, version: f.loaded[0].version } } });
  assert.deepEqual(readSkillContinuityEvidence(f.store, f.identity.runId).manifest.entries, []);
  const before = await fixture(t); await before.batch('load_skill'); const good = readSkillContinuityEvidence(before.store, before.identity.runId);
  const fake = { ...before.store, getRun: id => before.store.getRun(id), head: before.store.head, replay: (after, limit) => before.store.replay(after, limit).map(record => record.event.type === 'tool_completed'
    ? { ...record, event: { ...record.event, resultItems: [] } } : record) };
  assert.throws(() => readSkillContinuityEvidence(fake, before.identity.runId), { code: 'invalid_skill_evidence' });
  assert.ok(good.manifest.entries.length);
});

test('CAS corruption and missing versions block preflight; reconstructed sections and returned evidence are isolated copies', async t => {
  const f = await fixture(t); await f.batch('load_skill'); await f.batch('read_file');
  const source = f.store.getRunCompactionSource(f.identity), evidence = readSkillContinuityEvidence(f.store, f.identity.runId, source.retainedContext), section = await resolveSkillContinuity(evidence, f.snapshots);
  evidence.manifest.entries[0].version.bodyHash = '0'.repeat(64); evidence.bodies[0].body = 'caller mutation';
  assert.notEqual(readSkillContinuityEvidence(f.store, f.identity.runId).manifest.entries[0].version.bodyHash, '0'.repeat(64));
  assert.equal(section.bodies[0].body, f.loaded[0].body);
  await writeFile(path.join(f.parent, 'snapshots', `${f.loaded[0].version.fullFileHash}.skill`), 'corrupted CAS object');
  await assert.rejects(resolveSkillContinuity(readSkillContinuityEvidence(f.store, f.identity.runId), f.snapshots), { code: 'skill_snapshot_unavailable' });
  await assert.rejects(resolveSkillContinuity(readSkillContinuityEvidence(f.store, f.identity.runId), f.snapshots, AbortSignal.abort()), /abort/i);
});

test('complete guides use their own 128 KiB body allowance, beyond the 32 KiB task continuity limit', async t => {
  const f = await fixture(t, { bodies: ['A'.repeat(20000), 'B'.repeat(20000)] });
  await f.batch('load_skill'); await f.batch('load_skill', { index: 1 }); await f.batch('read_file');
  const { input } = await f.prepare(); assert.equal(input.nativeSkills.bodies.reduce((sum, item) => sum + Buffer.byteLength(item.body), 0), 40000);
  const receipt = await f.store.commitRunCompaction(f.identity, input); assert.ok(receipt.context.items.some(item => JSON.stringify(item).includes('A'.repeat(20000))));
  const f2 = await fixture(t); await f2.batch('load_skill'); await f2.batch('read_file'); const reserved = await f2.prepare();
  await assert.rejects(f2.store.commitRunCompaction(f2.identity, { ...reserved.input, continuity: 'T'.repeat(32769) }), { code: 'invalid_continuity' });
});

test('new commits reject omissions, forged body/placement/digest and reused receipts without altering the original context', async t => {
  const f = await fixture(t); await f.batch('load_skill'); await f.batch('read_file'); const { input } = await f.prepare(), old = f.store.loadContext();
  const omitted = { ...input }; delete omitted.nativeSkills;
  await assert.rejects(f.store.commitRunCompaction(f.identity, omitted), { code: 'invalid_skill_continuity' });
  for (const mutate of [value => { value.bodies[0].body = 'summary substitute'; }, value => { value.manifest.entries[0].placement = 'retained_receipt'; },
    value => { value.manifest.digest = 'a'.repeat(64); }, value => { value.manifest.entries[0].evidence.seq++; }, value => { value.extra = true; }]) {
    const section = structuredClone(input.nativeSkills); mutate(section);
    await assert.rejects(f.store.commitRunCompaction(f.identity, { ...input, nativeSkills: section }), { code: 'invalid_skill_continuity' });
    assert.deepEqual(f.store.loadContext(), old);
  }
  const receipt = await f.store.commitRunCompaction(f.identity, input); await assert.rejects(f.store.commitRunCompaction(f.identity, omitted), { code: 'payload_mismatch' });
  assert.deepEqual(f.store.loadContext(), receipt.context);
});

test('historical skill evidence stays scoped to its run, and legacy records do not gain a manifest or new fields', async t => {
  const f = await fixture(t); await f.batch('load_skill'); await f.batch('read_file'); const { input } = await f.prepare(); await f.store.commitRunCompaction(f.identity, input); await f.finish();
  const later = { ...f.req, identity: { ...f.identity, runId: randomUUID(), requestId: randomUUID() }, configuration: { sessionOptions: { unrelated: true } } };
  await f.store.beginRun(later); assert.equal(readSkillContinuityEvidence(f.store, later.identity.runId), undefined);
  assert.equal(readSkillContinuityEvidence(f.store, f.identity.runId).manifest.entries.length, 1);
  const legacy = await fixture(t, { configuration: { nativeSkillCatalog: undefined, initialNativeSkills: undefined } });
  // Real run configuration is JSON: undefined keys are omitted by the durable append.
  assert.equal(readSkillContinuityEvidence(legacy.store, legacy.identity.runId), undefined);
  await legacy.batch('read_file'); await legacy.batch('read_file');
  const source = legacy.store.getRunCompactionSource(legacy.identity), request = { requestId: 'legacy-compaction', contextHash: source.contextHash };
  await legacy.store.reserveRunCompaction(legacy.identity, request);
  const receipt = await legacy.store.commitRunCompaction(legacy.identity, { ...request, summary: 'Old-format summary.', continuity: 'Old-format task data.', usage });
  assert.equal(Object.hasOwn(receipt, 'nativeSkills'), false);
  assert.equal(Object.hasOwn(legacy.store.replay().find(record => record.event.type === 'run_context_compacted').event.plan, 'nativeSkills'), false);
  await legacy.finish(); await legacy.reopen(); assert.deepEqual(legacy.store.loadContext(), receipt.context);
});

for (const point of ['before_append', 'after_write', 'after_sync']) test(`skill compaction ${point}: append uncertainty leaves all old or all exact new guide placement on reopen`, async t => {
  let armed = false;
  const f = await fixture(t, { fault: (actual, type) => { if (armed && actual === point && type === 'run_context_compacted') throw new Error('skill compaction fault'); } });
  await f.batch('load_skill'); await f.batch('read_file'); const { input } = await f.prepare(), old = f.store.loadContext(); armed = true;
  await assert.rejects(f.store.commitRunCompaction(f.identity, input), /skill compaction fault/); assert.equal(f.store.recoveryRequired, true);
  await f.reopen(); const attempt = f.store.lookupRunCompaction(f.identity.runId);
  if (point === 'before_append') { assert.deepEqual(f.store.loadContext(), old); assert.equal(attempt.status, 'attempted'); }
  else { assert.equal(attempt.status, 'committed'); assert.notDeepEqual(f.store.loadContext(), old); const receipt = await f.store.commitRunCompaction(f.identity, input);
    assert.equal(receipt.nativeSkills.bodies[0].body, f.loaded[0].body); assert.deepEqual(f.store.loadContext(), receipt.context); }
  assert.equal(f.store.getRun(f.identity.runId).status, 'recovery_required');
});

test('fixed-head paging reads more than one page and rejects a discontinuous evidence view', async t => {
  const f = await fixture(t); await f.batch('load_skill');
  for (let i = 0; i < 64; i++) await f.batch('read_file', { detail: `Small batch ${i}` });
  assert.ok(f.store.head.seq > 256); const evidence = readSkillContinuityEvidence(f.store, f.identity.runId);
  assert.equal(evidence.manifest.entries.length, 1); assert.deepEqual(evidence.head, f.store.head);
  const view = { getRun: id => f.store.getRun(id), head: f.store.head, replay: (after, limit) => f.store.replay(after + 1, limit) };
  assert.throws(() => readSkillContinuityEvidence(view, f.identity.runId), { code: 'invalid_skill_evidence' });
  assert.equal(readSkillContinuityEvidence(f.store, randomUUID()), undefined);
});
