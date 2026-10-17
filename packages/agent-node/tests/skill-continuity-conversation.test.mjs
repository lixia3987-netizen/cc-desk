import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalJson } from '@cc-desk/agent-core';
import { NativeRunStore, nativeSubmissionInputDigest } from '../dist/run-store.js';
import { SkillRegistry } from '../dist/skill-registry.js';
import { SkillSnapshotStore } from '../dist/skill-snapshots.js';
import { SkillToolPort } from '../dist/skill-tools.js';
import { nativeToolResultItems, contextSummaryItem } from '../dist/context-maintenance.js';
import { readConversationSkillContinuityEvidence, resolveConversationSkillContinuity, conversationSkillContinuityItems } from '../dist/skill-continuity.js';

const protocols = ['openai-responses', 'openai-chat-completions', 'anthropic-messages'];
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const catalogConfiguration = catalog => ({ revision: catalog.revision, entries: catalog.entries.map(({ skillId, sourceId, relativePath, sourceRevision, sourceFingerprint, metadataHash, format }) =>
  ({ skillId, sourceId, relativePath, sourceRevision, sourceFingerprint, metadataHash, format })), truncated: catalog.truncated });
const guide = (descriptor, loaded) => `Native skill guide ${descriptor.skillId} (${descriptor.sourceId}/${descriptor.relativePath}), version ${loaded.version.fullFileHash}:\n${loaded.body}`;
function output(protocol, detail, call) {
  if (protocol.id === 'openai-chat-completions') return [{ role: 'assistant', content: detail,
    ...(call ? { tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }] } : {}) }];
  if (protocol.id === 'anthropic-messages') return [{ role: 'assistant', content: [{ type: 'text', text: detail },
    ...(call ? [{ type: 'tool_use', id: call.id, name: call.name, input: JSON.parse(call.arguments) }] : [])] }];
  return [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: detail }] },
    ...(call ? [{ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments }] : [])];
}
async function fixture(t, { protocolId = protocols[0], fault } = {}) {
  const parent = await mkdtemp(path.join(await realpath(tmpdir()), 'native-conversation-skill-')), projectRoot = path.join(parent, 'project');
  const skillFile = path.join(projectRoot, '.agents', 'skills', 'guide', 'SKILL.md');
  await mkdir(path.dirname(skillFile), { recursive: true });
  const snapshots = new SkillSnapshotStore({ directory: path.join(parent, 'snapshots') });
  const conversationId = randomUUID(), rootDirectory = path.join(parent, 'runs'), protocol = { id: protocolId, version: 1 };
  let store = await NativeRunStore.open({ rootDirectory, conversationId, ...(fault ? { fault } : {}) });
  let generation = 0;
  const setBody = async body => {
    await writeFile(skillFile, `---\nname: guide\ndescription: Relevant task guide.\n---\n${body}`);
    const registry = new SkillRegistry({ projectId: 'project', projectRoot, sources: [{ id: 'agents', scope: 'project', kind: 'project-agents', rootPath: '.agents/skills', enabled: true, revision: 1 }] });
    const catalog = await registry.discover(), loaded = await registry.loadCatalogSkill(catalog.entries[0]);
    await snapshots.put(loaded);
    return { registry, catalog, loaded };
  };
  const start = async ({ selected, initial = false, dynamic = false, detail = 'Detailed prior observations. '.repeat(2000), beforeBegin } = {}) => {
    const identity = { sessionId: 'session', conversationId, runId: randomUUID(), requestId: randomUUID(), workerGeneration: ++generation };
    const port = selected ? new SkillToolPort({ identity, catalog: selected.catalog, load: descriptor => selected.registry.loadCatalogSkill(descriptor), persist: value => snapshots.put(value),
      ...(initial ? { initialSkills: [{ descriptor: selected.catalog.entries[0], loaded: selected.loaded, origin: 'explicit' }] } : {}) }) : undefined;
    const request = { identity, input: `Goal ${identity.workerGeneration}`, inputDigest: 'input', userItems: [{ role: 'user', content: `Goal ${identity.workerGeneration}` }], protocol,
      configuration: { modelInstructions: initial ? guide(selected.catalog.entries[0], selected.loaded) : 'Current project policy.',
        ...(selected ? { nativeSkillCatalog: catalogConfiguration(selected.catalog), initialNativeSkills: port.snapshot() } : {}),
        ...(initial ? { nativeSkills: { schemaVersion: 1, explicitSkillRefs: [{ skillId: selected.loaded.version.skillId, catalogRevision: selected.catalog.revision, version: selected.loaded.version }], excludedSkillIds: [] } } : {}) }, policyRevision: 'policy' };
    await beforeBegin?.(request);
    await store.beginRun(request);
    let attempts = 0, calls = 0;
    const batch = async useSkill => {
      const call = useSkill ? { id: randomUUID(), name: 'load_skill', arguments: JSON.stringify({ skillId: selected.loaded.version.skillId, catalogRevision: selected.catalog.revision }) } : undefined;
      await store.append(identity, { type: 'model_request_started', attempt: ++attempts });
      const response = { type: 'model_response', response: { outputItems: output(protocol, detail, call), toolCalls: call ? [call] : [], finishReason: call ? 'tool_calls' : 'completed', usage: null } };
      const receipt = await store.append(identity, response); port?.observeCommitted(response, receipt.seq);
      if (!call) return;
      const context = { identity, policyRevision: 'policy', signal: new AbortController().signal, maxOutputBytes: 128 * 1024 };
      const prepared = await port.prepare(call, context);
      await store.append(identity, { type: 'tool_prepared', prepared });
      const result = await port.execute(prepared, context), event = { type: 'tool_completed', call, result, resultItems: nativeToolResultItems(protocol, call, result) };
      const committed = await store.append(identity, event); port.observeCommitted(event, committed.seq); calls++;
      return event;
    };
    const loadedEvent = await batch(dynamic);
    const finish = async () => {
      if (dynamic && attempts === 1) await batch(false);
      await store.append(identity, { type: 'run_finished', result: { identity, status: 'completed', modelRequests: attempts + (store.lookupRunCompaction(identity.runId)?.status === 'committed' ? 1 : 0),
        toolCalls: calls, usage: null, context: store.loadContext(), committed: true } });
    };
    return { identity, request, batch, finish, loadedEvent, port };
  };
  const idle = async () => {
    const source = store.getCompactionSource(), evidence = readConversationSkillContinuityEvidence(store, source.retainedContext);
    const nativeSkills = evidence && await resolveConversationSkillContinuity(evidence, snapshots);
    return { source, evidence, nativeSkills, plan: store.planContextCompaction({ summary: 'Earlier work summarized.', expectedHash: source.expectedHash, ...(nativeSkills ? { nativeSkills } : {}) }) };
  };
  t.after(async () => { await store.close().catch(() => {}); await rm(parent, { recursive: true, force: true }); });
  return { get store() { return store; }, parent, skillFile, snapshots, protocol, setBody, start, idle,
    reopen: async () => { await store.close(); store = await NativeRunStore.open({ rootDirectory, conversationId }); }, rootDirectory, conversationId };
}

