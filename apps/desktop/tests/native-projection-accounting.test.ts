import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ModelContext, RunIdentity } from '@cc-desk/agent-core';
import type { NativeRunStore, RunStoreRecord } from '@cc-desk/agent-node/run-store';
import { NativeProjection } from '../src/main/engines/native/projection';
import { ExecutionEvents } from '../src/main/execution/events';
import type { Session } from '../src/shared/types';

// 此测试只验证账本到界面的投影，真实账本安全和持久化由 NativeRunStore 测试负责。
test('accounting projection counts ordinary and in-turn summary once across repeated replay', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-accounting-'));
  const identity: RunIdentity = { sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 };
  const context: ModelContext = { protocol: { id: 'openai-responses', version: 1 }, items: [{ role: 'user', content: 'public input' }] };
  const session = { id: identity.sessionId, projectId: 'project', title: 'Native', kind: 'agent', cwd: directory,
    execution: { providerId: 'native', mode: 'structured', conversationId: identity.conversationId }, engineConfig: { schemaVersion: 1, options: {} },
    status: 'idle', archived: false, createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z' } as Session;
  const usage = (inputTokens: number, outputTokens: number, cacheReadInputTokens = 0) => ({ inputTokens, outputTokens, nonCachedInputTokens: inputTokens - cacheReadInputTokens, cacheReadInputTokens, cacheCreationInputTokens: 0 });
  const providerUsage = { raw: { input_tokens: 40, output_tokens: 3, cached_tokens: 30, cache_write_tokens: 0 }, normalization: 'openai-inclusive-input' };
  const events = [
    { type: 'run_started', request: { identity, input: 'public input', userItems: context.items, protocol: context.protocol,
      configuration: { model: 'fixture', pricing: { model: 'fixture', inputUSDPerMillion: 2, outputUSDPerMillion: 8, cacheReadUSDPerMillion: 0.2 } } } },
    { type: 'model_response', response: { outputItems: [], toolCalls: [], finishReason: 'completed', usage: usage(100, 2, 80) } },
    { type: 'run_context_compaction_attempted', request: {} },
    { type: 'run_context_compacted', plan: { usage: usage(200, 2) } },
    { type: 'model_request_started', attempt: 2 },
    { type: 'model_request_diagnostic', diagnostic: { schemaVersion: 1, requestKey: `${identity.runId}:2`, identity, attempt: 2, purpose: 'normal', phase: 'request', requestSent: true, protocol: context.protocol, model: 'fixture', startedAt: 1000,
      contextBytes: 100, estimatedInputTokens: 150, estimateMethod: 'utf8_bytes', estimateSource: 'fallback', payloadBytes: 250,
      contextDigest: 'a'.repeat(64), toolsetDigest: 'b'.repeat(64), usage: null,
      components: { tools: { bytes: 50, digest: 'c'.repeat(64), accounting: 'serialized' } } } },
    { type: 'model_response', response: { outputItems: [], toolCalls: [], finishReason: 'completed', usage: usage(40, 3, 30), providerUsage } },
    { type: 'run_finished', result: { identity, status: 'completed', reason: 'model_completed', modelRequests: 3, toolCalls: 0,
      usage: usage(340, 7, 110), context, committed: true } },
  ];
  const records = events.map((event, index) => ({ event, identity, seq: index + 1, hash: String(index + 1), committedAt: '2026-10-15T00:00:00.000Z' })) as unknown as RunStoreRecord[];
  const store = { conversationId: identity.conversationId, usage: { records: records.length },
    head: { seq: records.at(-1)!.seq, hash: records.at(-1)!.hash },
    replay: (after: number, limit: number) => records.slice(after, after + limit), loadContext: () => context, listRuns: () => [] } as unknown as NativeRunStore;
  const errors: Error[] = [];
  const create = () => new NativeProjection(directory, new ExecutionEvents(), () => session, () => false, (_id, error) => errors.push(error));
  const projection = create();
  try {
    await projection.hydrate(identity.sessionId, store);
    const snapshot = projection.snapshot(identity.sessionId);
    assert.equal(snapshot.context?.inputTokens, 40);
    assert.equal(snapshot.context?.peakInputTokens, 200, 'summary is a real request and contributes to the peak');
    assert.equal(snapshot.context?.peakInputComplete, true);
    assert.equal(snapshot.usage?.inputTokens, 340, 'diagnostic phases and summary receipts must not re-add the aggregate');
    assert.equal(snapshot.usage?.costUSD, 0.000538);
    assert.deepEqual(snapshot.usage?.nativeRequests, { scope: 'parent_run_with_in_turn_summaries', recorded: 3, expected: 3, complete: true });
    assert.deepEqual(snapshot.context?.requestUsage?.provider, providerUsage);
    assert.deepEqual(snapshot.context?.requestDiagnostic?.components.tools, { bytes: 50, accounting: 'serialized' });
    assert.doesNotMatch(JSON.stringify(snapshot.context), /digest|cccccccccccccccc/);
    const original = await fs.readFile(projection.exportPath(identity.sessionId), 'utf8');
    await projection.hydrate(identity.sessionId, store);
    const restored = create(); await restored.hydrate(identity.sessionId, store);
    assert.deepEqual(restored.snapshot(identity.sessionId).usage, snapshot.usage);
    assert.deepEqual(restored.snapshot(identity.sessionId).context, snapshot.context);
    assert.equal(await fs.readFile(restored.exportPath(identity.sessionId), 'utf8'), original);
    assert.deepEqual(errors, []);
    restored.flush();
  } finally { projection.flush(); await fs.rm(directory, { recursive: true, force: true }); }
});
