import test from 'node:test';
import assert from 'node:assert/strict';
import { isNativeSkillSubmission, normalizeNativeSkillSubmission, isSkillVersionSnapshot } from '../dist/native-skills.js';
const reference = (digit = 'a') => ({ skillId: `skill:${digit.repeat(64)}`, catalogRevision: 'c'.repeat(64),
  version: { skillId: `skill:${digit.repeat(64)}`, sourceRevision: 1, sourceFingerprint: 'd'.repeat(64),
    fullFileHash: 'e'.repeat(64), bodyHash: 'f'.repeat(64), bytes: 20, format: 'standard' } });
const input = () => ({ schemaVersion: 1, explicitSkillRefs: [reference()], excludedSkillIds: [] });
test('skill references preserve exact versions and normalize order without aliasing caller data', () => {
  const original = input(); original.explicitSkillRefs.unshift(reference('b'));
  original.excludedSkillIds = [`skill:${'2'.repeat(64)}`, `skill:${'1'.repeat(64)}`];
  const normalized = normalizeNativeSkillSubmission(original);
  assert.deepEqual(normalized.explicitSkillRefs.map(ref => ref.skillId), [reference().skillId, reference('b').skillId]);
  assert.deepEqual(normalized.excludedSkillIds, [...original.excludedSkillIds].sort());
  normalized.explicitSkillRefs[0].version.fullFileHash = '0'.repeat(64);
  assert.equal(original.explicitSkillRefs[1].version.fullFileHash, 'e'.repeat(64));
});
test('invalid, duplicate, contradictory or oversized skill references are never silently repaired', () => {
  const cases = [null, {}, { ...input(), ignored: true }, { ...input(), schemaVersion: 2 },
    { ...input(), explicitSkillRefs: Array(17).fill(reference()) }, { ...input(), explicitSkillRefs: [reference(), reference()] },
    { ...input(), excludedSkillIds: [reference().skillId] }, { ...input(), excludedSkillIds: ['unknown'] },
    { ...input(), excludedSkillIds: [`skill:${'1'.repeat(64)}`, `skill:${'1'.repeat(64)}`] }];
  for (const field of ['skillId', 'catalogRevision']) cases.push({ ...input(), explicitSkillRefs: [{ ...reference(), [field]: '../outside' }] });
  for (const patch of [{ bytes: 32769 }, { bytes: -1 }, { format: 'invalid' }, { sourceRevision: 0 },
    { fullFileHash: '../outside' }, { skillId: reference('b').skillId }, { extra: true }]) {
    cases.push({ ...input(), explicitSkillRefs: [{ ...reference(), version: { ...reference().version, ...patch } }] });
  }
  for (const value of cases) { assert.equal(isNativeSkillSubmission(value), false); assert.throws(() => normalizeNativeSkillSubmission(value)); }
});
test('validation does not execute accessors, toJSON or hostile proxies', () => {
  let invoked = 0;
  const accessor = Object.defineProperty(input(), 'schemaVersion', { get() { invoked++; throw new Error('private'); } });
  const array = input(); Object.defineProperty(array.explicitSkillRefs, 0, { get() { invoked++; throw new Error('private'); } });
  const proxy = new Proxy({}, { ownKeys() { throw new Error('private'); } });
  for (const value of [accessor, array, proxy]) assert.equal(isNativeSkillSubmission(value), false);
  assert.equal(isSkillVersionSnapshot(proxy), false); assert.equal(invoked, 0);
});

test('descriptor snapshots never execute get traps on root, arrays, references or versions', () => {
  let invoked = 0;
  const wrap = value => new Proxy(value, { get() { invoked++; throw new Error('Unexpected property read.'); } });
  const original = input();
  const expected = structuredClone(original);
  const ref = original.explicitSkillRefs[0];
  ref.version = wrap(ref.version);
  original.explicitSkillRefs = wrap([wrap(ref)]);
  original.excludedSkillIds = wrap(original.excludedSkillIds);
  const proxy = wrap(original);
  assert.equal(isSkillVersionSnapshot(ref.version), true);
  assert.equal(isNativeSkillSubmission(proxy), true);
  assert.deepEqual(normalizeNativeSkillSubmission(proxy), expected);
  assert.equal(invoked, 0);
});

test('normalization reads every original property descriptor once and returns that validated snapshot', () => {
  let propertyGets = 0;
  const counts = new Map();
  const wrap = (value, name) => new Proxy(value, {
    get() { propertyGets++; throw new Error('Normalization reread original property.'); },
    getOwnPropertyDescriptor(target, key) {
      const id = `${name}.${String(key)}`;
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      if (count > 1) throw new Error('Normalization inspected a descriptor twice.');
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  const original = input();
  const expected = structuredClone(original);
  const ref = original.explicitSkillRefs[0];
  ref.version = wrap(ref.version, 'version');
  original.explicitSkillRefs = wrap([wrap(ref, 'ref')], 'refs');
  original.excludedSkillIds = wrap([], 'excluded');
  const result = normalizeNativeSkillSubmission(wrap(original, 'root'));
  assert.deepEqual(result, expected);
  assert.equal(propertyGets, 0);
  assert.equal(counts.size, 16);
  assert.ok([...counts.values()].every(count => count === 1));
});

test('nested getters and non-JSON array properties are rejected without being executed or repaired', () => {
  let invoked = 0;
  const cases = [];
  for (const field of ['skillId', 'catalogRevision', 'version']) {
    const value = input();
    Object.defineProperty(value.explicitSkillRefs[0], field, { get() { invoked++; return reference()[field]; } });
    cases.push(value);
  }
  for (const field of Object.keys(reference().version)) {
    const value = input();
    Object.defineProperty(value.explicitSkillRefs[0].version, field, { get() { invoked++; return reference().version[field]; } });
    cases.push(value);
    assert.equal(isSkillVersionSnapshot(value.explicitSkillRefs[0].version), false);
  }
  const excludedAccessor = input();
  excludedAccessor.excludedSkillIds = [reference('b').skillId];
  Object.defineProperty(excludedAccessor.excludedSkillIds, 0, { get() { invoked++; return reference('b').skillId; } });
  cases.push(excludedAccessor);
  const customIterator = input();
  Object.defineProperty(customIterator.explicitSkillRefs, Symbol.iterator, { get() { invoked++; throw new Error('Unexpected iterator.'); } });
  cases.push(customIterator);
  const extraSymbol = input();
  extraSymbol.explicitSkillRefs[0].version[Symbol('extra')] = true;
  cases.push(extraSymbol);
  const sparse = input();
  sparse.explicitSkillRefs = Array(1);
  cases.push(sparse);
  for (const value of cases) {
    assert.equal(isNativeSkillSubmission(value), false);
    assert.throws(() => normalizeNativeSkillSubmission(value), /Invalid Native skill submission/);
  }
  assert.equal(invoked, 0);
});
