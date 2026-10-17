import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJson, type JsonValue, type ModelContext } from '@cc-desk/agent-core';
import type { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { createNativeModel, type NativeModelOptions } from '@cc-desk/agent-node/native-model';
import { contextSummaryItem } from '@cc-desk/agent-node/context-maintenance';
import { conversationSkillContinuityItems, type ConversationSkillContinuitySection } from '@cc-desk/agent-node/skill-continuity';
import { autoCompactBeforeSend, assertNativeInputBudget, pendingNativeContext } from '../src/main/engines/native/automatic-compaction';
import { parseNativeConfig } from '../src/main/engines/native/config';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const protocol = { id: 'openai-responses', version: 1 };
const identity = { sessionId: 'session', conversationId: 'conversation', runId: 'next-run', requestId: 'request', workerGeneration: 2 };
const model = { baseURL: 'http://127.0.0.1:1/v1', model: 'fixture', allowLoopbackHttp: true };
const config = parseNativeConfig({ schemaVersion: 1, options: { autoCompact: 'before_send', maxInputTokens: 8192 } });
type Options = Parameters<typeof autoCompactBeforeSend>[0];

function historicalGuide(body: string): ConversationSkillContinuitySection {
  const skillId = `skill:${hash('historical guide')}`, key = hash('historical version');
  const manifest = { schemaVersion: 1 as const, conversationId: identity.conversationId, entries: [{
    key, skillId, sourceId: 'project', relativePath: 'guides/SKILL.md',
    version: { skillId, sourceRevision: 1, sourceFingerprint: hash('source'), fullFileHash: hash(body), bodyHash: hash(body), bytes: Buffer.byteLength(body), format: 'standard' as const },
    origin: 'model' as const, evidence: { kind: 'tool_completed' as const, seq: 5, callId: 'historical-load' },
    identity: { ...identity, runId: 'previous-run', requestId: 'previous-request', workerGeneration: 1 },
    catalogRevision: hash('historical catalog'), placement: 'compacted_context' as const,
  }] };
  return { schemaVersion: 1, manifest: { ...manifest, digest: hash(canonicalJson(manifest as unknown as JsonValue)) }, bodies: [{ key, body }] };
}

function fixture(section: ConversationSkillContinuitySection, selectedModel: NativeModelOptions = model) {
  const goal = { role: 'user', content: 'Original task' }, tail = { role: 'user', content: 'Latest retained turn. ' + 'r'.repeat(4000) };
  const context: ModelContext = { protocol, items: [goal, { role: 'assistant', content: 'Old task evidence. '.repeat(230) }, tail] };
  let reservations = 0, starts = 0;
  const ledger = {
    lookupAutoCompaction: () => undefined, loadContext: () => context, getAutoCompactionForCurrentContext: () => null,
    getCompactionSource: () => ({ expectedHash: hash('head'), sourceSeq: 10, scope: 'prefix', context: { protocol, items: context.items.slice(0, 2) },
      retainedContext: { protocol, items: [goal, tail] }, retainedPrefixItems: 1, beforeBytes: Buffer.byteLength(JSON.stringify(context)) }),
    reserveAutoCompaction: async () => { reservations++; assert.fail('Unhelpful retention must be rejected before reserving a paid request.'); },
  } as unknown as NativeRunStore;
  return { config, selectedModel, goal, tail, context, get reservations() { return reservations; }, get starts() { return starts; },
    invoke: (overrides: Partial<Pick<Options, 'skills' | 'assertOwnership' | 'onCompacting' | 'config'>> = {}) => autoCompactBeforeSend({
    ledger, identity, input: 'Continue', config, model: selectedModel, instructions: '', signal: new AbortController().signal,
    startedAt: performance.now(), unlimited: true, assertOwnership: async () => {}, onCompacting: () => assert.fail('Preflight cannot start compaction.'),
    onCommitted: async () => assert.fail('Preflight cannot replace history.'), skills: { prepare: async () => section },
    ...overrides,
    worker: async () => { starts++; assert.fail('Preflight cannot issue a summary request.'); },
  }) };
}

test('pre-send compaction budgets exact historical guide bytes before any paid summary reservation', async () => {
  const f = fixture(historicalGuide('Historical exact guide bytes. '.repeat(1100)));
  assert.doesNotThrow(() => assertNativeInputBudget({ protocol, items: [f.goal, { role: 'assistant', content: '摘要' }, f.tail] }, 'Continue', '', config, model),
    'the task and minimum summary would fit if historical guides were silently dropped');
  await assert.rejects(f.invoke(), /必须保留的上下文/);
  assert.equal(f.reservations, 0); assert.equal(f.starts, 0);
});

test('historical CAS guide credentials are rejected before reserving or requesting a pre-send summary', async () => {
  const secret = 'sk-historical-guide-credential-sentinel';
  const f = fixture(historicalGuide(`Preserve this exact historical body: ${secret}`), { ...model, apiKey: secret });
  await assert.rejects(f.invoke(), error => { assert.equal((error as { code?: string }).code, 'credential_echo'); assert.doesNotMatch(String(error), new RegExp(secret)); return true; });
  assert.equal(f.reservations, 0); assert.equal(f.starts, 0);
});

test('exact historical retention that cannot shrink the context is rejected before a paid summary even when it fits budget', async () => {
  const f = fixture(historicalGuide('placeholder'));
  const replacement = (section: ConversationSkillContinuitySection): ModelContext => ({ protocol, items: [
    f.goal, contextSummaryItem('_', protocol), ...conversationSkillContinuityItems(section, protocol), f.tail,
  ] });
  const beforeBytes = Buffer.byteLength(JSON.stringify(f.context));
  const baselineBytes = Buffer.byteLength(JSON.stringify(replacement(historicalGuide('x'))));
  const section = historicalGuide('x'.repeat(Math.max(1, beforeBytes - baselineBytes + 32)));
  const minimum = replacement(section), minimumBytes = Buffer.byteLength(JSON.stringify(minimum));
  assert.ok(minimumBytes >= beforeBytes, 'even the shortest legal summary cannot reduce exact historical retention');
  const estimator = createNativeModel({ ...model, instructions: '' });
  const sourceTokens = estimator.estimateInputUsage!(pendingNativeContext(f.context, 'Continue', model), config.maxOutputTokens).estimatedInputTokens;
  const minimumTokens = estimator.estimateInputUsage!(pendingNativeContext(minimum, 'Continue', model), config.maxOutputTokens).estimatedInputTokens;
  const maximum = Math.ceil(Math.max(sourceTokens, minimumTokens) / 0.98);
  assert.ok(sourceTokens >= maximum * 0.9, 'the old context still reaches the automatic-summary threshold');
  const selectedConfig = { ...config, maxInputTokens: maximum };
  assert.doesNotThrow(() => assertNativeInputBudget(minimum, 'Continue', '', selectedConfig, model));
  await assert.rejects(f.invoke({ config: selectedConfig, skills: { prepare: async () => section } }), /无法缩小，未调用自动摘要/);
  assert.equal(f.reservations, 0); assert.equal(f.starts, 0);
});

test('ownership revoked during historical CAS revalidation blocks automatic-summary reservation', async () => {
  const section = historicalGuide('Short historical guide'), f = fixture(section);
  let owner = true, reads = 0;
  await assert.rejects(f.invoke({ onCompacting: () => {},
    assertOwnership: async () => { if (!owner) throw new Error('Ownership revoked'); },
    skills: { prepare: async () => { if (++reads === 2) owner = false; return section; } },
  }), /Ownership revoked/);
  assert.equal(reads, 2); assert.equal(f.reservations, 0); assert.equal(f.starts, 0);
});
