import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalJson } from '@cc-desk/agent-core';
import { NativeRunStore } from '../dist/run-store.js';
import { SkillRegistry } from '../dist/skill-registry.js';
import { SkillSnapshotStore } from '../dist/skill-snapshots.js';
import { SkillToolPort } from '../dist/skill-tools.js';
import { readSkillContinuityEvidence, resolveSkillContinuity, readConversationSkillContinuityEvidence,
  resolveConversationSkillContinuity, validateSkillInheritanceContext, validateSkillInheritedBinding } from '../dist/skill-continuity.js';

const protocols = ['openai-responses', 'openai-chat-completions', 'anthropic-messages'];
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const compactCatalog = catalog => ({ revision: catalog.revision, entries: catalog.entries.map(({ skillId, sourceId, relativePath, sourceRevision, sourceFingerprint, metadataHash, format }) =>
  ({ skillId, sourceId, relativePath, sourceRevision, sourceFingerprint, metadataHash, format })), truncated: catalog.truncated });
const guide = (descriptor, loaded) => `Native skill guide ${descriptor.skillId} (${descriptor.sourceId}/${descriptor.relativePath}), version ${loaded.version.fullFileHash}:\n${loaded.body}`;
const identity = (conversationId = randomUUID()) => ({ sessionId: randomUUID(), conversationId, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 });
function response(protocol, text = 'Detailed observations. '.repeat(4000)) {
  const outputItems = protocol.id === 'openai-chat-completions' ? [{ role: 'assistant', content: text }]
    : protocol.id === 'anthropic-messages' ? [{ role: 'assistant', content: [{ type: 'text', text }] }]
      : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }];
  return { type: 'model_response', response: { outputItems, toolCalls: [], finishReason: 'completed', usage: null } };
}
async function fixture(t, protocolId = protocols[0]) {
  const directory = await mkdtemp(path.join(tmpdir(), 'native-inherited-skill-')), snapshots = new SkillSnapshotStore({ directory: path.join(directory, 'snapshots') });
  const protocol = { id: protocolId, version: 1 }, rootDirectory = path.join(directory, 'runs');
  const makeSource = async name => {
    const root = path.join(directory, name), file = path.join(root, '.agents', 'skills', 'guide', 'SKILL.md'); await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '---\nname: guide\ndescription: Relevant coding guidance.\n---\nExact inherited guide 中文\r\nPreserve user-owned files.');
    const registry = new SkillRegistry({ projectId: 'shared-logical-project', projectRoot: root, sources: [{ id: 'agents', scope: 'project', kind: 'project-agents', rootPath: '.agents/skills', enabled: true, revision: 1 }] });
    const catalog = await registry.discover(), loaded = await registry.loadCatalogSkill(catalog.entries[0]); await snapshots.put(loaded);
    return { root, file, registry, catalog, descriptor: catalog.entries[0], loaded };
  };
  const parent = await makeSource('parent'), child = await makeSource('child'), parentIdentity = identity(), childIdentity = identity();
  const parentStore = await NativeRunStore.open({ rootDirectory, conversationId: parentIdentity.conversationId });
  let childStore = await NativeRunStore.open({ rootDirectory, conversationId: childIdentity.conversationId });
  const parentPort = new SkillToolPort({ identity: parentIdentity, catalog: parent.catalog, load: descriptor => parent.registry.loadCatalogSkill(descriptor),
    initialSkills: [{ descriptor: parent.descriptor, loaded: parent.loaded, origin: 'explicit' }] });
  const parentRequest = { identity: parentIdentity, input: 'Parent task.', inputDigest: 'parent', userItems: [{ role: 'user', content: 'Parent task.' }], protocol, policyRevision: 'policy',
    configuration: { nativeSkillCatalog: compactCatalog(parent.catalog), initialNativeSkills: parentPort.snapshot(), modelInstructions: guide(parent.descriptor, parent.loaded),
      nativeSkills: { schemaVersion: 1, explicitSkillRefs: [{ skillId: parent.descriptor.skillId, catalogRevision: parent.catalog.revision, version: parent.loaded.version }], excludedSkillIds: [] } } };
  await parentStore.beginRun(parentRequest);
  const parentStarted = { type: 'model_request_started', attempt: 1 }; let receipt = await parentStore.append(parentIdentity, parentStarted); parentPort.observeCommitted(parentStarted, receipt.seq);
  const parentResponse = response(protocol, 'Parent prepared the task.'); receipt = await parentStore.append(parentIdentity, parentResponse); parentPort.observeCommitted(parentResponse, receipt.seq);
  const evidence = readSkillContinuityEvidence(parentStore, parentIdentity.runId);
  const inheritance = validateSkillInheritanceContext({ schemaVersion: 1, parentHead: evidence.head, parentManifest: evidence.manifest }, childIdentity);
  const inheritedFrom = { parentIdentity, parentHead: evidence.head, manifestDigest: evidence.manifest.digest, catalogRevision: evidence.manifest.catalogRevision,
    skillId: parent.descriptor.skillId, sourceId: parent.descriptor.sourceId, relativePath: parent.descriptor.relativePath, version: parent.loaded.version };
  const childOptions = { identity: childIdentity, catalog: child.catalog, load: descriptor => child.registry.loadCatalogSkill(descriptor), inheritance,
    initialSkills: [{ descriptor: child.descriptor, loaded: child.loaded, origin: 'inherited', inheritedFrom }] };
  const childPort = new SkillToolPort(childOptions);
  const childRequest = { identity: childIdentity, input: 'Independent child task.', inputDigest: 'child', userItems: [{ role: 'user', content: 'Independent child task.' }], protocol, policyRevision: 'policy',
    configuration: { delegated: { parentIdentity, depth: 1 }, nativeSkillCatalog: compactCatalog(child.catalog), initialNativeSkills: childPort.snapshot(),
      modelInstructions: guide(child.descriptor, child.loaded), nativeSkillInheritance: inheritance } };
  let attempts = 0;
  const batch = async () => {
    const started = { type: 'model_request_started', attempt: ++attempts }; const offered = await childStore.append(childIdentity, started); childPort.observeCommitted(started, offered.seq);
    const event = response(protocol); const complete = await childStore.append(childIdentity, event); childPort.observeCommitted(event, complete.seq);
  };
  const finish = async () => {
    const result = { identity: childIdentity, status: 'completed', modelRequests: attempts + (childStore.lookupRunCompaction(childIdentity.runId)?.status === 'committed' ? 1 : 0), toolCalls: 0, usage: null, context: childStore.loadContext(), committed: true };
    const event = { type: 'run_finished', result }; const committed = await childStore.append(childIdentity, event); childPort.observeCommitted(event, committed.seq);
  };
  t.after(async () => { await childStore.close().catch(() => {}); await parentStore.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  return { directory, protocol, snapshots, parent, child, parentIdentity, childIdentity, parentStore, parentPort, childPort, childOptions, childRequest, inheritance, inheritedFrom,
    get childStore() { return childStore; }, batch, finish, reopen: async () => { await childStore.close(); childStore = await NativeRunStore.open({ rootDirectory, conversationId: childIdentity.conversationId }); } };
}

for (const protocol of protocols) test(`${protocol}: inherited activation owns child binding and observation, survives exact compaction and restart`, async t => {
  const f = await fixture(t, protocol);
  assert.equal(f.parent.descriptor.skillId, f.child.descriptor.skillId); assert.notEqual(f.parent.loaded.version.sourceFingerprint, f.child.loaded.version.sourceFingerprint);
  assert.ok(f.parentPort.snapshot().activations[0].confirmedByResponseId);
  const initial = f.childPort.snapshot().activations[0]; assert.equal(initial.origin, 'inherited'); assert.deepEqual(initial.version, f.child.loaded.version);
  assert.deepEqual(initial.inheritedFrom.version, f.parent.loaded.version); assert.equal(initial.receiptSeq, 0);
  assert.equal(initial.offeredToRequestId, undefined); assert.equal(initial.confirmedByResponseId, undefined);
  await assert.rejects(f.childPort.assertSideEffectsCurrent(new AbortController().signal), { code: 'skill_model_observation_required' });
  await f.childStore.beginRun(f.childRequest); await f.batch(); await f.batch();
  assert.match(f.childPort.snapshot().activations[0].confirmedByResponseId, new RegExp(`^${f.childIdentity.runId}:response:`));
  const source = f.childStore.getRunCompactionSource(f.childIdentity), evidence = readSkillContinuityEvidence(f.childStore, f.childIdentity.runId, source.retainedContext);
  assert.deepEqual(evidence.manifest.entries[0].inheritedFrom, f.inheritedFrom); assert.equal(evidence.manifest.entries[0].evidence.kind, 'run_started');
  const nativeSkills = await resolveSkillContinuity(evidence, f.snapshots), request = { requestId: randomUUID(), contextHash: source.contextHash };
  await f.childStore.reserveRunCompaction(f.childIdentity, request);
  const committed = await f.childStore.commitRunCompaction(f.childIdentity, { ...request, summary: 'Prior observations.', continuity: 'Child task and evidence.', usage: null, nativeSkills });
  f.childPort.observeContextReplacement(committed.seq, nativeSkills.manifest);
  assert.equal(f.childPort.snapshot().activations[0].confirmedByResponseId, undefined);
  await f.batch(); await f.childPort.assertSideEffectsCurrent(new AbortController().signal); await f.finish(); await f.reopen();
  assert.deepEqual(readSkillContinuityEvidence(f.childStore, f.childIdentity.runId).manifest.entries[0].inheritedFrom, f.inheritedFrom);
  const historical = readConversationSkillContinuityEvidence(f.childStore), section = await resolveConversationSkillContinuity(historical, f.snapshots);
  assert.equal(section.bodies[0].body, f.child.loaded.body); assert.deepEqual(section.manifest.entries[0].inheritedFrom, f.inheritedFrom);
});

test('parent attestation digest, identity, head/member/source/version and recursion mismatches fail before ToolPort activation', async t => {
  const f = await fixture(t);
  for (const mutate of [value => { value.parentManifest.digest = '0'.repeat(64); }, value => { value.parentManifest.identity = f.childIdentity; },
    value => { value.parentHead.seq = 1; }, value => { value.parentManifest.entries[0].origin = 'inherited'; }, value => { value.parentManifest.entries[0].evidence.seq = value.parentHead.seq + 1; }]) {
    const changed = structuredClone(f.inheritance); mutate(changed);
    assert.throws(() => new SkillToolPort({ ...f.childOptions, inheritance: changed }), { code: 'invalid_skill_evidence' });
  }
  for (const mutate of [value => { value.parentIdentity.requestId = 'other-parent'; }, value => { value.parentHead.hash = '1'.repeat(64); },
    value => { value.manifestDigest = '2'.repeat(64); }, value => { value.catalogRevision = '3'.repeat(64); }, value => { value.sourceId = 'other'; },
    value => { value.relativePath = 'other/SKILL.md'; }, value => { value.version.bodyHash = '4'.repeat(64); }, value => { value.confirmedByResponseId = 'parent-confirmation'; }]) {
    const inheritedFrom = structuredClone(f.inheritedFrom); mutate(inheritedFrom);
    assert.throws(() => new SkillToolPort({ ...f.childOptions, initialSkills: [{ ...f.childOptions.initialSkills[0], inheritedFrom }] }), { code: 'invalid_skill_evidence' });
  }
  assert.throws(() => new SkillToolPort({ ...f.childOptions, inheritance: undefined }), { code: 'invalid_skill_evidence' });
  assert.throws(() => new SkillToolPort({ ...f.childOptions, initialSkills: [] }), { code: 'inherited_skill_set_incomplete' });
  assert.throws(() => new SkillToolPort({ ...f.childOptions, initialSkills: [{ descriptor: f.child.descriptor, loaded: f.child.loaded, origin: 'legacy' }] }), { code: 'inherited_skill_set_incomplete' });
  assert.throws(() => validateSkillInheritedBinding(f.inheritance, f.childIdentity, f.child.descriptor, { ...f.child.loaded.version, bodyHash: '5'.repeat(64) }, f.inheritedFrom), { code: 'invalid_skill_evidence' });
});

test('invalid inherited starts are rejected before append, independently of any later compaction', async t => {
  const f = await fixture(t), before = f.childStore.head;
  const mutations = [value => { delete value.nativeSkillInheritance; }, value => { delete value.initialNativeSkills.activations[0].inheritedFrom; },
    value => { value.initialNativeSkills.activations[0].inheritedFrom.parentHead.hash = '6'.repeat(64); }, value => { value.delegated.parentIdentity.runId = randomUUID(); },
    value => { value.delegated.depth = 2; }, value => { delete value.delegated; }, value => { value.initialNativeSkills.activations[0].receiptSeq = 8; },
    value => { value.initialNativeSkills.activations[0].offeredToRequestId = 'parent-request'; }, value => { value.initialNativeSkills.activations[0].confirmedByResponseId = 'parent-response'; },
    value => { value.initialNativeSkills.activations[0].origin = 'pinned'; }, value => { value.initialNativeSkills.digest = '7'.repeat(64); },
    value => { value.initialNativeSkills.activations = []; value.initialNativeSkills.activationRevision = 0; value.initialNativeSkills.digest = hash([]); },
    value => { value.initialNativeSkills.activations[0].origin = 'legacy'; delete value.initialNativeSkills.activations[0].inheritedFrom; },
    value => { value.initialNativeSkills.activations = Array(17).fill(value.initialNativeSkills.activations[0]); value.initialNativeSkills.activationRevision = 17; }];
  for (const mutate of mutations) {
    const request = structuredClone(f.childRequest); mutate(request.configuration);
    await assert.rejects(f.childStore.beginRun(request), { code: 'invalid_skill_evidence' }); assert.deepEqual(f.childStore.head, before);
  }
  await f.childStore.beginRun(f.childRequest); await f.batch(); await f.finish();
});

test('empty parent activation context requires exactly an empty child inherited start', async t => {
  const f = await fixture(t), context = structuredClone(f.inheritance);
  context.parentManifest.entries = [];
  const { digest, ...manifest } = context.parentManifest; context.parentManifest.digest = hash(manifest);
  const port = new SkillToolPort({ ...f.childOptions, inheritance: context, initialSkills: [] });
  const request = structuredClone(f.childRequest); request.configuration.nativeSkillInheritance = context; request.configuration.initialNativeSkills = port.snapshot();
  await f.childStore.beginRun(request); await f.batch(); await f.finish();
});

test('child source validation uses its actual rebound root and never substitutes the parent workspace', async t => {
  const f = await fixture(t);
  await rm(f.parent.file);
  await f.childPort.assertSourcesCurrent(new AbortController().signal);
  await writeFile(f.child.file, '---\nname: guide\ndescription: Changed child guide.\n---\nDifferent child bytes.');
  await assert.rejects(f.childPort.assertSourcesCurrent(new AbortController().signal), { code: 'skill_source_changed' });
});

test('context replacement cannot drop or change inherited parent provenance even with a recomputed manifest digest', async t => {
  const f = await fixture(t); await f.childStore.beginRun(f.childRequest); await f.batch(); await f.batch();
  const evidence = readSkillContinuityEvidence(f.childStore, f.childIdentity.runId), before = f.childPort.snapshot();
  for (const mutate of [value => { delete value.entries[0].inheritedFrom; }, value => { value.entries[0].inheritedFrom.parentHead.hash = '9'.repeat(64); },
    value => { value.entries[0].inheritedFrom.version.sourceFingerprint = 'a'.repeat(64); }]) {
    const manifest = structuredClone(evidence.manifest); mutate(manifest); const { digest, ...body } = manifest; manifest.digest = hash(body);
    assert.throws(() => f.childPort.observeContextReplacement(f.childStore.head.seq + 1, manifest), { code: 'context_replacement_invalid' });
    assert.deepEqual(f.childPort.snapshot(), before);
  }
  await f.finish();
});

test('rehashed journal cannot substitute a different parent provenance while leaving child source/version intact', async t => {
  const f = await fixture(t); await f.childStore.beginRun(f.childRequest); await f.batch(); await f.finish();
  const file = path.join(f.childStore.directory, 'journal.jsonl'); const records = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse); await f.childStore.close();
  const start = records.find(record => record.event.type === 'run_started'); start.event.request.configuration.initialNativeSkills.activations[0].inheritedFrom.parentHead.hash = '8'.repeat(64);
  const request = start.event.request;
  start.event.payloadDigest = hash({ input: request.input, userItems: request.userItems, protocol: request.protocol, configuration: request.configuration, policyRevision: request.policyRevision });
  let previousHash = '0'.repeat(64);
  for (const record of records) { record.previousHash = previousHash; const { hash: old, ...body } = record; record.hash = hash(body); previousHash = record.hash; }
  await writeFile(file, records.map(record => canonicalJson(record)).join('\n') + '\n');
  await assert.rejects(f.reopen(), { code: 'corrupt_store' });
});
