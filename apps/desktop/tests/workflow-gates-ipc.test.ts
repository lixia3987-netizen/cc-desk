import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerWorkflowHandlers } from '../src/main/ipc/workflow-handlers';
import { WorkflowEngine } from '../src/main/workflows';
import type { Session } from '../src/shared/types';

test('workflow gate IPC validates attempts and explicit reasons before host confirmation, and cannot repeat execution', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdesk-workflow-gate-ipc-'));
  const sessionId = randomUUID(), projectId = randomUUID();
  let calls = 0;
  const engine = new WorkflowEngine(directory, { getSession: () => ({ sessionId, projectId, providerId: 'native', executionMode: 'structured', cwd: '/tmp/project' }),
    runStage: async () => { calls++; return { success: true, summary: 'Actual output' }; }, cancelSession: () => {} });
  const handlers = new Map<string, (input: unknown) => unknown>();
  registerWorkflowHandlers((name, schema, action) => handlers.set(name, input => action(schema.parse(input))), {
    workflows: engine, structured: () => ({ id: sessionId } as Session), assertUnlocked: () => {}, hasPendingTask: () => false,
    defaultWorkflowError: () => undefined, pauseQueue: () => {}, getWindow: () => null,
  });
  const invoke = (name: string, input: unknown) => Promise.resolve().then(() => handlers.get(name)!(input));
  try {
    const run = engine.create({ sessionId, goal: 'Ship', stages: [{ id: 'build', title: 'Build', instruction: 'Implement', gate: 'manual' }] });
    engine.start(run.id); await engine.wait(run.id);
    const valid = { id: run.id, stageId: 'build', expectedAttempt: 1, decision: 'approve', reason: 'I reviewed the actual output' };
    for (const invalid of [{ ...valid, expectedAttempt: undefined }, { ...valid, expectedAttempt: 0 }, { ...valid, expectedAttempt: 4 },
      { ...valid, reason: '' }, { ...valid, decision: 'passed' }, { ...valid, success: true }, { ...valid, id: '../other' }]) await assert.rejects(invoke('workflow:confirm', invalid));
    assert.equal(engine.list()[0].status, 'waiting_confirmation');
    await assert.rejects(invoke('workflow:verify', { id: run.id, stageId: 'build', expectedAttempt: 1 }), /状态已变化/);
    await invoke('workflow:confirm', valid);
    assert.equal(engine.list()[0].status, 'completed');
    await assert.rejects(invoke('workflow:confirm', valid), /状态已变化/);
    assert.equal(calls, 1);
  } finally { await engine.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); }
});