async function appendLegacyCompaction(f, latestRunId) {
  const source = f.store.getCompactionSource(), prefix = [...source.retainedContext.items.slice(0, source.retainedPrefixItems), contextSummaryItem('Legacy summary.', f.protocol)];
  const context = { protocol: f.protocol, items: [...prefix, ...source.retainedContext.items.slice(source.retainedPrefixItems)] };
  const plan = { expectedHash: source.expectedHash, sourceSeq: source.sourceSeq, summary: 'Legacy summary.', keepRecentTurns: 1, beforeBytes: source.beforeBytes,
    afterBytes: Buffer.byteLength(JSON.stringify(context)), context, retainedTurns: [{ runId: latestRunId, start: prefix.length }] };
  const directory = f.store.directory, head = f.store.head; await f.store.close();
  const record = { schemaVersion: 1, conversationId: f.conversationId, seq: head.seq + 1, committedAt: new Date().toISOString(), previousHash: head.hash,
    event: { type: 'context_compacted', plan } };
  await appendFile(path.join(directory, 'journal.jsonl'), canonicalJson({ ...record, hash: hash(record) }) + '\n');
  return context;
}

for (const protocolId of protocols) test(`${protocolId}: idle compaction restores initial guide body as historical evidence, exact order and restart`, async t => {
  const f = await fixture(t, { protocolId }), selected = await f.setBody('Exact initial guide 中文\r\nDo not erase the original project.');
  const first = await f.start({ selected, initial: true }); await first.finish();
  const second = await f.start(); await second.finish();
  const { source, nativeSkills, plan } = await f.idle();
  assert.equal(source.retainedPrefixItems, first.request.userItems.length);
  assert.equal(nativeSkills.manifest.entries.length, 1);
  assert.equal(nativeSkills.manifest.entries[0].identity.runId, first.identity.runId);
  assert.equal(nativeSkills.manifest.entries[0].evidence.kind, 'run_started');
  assert.equal(nativeSkills.bodies[0].body, selected.loaded.body);
  const marker = conversationSkillContinuityItems(nativeSkills, f.protocol);
  assert.deepEqual(plan.context.items.slice(source.retainedPrefixItems + 1, source.retainedPrefixItems + 1 + marker.length), marker);
  assert.deepEqual(plan.context.items.slice(source.retainedPrefixItems + 1 + marker.length), source.retainedContext.items.slice(source.retainedPrefixItems));
  assert.throws(() => f.store.planContextCompaction({ summary: 'Cannot drop bodies.' }), { code: 'invalid_skill_continuity' });
  await f.store.commitContextCompaction(plan);
  await f.reopen(); assert.deepEqual(f.store.loadContext(), plan.context);
  assert.deepEqual(await f.store.commitContextCompaction(plan), { seq: f.store.head.seq });
  const next = await f.start(); assert.equal(next.port, undefined); await next.finish();
  assert.equal(f.store.getRun(next.identity.runId).configuration.initialNativeSkills, undefined);
});

