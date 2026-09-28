import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelContext, ToolDefinition } from '@cc-desk/agent-core';
import type { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { estimateResponsesInputTokens } from '@cc-desk/agent-node/responses-model';
import { assertNativeInputBudget, autoCompactBeforeSend, pendingNativeContext } from '../src/main/engines/native/automatic-compaction';
import { parseNativeConfig } from '../src/main/engines/native/config';

const model = { baseURL: 'http://127.0.0.1:1/v1', model: 'local', allowLoopbackHttp: true };
const identity = { sessionId: 'session', conversationId: 'conversation', runId: 'run', requestId: 'request', workerGeneration: 1 };
const protocol = { id: 'openai-responses', version: 1 };
const definition = (length: number): ToolDefinition => ({ name: 'mcp_fixture_read', description: 'x'.repeat(length), inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, risk: 'command' });
const config = (maxInputTokens: number) => parseNativeConfig({ schemaVersion: 1, options: { autoCompact: 'before_send', maxInputTokens } });

test('post-compaction hard input boundary includes the immutable tool catalog at the exact UTF-8 limit', () => {
  const context: ModelContext = { protocol, items: [{ role: 'assistant', content: 'kept summary' }] };
  const tools = [definition(1200)];
  const selected = { ...model, toolDefinitions: tools };
  const pending = pendingNativeContext(context, '继续🙂', selected);
  const limit = estimateResponsesInputTokens(pending, '项目规则', tools);
  assert.doesNotThrow(() => assertNativeInputBudget(context, '继续🙂', '项目规则', config(limit), selected));
  assert.throws(() => assertNativeInputBudget(context, '继续🙂', '项目规则', config(limit - 1), selected), /超过运行预算/);
  assert.doesNotThrow(() => assertNativeInputBudget(context, '继续🙂', '项目规则', config(limit - 1), model));
});

test('newly selected tools can reach the auto-compaction threshold even when history and input are unchanged', async () => {
  const context: ModelContext = { protocol, items: [{ role: 'assistant', content: 'h'.repeat(1000) }] };
  let considered = 0;
  const ledger = {
    lookupAutoCompaction: () => undefined,
    loadContext: () => context,
    getCompactionSource: () => { considered++; throw Object.assign(new Error('No complete prefix'), { code: 'nothing_to_compact' }); },
  } as unknown as NativeRunStore;
  const common = { ledger, identity, input: '继续', config: config(2048), instructions: '', signal: new AbortController().signal,
    startedAt: performance.now(), assertOwnership: async () => {}, onCompacting: () => { assert.fail('No complete prefix is available.'); }, onCommitted: async () => {} };
  assert.deepEqual(await autoCompactBeforeSend({ ...common, model }), { compacted: false, remainingRequests: 30 });
  assert.equal(considered, 0);
  assert.deepEqual(await autoCompactBeforeSend({ ...common, model: { ...model, toolDefinitions: [definition(800)] } }), { compacted: false, remainingRequests: 30 });
  assert.equal(considered, 1, 'the actual Responses tool schemas participate in the before-send threshold');
});

test('a tool catalog that exceeds the minimum task budget cannot spend an automatic summary request', async () => {
  let summaries = 0;
  const ledger = {
    lookupAutoCompaction: () => undefined,
    loadContext: () => ({ protocol, items: [{ role: 'assistant', content: 'old history' }] }),
    getCompactionSource: () => assert.fail('Summarizing history cannot remove the selected tool catalog.'),
  } as unknown as NativeRunStore;
  await assert.rejects(autoCompactBeforeSend({ ledger, identity, input: '继续', config: config(1024),
    model: { ...model, toolDefinitions: [definition(2000)] }, instructions: '', signal: new AbortController().signal,
    startedAt: performance.now(), assertOwnership: async () => {}, onCompacting: () => { summaries++; }, onCommitted: async () => {},
  }), /工具定义已超过运行预算/);
  assert.equal(summaries, 0);
});
