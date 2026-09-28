import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerNativeTaskHandlers } from '../src/main/ipc/native-task-handlers';

test('task review IPC rejects forged, unversioned and ambiguous approval before reaching the host', async () => {
  const handlers = new Map<string, (input: unknown) => unknown>();
  const reached: unknown[] = [];
  registerNativeTaskHandlers((name, schema, action) => { handlers.set(name, input => action(schema.parse(input))); }, async (id, input) => {
    reached.push({ id, input }); return {} as never;
  });
  const invoke = (input: unknown) => Promise.resolve().then(() => handlers.get('native:task-review')!(input));
  const base = { id: randomUUID(), taskId: randomUUID(), expectedRevision: 2, expectedWorkspaceFingerprint: 'a'.repeat(64), decision: 'passed', criterionId: 'check-one', reason: '已检查测试与差异' };
  for (const invalid of [
    { ...base, expectedRevision: 0 }, { ...base, expectedRevision: undefined }, { ...base, expectedWorkspaceFingerprint: undefined },
    { ...base, criterionId: undefined }, { ...base, decision: 'approve' }, { ...base, decision: 'verified' },
    { ...base, reason: '' }, { ...base, reason: 'x'.repeat(2001) }, { ...base, source: 'host' }, { ...base, taskId: '../other' },
  ]) await assert.rejects(invoke(invalid));
  assert.equal(reached.length, 0);
  await invoke(base);
  await invoke({ ...base, decision: 'approve', criterionId: undefined });
  assert.equal(reached.length, 2);
  assert.equal((reached[0] as { id: string }).id, base.id);
});