test('distinct old versions preserve earliest provenance, identical versions deduplicate, deleted historical sources are allowed', async t => {
  const f = await fixture(t), firstVersion = await f.setBody('Guide version one.'), first = await f.start({ selected: firstVersion, initial: true }); await first.finish();
  const secondVersion = await f.setBody('Guide version two.'), second = await f.start({ selected: secondVersion, dynamic: true }); await second.finish();
  const third = await f.start({ selected: secondVersion, initial: true }); await third.finish();
  await rm(f.skillFile);
  const { nativeSkills } = await f.idle();
  assert.equal(nativeSkills.manifest.entries.length, 2);
  assert.deepEqual(new Set(nativeSkills.manifest.entries.map(entry => entry.identity.runId)), new Set([first.identity.runId, second.identity.runId]));
  assert.deepEqual(new Set(nativeSkills.bodies.map(entry => entry.body)), new Set(['Guide version one.', 'Guide version two.']));
  const excluded = readConversationSkillContinuityEvidence(f.store, undefined, first.identity.runId);
  assert.equal(excluded.manifest.entries.length, 1);
  assert.equal(excluded.manifest.entries[0].identity.runId, second.identity.runId);
});

test('approved stdio startup sharing a run identity is not mistaken for its activation start', async t => {
  const f = await fixture(t), selected = await f.setBody('Exact guide belonging to the actual run start.');
  const first = await f.start({ selected, initial: true, beforeBegin: async request => {
    request.configuration.sessionOptions = { connectionId: 'fixture', mcpConnections: ['local'] };
    request.inputDigest = nativeSubmissionInputDigest(request.input, undefined, request.configuration.nativeSkills);
    const launch = { identity: request.identity, startupId: 'test_stdio', inputDigest: request.inputDigest,
      optionsDigest: createHash('sha256').update(canonicalJson(request.configuration.sessionOptions) + canonicalJson(request.configuration.nativeSkills)).digest('hex'),
      policyRevision: 'startup-policy', metadata: { cwd: '/fixture', servers: [{ id: 'local', revision: 1 }] } };
    await f.store.prepareStartup({ ...launch, approval: { binding: { ...request.identity, toolCallId: launch.startupId,
      inputDigest: hash(launch.metadata), policyRevision: launch.policyRevision }, decision: 'approved', expiresAt: Date.now() + 60_000 } });
  } });
  await first.finish(); await f.store.closeStartup(first.identity, 'test_stdio');
  const second = await f.start(); await second.finish();
  const { nativeSkills, plan } = await f.idle();
  assert.equal(nativeSkills.manifest.entries[0].evidence.seq, f.store.getRun(first.identity.runId).startedSeq);
  assert.equal(f.store.replay().find(record => record.identity?.runId === first.identity.runId).event.type, 'startup_prepared');
  await f.store.commitContextCompaction(plan); await f.reopen(); assert.deepEqual(f.store.loadContext(), plan.context);
});

