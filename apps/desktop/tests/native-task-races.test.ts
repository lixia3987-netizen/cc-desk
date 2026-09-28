import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NativeTaskStore } from '@cc-desk/agent-node/task-store';
import type { NativeTaskSnapshot } from '@cc-desk/contracts/native-task';
import { NativeTaskSession } from '../src/main/engines/native/task-session';

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-task-races-'));
  const project = path.join(directory, 'project'); await fs.mkdir(project);
  const target = path.join(project, 'source.ts'); await fs.writeFile(target, 'export const value = 1;\n');
  const identity = { sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 };
  let duringSync: (() => Promise<void>) | undefined;
  const store = await NativeTaskStore.open({ rootDirectory: path.join(directory, 'private'), sessionId: identity.sessionId, conversationId: identity.conversationId,
    fault: async point => { if (point === 'after_sync' && duringSync) { const effect = duringSync; duringSync = undefined; await effect(); } } });
  const changes: NativeTaskSnapshot[] = [];
  const session = new NativeTaskSession(store, { projectRoot: project, excludedRoots: [], assertSafe: () => {}, changed: snapshot => { changes.push(snapshot); } });
  const task = await store.apply({ identity, taskId: randomUUID(), mutationId: randomUUID(), expectedRevision: 0, mutation: { type: 'plan', plan: {
    goal: 'Update the source constant', steps: [{ id: 'implement', title: 'Implement change', status: 'implemented', dependsOn: [] }],
    criteria: [{ id: 'value', description: 'The source value matches the requested value', kind: 'manual', stepIds: ['implement'] }],
  } } });
  await session.planCommitted(task);
  const current = store.latest()!;
  await store.apply({ identity, taskId: task.taskId, mutationId: randomUUID(), expectedRevision: current.revision, mutation: { type: 'finish', outcome: 'completed' } });
  const input = (decision: 'passed' | 'approve') => {
    const latest = store.latest()!;
    return { taskId: latest.taskId, expectedRevision: latest.revision, expectedWorkspaceFingerprint: latest.workspace!.current.fingerprint,
      decision, ...(decision === 'passed' ? { criterionId: 'value' } : {}), reason: 'Reviewed the exact requested source version' };
  };
  return { session, store, target, input, changes,
    inject: (effect: () => Promise<void>) => { duringSync = effect; },
    dispose: async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

test('external edit after review scan but before criterion commit rejects the old fingerprint', async () => {
  const f = await fixture();
  try {
    f.inject(() => fs.writeFile(f.target, 'export const value = 2;\n'));
    await assert.rejects(f.session.review(f.input('passed'), () => {}), /工作区|workspace|改变|版本/);
    assert.equal(f.store.latest()!.evidence.filter(item => item.source === 'manual' && item.status === 'passed').length, 0);
    assert.notEqual(f.store.latest()!.verification, 'passed');
  } finally { await f.dispose(); }
});

test('external edit after coverage-review scan cannot promote old manual evidence to overall passed', async () => {
  const f = await fixture();
  try {
    await f.session.review(f.input('passed'), () => {});
    f.inject(() => fs.writeFile(f.target, 'export const value = 3;\n'));
    await assert.rejects(f.session.review(f.input('approve'), () => {}), /工作区|workspace|改变|版本/);
    assert.notEqual(f.store.latest()!.verification, 'passed');
    assert.notEqual(f.store.latest()!.review?.status, 'approved');
  } finally { await f.dispose(); }
});

test('cancelled final review guard cannot persist a human acceptance receipt', async () => {
  const f = await fixture(); let cancelled = false;
  try {
    f.inject(async () => { cancelled = true; });
    await assert.rejects(f.session.review(f.input('passed'), () => { if (cancelled) throw new Error('Review cancelled'); }), /cancelled/);
    assert.equal(f.store.latest()!.evidence.length, 0);
  } finally { await f.dispose(); }
});
