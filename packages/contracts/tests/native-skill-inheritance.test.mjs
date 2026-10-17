import test from 'node:test';
import assert from 'node:assert/strict';
import { isSkillInheritanceContext, normalizeSkillInheritanceContext, isSkillInheritedFrom, normalizeSkillInheritedFrom } from '../dist/native-skills.js';

const id = digit => `skill:${digit.repeat(64)}`;
const identity = () => ({ sessionId: 'parent-session', conversationId: 'parent-conversation', runId: 'parent-run', requestId: 'parent-request', workerGeneration: 1 });
const version = () => ({ skillId: id('a'), sourceRevision: 1, sourceFingerprint: 'b'.repeat(64), fullFileHash: 'c'.repeat(64), bodyHash: 'd'.repeat(64), bytes: 20, format: 'standard' });
const entry = () => ({ skillId: id('a'), sourceId: 'agents', relativePath: 'guide/SKILL.md', version: version(), origin: 'model',
  evidence: { kind: 'tool_completed', seq: 7, callId: 'load-1' }, placement: 'compacted_context' });
const context = () => ({ schemaVersion: 1, parentHead: { seq: 8, hash: 'e'.repeat(64) }, parentManifest: { schemaVersion: 1, identity: identity(),
  catalogRevision: 'f'.repeat(64), entries: [entry()], digest: '0'.repeat(64) } });
const provenance = () => ({ parentIdentity: identity(), parentHead: { seq: 8, hash: 'e'.repeat(64) }, manifestDigest: '0'.repeat(64),
  catalogRevision: 'f'.repeat(64), skillId: id('a'), sourceId: 'agents', relativePath: 'guide/SKILL.md', version: version() });

test('inheritance contracts preserve exact parent identity/head/source/version and isolate normalized values', () => {
  const original = context(), inherited = provenance();
  assert.equal(isSkillInheritanceContext(original), true); assert.equal(isSkillInheritedFrom(inherited), true);
  const normalized = normalizeSkillInheritanceContext(original), ref = normalizeSkillInheritedFrom(inherited);
  assert.deepEqual(normalized, original); assert.deepEqual(ref, inherited);
  normalized.parentManifest.entries[0].version.sourceFingerprint = '1'.repeat(64); ref.parentIdentity.runId = 'changed';
  assert.equal(original.parentManifest.entries[0].version.sourceFingerprint, 'b'.repeat(64)); assert.equal(inherited.parentIdentity.runId, 'parent-run');
});

test('inheritance schemas reject unknown fields, unsafe paths, duplicate parents, excessive entries and impossible provenance', () => {
  const cases = [null, {}, { ...context(), extra: true }, { ...context(), schemaVersion: 2 }];
  for (const change of [value => { value.parentHead.seq = 0; }, value => { value.parentHead.hash = 'unknown'; }, value => { value.parentHead.extra = true; },
    value => { value.parentManifest.identity.workerGeneration = 0; }, value => { value.parentManifest.identity.sessionId = 'secret\npath'; },
    value => { value.parentManifest.entries[0].evidence.seq = 9; }, value => { value.parentManifest.entries[0].evidence.callId = ''; },
    value => { value.parentManifest.entries[0].evidence.extra = true; }, value => { value.parentManifest.entries[0].origin = 'inherited'; },
    value => { value.parentManifest.entries[0].relativePath = '../outside'; }, value => { value.parentManifest.entries[0].relativePath = 'C:/outside'; },
    value => { value.parentManifest.entries[0].relativePath = 'guide\\SKILL.md'; }, value => { value.parentManifest.entries[0].version.skillId = id('b'); },
    value => { value.parentManifest.entries[0].placement = 'initial_instructions'; }, value => { value.parentManifest.entries.push(entry()); },
    value => { value.parentManifest.entries = Array(17).fill(entry()); }, value => { value.parentManifest.entries[0].inheritedFrom = provenance(); }]) {
    const value = context(); change(value); cases.push(value);
  }
  for (const value of cases) { assert.equal(isSkillInheritanceContext(value), false); assert.throws(() => normalizeSkillInheritanceContext(value)); }
  for (const change of [value => { value.parentIdentity.extra = true; }, value => { value.relativePath = '/outside'; }, value => { value.version.bytes = 32769; },
    value => { value.version.skillId = id('b'); }, value => { value.catalogRevision = 'catalog'; }, value => { value.confirmedByResponseId = 'parent-response'; }]) {
    const value = provenance(); change(value); assert.equal(isSkillInheritedFrom(value), false); assert.throws(() => normalizeSkillInheritedFrom(value));
  }
});

test('initial parent evidence has run_started provenance and never a fabricated tool receipt', () => {
  for (const origin of ['explicit', 'pinned', 'legacy']) {
    const value = context(); Object.assign(value.parentManifest.entries[0], { origin, evidence: { kind: 'run_started', seq: 2 }, placement: 'initial_instructions' });
    assert.equal(isSkillInheritanceContext(value), true);
    value.parentManifest.entries[0].evidence.callId = 'fake-load'; assert.equal(isSkillInheritanceContext(value), false);
  }
});

test('inheritance normalization snapshots descriptors once without getters or proxy get traps', () => {
  let gets = 0;
  const wrap = value => new Proxy(value, { get() { gets++; throw new Error('Do not read caller properties.'); } });
  const original = context(), expected = structuredClone(original);
  original.parentManifest.entries[0].version = wrap(original.parentManifest.entries[0].version);
  original.parentManifest.entries[0].evidence = wrap(original.parentManifest.entries[0].evidence);
  original.parentManifest.entries = wrap([wrap(original.parentManifest.entries[0])]);
  original.parentManifest.identity = wrap(original.parentManifest.identity); original.parentManifest = wrap(original.parentManifest); original.parentHead = wrap(original.parentHead);
  assert.deepEqual(normalizeSkillInheritanceContext(wrap(original)), expected); assert.equal(gets, 0);
  for (const field of ['schemaVersion', 'parentHead', 'parentManifest']) {
    const value = Object.defineProperty(context(), field, { get() { gets++; throw new Error('private'); } });
    assert.equal(isSkillInheritanceContext(value), false);
  }
  const inherited = provenance(); Object.defineProperty(inherited.version, 'bodyHash', { get() { gets++; throw new Error('private'); } });
  assert.equal(isSkillInheritedFrom(inherited), false); assert.equal(gets, 0);
});