test('only exact real retained receipts and host history sections prevent duplicate full bodies; ordinary marker text does not', async t => {
  const f = await fixture(t), selected = await f.setBody('Guide kept in the actual tool result.');
  const first = await f.start(); await first.finish();
  const second = await f.start({ selected, dynamic: true }); await second.finish();
  const { source, nativeSkills, plan } = await f.idle();
  assert.equal(nativeSkills.manifest.entries[0].placement, 'retained_context'); assert.deepEqual(nativeSkills.bodies, []);
  const spoof = { ...source.retainedContext, items: output(f.protocol, 'native_skill_history ' + selected.loaded.body) };
  const spoofEvidence = readConversationSkillContinuityEvidence(f.store, spoof);
  assert.equal(spoofEvidence.manifest.entries[0].placement, 'compacted_context');
  await f.store.commitContextCompaction(plan);
  const exactHost = { ...plan.context, items: [...conversationSkillContinuityItems({ ...nativeSkills, manifest: { ...nativeSkills.manifest } }, f.protocol)] };
  // This real host section has no body: retained receipt remains essential.
  const hostOnly = readConversationSkillContinuityEvidence(f.store, exactHost);
  assert.equal(hostOnly.manifest.entries[0].placement, 'compacted_context');
  const retained = readConversationSkillContinuityEvidence(f.store, f.store.loadContext());
  assert.equal(retained.manifest.entries[0].placement, 'retained_context');
});

test('caller-forged body, provenance, placement, digest, section shape and omitted commit section cannot alter history', async t => {
  const f = await fixture(t), selected = await f.setBody('Immutable original guide.');
  const first = await f.start({ selected, initial: true }); await first.finish(); const second = await f.start(); await second.finish();
  const { plan, nativeSkills } = await f.idle(), before = f.store.loadContext();
  for (const mutate of [value => { value.bodies[0].body = 'Forged guide.'; }, value => { value.manifest.entries[0].evidence.seq++; },
    value => { value.manifest.entries[0].placement = 'retained_context'; value.bodies = []; }, value => { value.manifest.digest = 'a'.repeat(64); },
    value => { value.extra = true; }, value => { value.bodies.push(value.bodies[0]); }]) {
    const changed = structuredClone(nativeSkills); mutate(changed);
    assert.throws(() => f.store.planContextCompaction({ summary: 'Forgery.', nativeSkills: changed }));
    assert.deepEqual(f.store.loadContext(), before);
  }
  const omitted = structuredClone(plan); delete omitted.nativeSkills;
  await assert.rejects(f.store.commitContextCompaction(omitted), { code: 'invalid_skill_continuity' });
  await f.store.commitContextCompaction(plan);
  await assert.rejects(f.store.commitContextCompaction(omitted), { code: 'payload_mismatch' });
});

test('a real host historical body can be retained exactly and later prefix replacement reconstitutes it once', async t => {
  const f = await fixture(t), selected = await f.setBody('One original historical guide, never a new activation.');
  const first = await f.start({ selected, initial: true }); await first.finish(); const second = await f.start(); await second.finish();
  const initial = await f.idle(); await f.store.commitContextCompaction(initial.plan);
  const retained = readConversationSkillContinuityEvidence(f.store, f.store.loadContext());
  assert.equal(retained.manifest.entries[0].placement, 'retained_context');
  assert.deepEqual((await resolveConversationSkillContinuity(retained, f.snapshots)).bodies, []);
  const third = await f.start(); await third.finish(); const replacement = await f.idle();
  assert.equal(replacement.nativeSkills.bodies.length, 1); assert.equal(replacement.nativeSkills.bodies[0].body, selected.loaded.body);
  await f.store.commitContextCompaction(replacement.plan);
  const rendered = JSON.stringify(f.store.loadContext());
  assert.equal(rendered.split(selected.loaded.body).length - 1, 1);
  assert.equal(replacement.nativeSkills.manifest.entries[0].identity.runId, first.identity.runId);
});

test('CAS corruption and missing original bytes block historical resolution even if the guide is retained', async t => {
  const f = await fixture(t), selected = await f.setBody('Exact retained original bytes.');
  const first = await f.start(); await first.finish(); const second = await f.start({ selected, dynamic: true }); await second.finish();
  const evidence = readConversationSkillContinuityEvidence(f.store, f.store.getCompactionSource().retainedContext);
  await writeFile(path.join(f.parent, 'snapshots', `${selected.loaded.version.fullFileHash}.skill`), 'corrupt');
  await assert.rejects(resolveConversationSkillContinuity(evidence, f.snapshots), { code: 'skill_snapshot_unavailable' });
  await rm(path.join(f.parent, 'snapshots', `${selected.loaded.version.fullFileHash}.skill`));
  await assert.rejects(resolveConversationSkillContinuity(evidence, f.snapshots), { code: 'skill_snapshot_unavailable' });
  await assert.rejects(resolveConversationSkillContinuity(evidence, f.snapshots, AbortSignal.abort()), /abort/i);
});

test('later in-run compaction requires separate historical section and never treats it as current activation', async t => {
  const f = await fixture(t), selected = await f.setBody('Previous-turn guide must survive the next in-run summary.');
  const first = await f.start({ selected, initial: true }); await first.finish();
  const current = await f.start(); await current.batch(false);
  const source = f.store.getRunCompactionSource(current.identity);
  const evidence = readConversationSkillContinuityEvidence(f.store, source.retainedContext, current.identity.runId);
  const historicalSkills = await resolveConversationSkillContinuity(evidence, f.snapshots);
  const request = { requestId: randomUUID(), contextHash: source.contextHash }; await f.store.reserveRunCompaction(current.identity, request);
  const input = { ...request, summary: 'Earlier batches summarized.', continuity: 'Current task evidence.', usage: null };
  await assert.rejects(f.store.commitRunCompaction(current.identity, input), { code: 'invalid_skill_continuity' });
  const committed = await f.store.commitRunCompaction(current.identity, { ...input, historicalSkills });
  assert.equal(committed.nativeSkills, undefined); assert.deepEqual(committed.historicalSkills, historicalSkills);
  assert.ok(JSON.stringify(committed.context).includes(selected.loaded.body));
  await current.finish(); await f.reopen(); assert.deepEqual(f.store.loadContext(), committed.context);
});

test('legacy idle compaction without historical section remains replayable; future commits must restore original guides', async t => {
  const f = await fixture(t), selected = await f.setBody('Exact pre-upgrade historical guide.');
  const first = await f.start({ selected, initial: true }); await first.finish(); const second = await f.start(); await second.finish();
  const context = await appendLegacyCompaction(f, second.identity.runId);
  await f.reopen(); assert.deepEqual(f.store.loadContext(), context);
  const third = await f.start(); await third.finish(); const restored = await f.idle();
  assert.equal(restored.nativeSkills.bodies[0].body, selected.loaded.body);
  await f.store.commitContextCompaction(restored.plan); await f.reopen(); assert.deepEqual(f.store.loadContext(), restored.plan.context);
});

test('new historical guide bodies have a total 128 KiB bound across distinct versions', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) {
    const selected = await f.setBody(`${i}${'X'.repeat(28000)}`), next = await f.start({ selected, initial: true, detail: 'Small complete response.' }); await next.finish();
  }
  const evidence = readConversationSkillContinuityEvidence(f.store, f.store.getCompactionSource().retainedContext);
  assert.equal(evidence.manifest.entries.length, 5);
  await assert.rejects(resolveConversationSkillContinuity(evidence, f.snapshots), { code: 'invalid_skill_continuity' });
});

test('legacy absent-field replay stays readable when historical versions exceed a new bound', async t => {
  const f = await fixture(t), selected = await f.setBody('Small exact body.');
  let last;
  for (let i = 1; i <= 257; i++) {
    const versioned = structuredClone({ catalog: selected.catalog, loaded: selected.loaded }); versioned.registry = selected.registry;
    versioned.catalog.entries[0].sourceRevision = i; versioned.loaded.version.sourceRevision = i;
    last = await f.start({ selected: versioned, initial: true, detail: 'Small complete response.' }); await last.finish();
  }
  assert.throws(() => readConversationSkillContinuityEvidence(f.store), { code: 'invalid_skill_continuity' });
  const context = await appendLegacyCompaction(f, last.identity.runId);
  await f.reopen(); assert.deepEqual(f.store.loadContext(), context); assert.equal(f.store.listRuns().length, 257);
  const next = await f.start({ detail: 'Later small complete response.' }); await next.finish();
  assert.throws(() => f.store.planContextCompaction({ summary: 'A new replacement cannot silently drop versions.' }), { code: 'invalid_skill_continuity' });
});

for (const point of ['before_append', 'after_write', 'after_sync']) test(`historical idle compaction ${point} preserves all-old or all-exact-new context on reopen`, async t => {
  let armed = false;
  const f = await fixture(t, { fault: (actual, type) => { if (armed && actual === point && type === 'context_compacted') throw new Error('historical publication fault'); } });
  const selected = await f.setBody('Exact guide in atomic context replacement.'), first = await f.start({ selected, initial: true }); await first.finish();
  const second = await f.start(); await second.finish(); const { plan } = await f.idle(), before = f.store.loadContext(); armed = true;
  await assert.rejects(f.store.commitContextCompaction(plan), /historical publication fault/);
  await f.reopen(); assert.deepEqual(f.store.loadContext(), point === 'before_append' ? before : plan.context);
  if (point !== 'before_append') assert.deepEqual(await f.store.commitContextCompaction(plan), { seq: f.store.head.seq });
});

test('fixed-head conversation projection pages once and processes only actual per-run records', async t => {
  const f = await fixture(t), selected = await f.setBody('Stable earliest historical provenance.');
  const first = await f.start({ selected, initial: true, detail: 'Small response.' }); await first.finish();
  for (let i = 0; i < 70; i++) { const next = await f.start({ detail: 'Small response.' }); await next.finish(); }
  let pages = 0;
  const evidence = readConversationSkillContinuityEvidence({ head: f.store.head, getRun: id => f.store.getRun(id), replay: (after, limit) => { pages++; return f.store.replay(after, limit); } });
  assert.equal(pages, Math.ceil(f.store.head.seq / 256)); assert.equal(evidence.manifest.entries.length, 1);
  assert.equal(evidence.manifest.entries[0].identity.runId, first.identity.runId);
  const broken = { head: f.store.head, getRun: id => f.store.getRun(id), replay: (after, limit) => f.store.replay(after + 1, limit) };
  assert.throws(() => readConversationSkillContinuityEvidence(broken), { code: 'invalid_skill_evidence' });
});

test('retained wire items are encoded once per history projection rather than once per older load receipt', async t => {
  const f = await fixture(t), selected = await f.setBody('Same exact guide loaded in several independent runs.');
  for (let i = 0; i < 5; i++) { const next = await f.start({ selected, dynamic: true, detail: 'Small complete response.' }); await next.finish(); }
  let encodings = 0;
  const retainedContext = { protocol: f.protocol, items: Array.from({ length: 100 }, (_, index) => ({ type: 'message', role: 'assistant',
    content: [Object.defineProperty({ type: 'output_text' }, 'text', { enumerable: true, get: () => { encodings++; return `Retained observation ${index}.`; } })] })) };
  const evidence = readConversationSkillContinuityEvidence(f.store, retainedContext);
  assert.equal(evidence.manifest.entries.length, 1); assert.equal(evidence.manifest.entries[0].placement, 'compacted_context');
  assert.equal(encodings, retainedContext.items.length);
});
