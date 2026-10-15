import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionConfigDraftStore } from '../src/renderer/session-config-drafts';
import { SessionConfig } from '../src/renderer/SessionConfig';
import type { EngineConfig, ExecutionDescriptor } from '../src/shared/execution';
import type { Session } from '../src/shared/types';

const initial = (): EngineConfig => ({ schemaVersion: 1, options: {
  runtimePolicy: 'custom', maxInputTokens: 64000, autoCompact: 'on', maxToolCalls: 100, modelRetry: 'off',
} });
const update = (config: EngineConfig, values: EngineConfig['options']): EngineConfig => ({ ...config, options: { ...config.options, ...values } });

test('all sections share one complete session draft and switching sessions preserves both drafts', async () => {
  const store = new SessionConfigDraftStore(), saved: EngineConfig[] = [];
  store.observe('one', initial()); store.observe('two', initial());
  store.change('one', update(store.get('one')!.value, { maxInputTokens: 32000 }));
  store.change('two', update(store.get('two')!.value, { maxToolCalls: 20 }));
  // 返回其他区域时读取相同的完整草稿，而非各区域的独立副本。
  store.change('one', update(store.get('one')!.value, { autoCompact: 'off' }));
  assert.deepEqual(store.dirtySessionIds(), ['one', 'two']);
  await store.save('one', async config => { saved.push(config); });
  assert.equal(saved[0].options.maxInputTokens, 32000);
  assert.equal(saved[0].options.autoCompact, 'off');
  assert.equal(store.get('one')!.dirty, false);
  assert.equal(store.get('one')!.saved, true);
  assert.equal(store.get('two')!.value.options.maxToolCalls, 20);
  assert.deepEqual(store.dirtySessionIds(), ['two']);
});

test('background updates refresh clean drafts but never overwrite unsaved changes', () => {
  const store = new SessionConfigDraftStore(); store.observe('one', initial());
  store.observe('one', update(initial(), { maxToolCalls: 80 }));
  assert.equal(store.get('one')!.value.options.maxToolCalls, 80);
  store.change('one', update(store.get('one')!.value, { maxInputTokens: 32000 }));
  const changed = update(initial(), { maxToolCalls: 40, maxInputTokens: 48000 });
  store.observe('one', changed);
  assert.equal(store.get('one')!.value.options.maxInputTokens, 32000);
  assert.equal(store.get('one')!.value.options.maxToolCalls, 80);
  assert.deepEqual(store.get('one')!.persisted, changed);
  assert.equal(store.get('one')!.conflict, true);
  assert.equal(store.hasDirty(), true);
});

test('conflicted drafts require explicit resolution and retain unrelated newly saved fields', async () => {
  const store = new SessionConfigDraftStore(); store.observe('one', initial());
  store.change('one', update(initial(), { maxInputTokens: 32000 }));
  store.observe('one', update(initial(), { maxInputTokens: 48000, maxToolCalls: 25, future: { keep: true } }));
  let writes = 0;
  await store.save('one', async () => { writes += 1; });
  assert.equal(writes, 0);
  store.keepChanges('one');
  assert.equal(store.get('one')!.conflict, false);
  assert.equal(store.get('one')!.value.options.maxInputTokens, 32000);
  assert.equal(store.get('one')!.value.options.maxToolCalls, 25);
  assert.deepEqual(store.get('one')!.value.options.future, { keep: true });
  await store.save('one', async () => { writes += 1; });
  assert.equal(writes, 1);
});

test('schema changes cannot be overwritten by retaining a stale draft; explicit reload clears it', () => {
  const store = new SessionConfigDraftStore(); store.observe('one', initial());
  store.change('one', update(initial(), { maxInputTokens: 32000 }));
  const newSchema = { schemaVersion: 2, options: { future: ['saved'] } };
  store.observe('one', newSchema);
  store.keepChanges('one');
  assert.equal(store.get('one')!.conflict, true);
  store.discard('one');
  assert.deepEqual(store.get('one')!.value, newSchema);
  assert.equal(store.hasDirty(), false);
});

test('save failure preserves the draft and a later save succeeds without duplicate concurrent writes', async () => {
  const store = new SessionConfigDraftStore(); store.observe('one', initial());
  store.change('one', update(initial(), { maxInputTokens: 32000 }));
  await assert.rejects(store.save('one', async () => { throw new Error('write failed'); }), /write failed/);
  assert.equal(store.get('one')!.busy, false);
  assert.equal(store.get('one')!.saved, false);
  assert.equal(store.get('one')!.dirty, true);
  let finish!: () => void, writes = 0;
  const pending = store.save('one', async () => { writes += 1; await new Promise<void>(resolve => { finish = resolve; }); });
  await store.save('one', async () => { writes += 1; });
  store.change('one', update(initial(), { maxInputTokens: 12000 }));
  assert.equal(store.get('one')!.value.options.maxInputTokens, 32000);
  assert.equal(store.get('one')!.busy, true);
  finish(); await pending;
  assert.equal(writes, 1);
  assert.equal(store.get('one')!.saved, true);
  assert.equal(store.hasDirty(), false);
});

test('a save acknowledgement received before the request resolves stays saved and clean', async () => {
  const store = new SessionConfigDraftStore(); store.observe('one', initial());
  const changed = update(initial(), { maxInputTokens: 32000 }); store.change('one', changed);
  let finish!: () => void;
  const pending = store.save('one', async config => {
    store.observe('one', config);
    await new Promise<void>(resolve => { finish = resolve; });
  });
  assert.equal(store.get('one')!.busy, true);
  assert.equal(store.get('one')!.dirty, false);
  finish(); await pending;
  store.observe('one', changed);
  assert.equal(store.get('one')!.saved, true);
  assert.equal(store.get('one')!.dirty, false);
});

test('different persisted changes during a pending save are not silently accepted as its result', async () => {
  const store = new SessionConfigDraftStore(); store.observe('one', initial());
  store.change('one', update(initial(), { maxInputTokens: 32000 }));
  let finish!: () => void;
  const pending = store.save('one', async () => { await new Promise<void>(resolve => { finish = resolve; }); });
  store.observe('one', update(initial(), { maxInputTokens: 48000 }));
  finish(); await pending;
  assert.equal(store.get('one')!.value.options.maxInputTokens, 32000);
  assert.equal(store.get('one')!.persisted.options.maxInputTokens, 48000);
  assert.equal(store.get('one')!.conflict, true);
  assert.equal(store.get('one')!.saved, false);
  assert.equal(store.hasDirty(), true);
});

test('object order and matching persisted values do not leave false dirty or conflict indicators', () => {
  const store = new SessionConfigDraftStore(); store.observe('one', initial());
  store.change('one', { schemaVersion: 1, options: Object.fromEntries(Object.entries(initial().options).reverse()) });
  assert.equal(store.hasDirty(), false);
  store.change('one', update(initial(), { maxInputTokens: 32000 }));
  const updated = update(initial(), { maxInputTokens: 48000 }); store.observe('one', updated);
  store.change('one', updated);
  assert.equal(store.hasDirty(), false);
  assert.equal(store.get('one')!.conflict, false);
});

test('dirty listeners survive component subscriptions and stop after unsubscribing', () => {
  const store = new SessionConfigDraftStore(), events: boolean[] = [];
  const unsubscribe = store.subscribe(() => { events.push(store.hasDirty()); });
  store.observe('one', initial());
  store.change('one', update(initial(), { maxInputTokens: 32000 }));
  unsubscribe();
  store.discard('one');
  assert.deepEqual(events, [false, true]);
  assert.equal(store.getRevision(), 3);
});

test('session policy source explains that all four policy sections change together', () => {
  const session = { id: 'one', title: '会话', status: 'stopped', engineConfig: initial(), execution: { providerId: 'native', mode: 'structured' } } as Session;
  const descriptor: ExecutionDescriptor = { providerId: 'native', mode: 'structured', displayName: 'Native', configuration: { schemaVersion: 1, defaults: initial(), fields: [] },
    capabilities: { available: true, structured: true, terminal: false, approvals: true, resume: true, fork: false, commands: false, contextUsage: true, liveConfig: true, attachments: true } };
  const html = renderToStaticMarkup(createElement(SessionConfig, { session, descriptor, onError: () => {} }));
  assert.match(html, /会话运行策略来源/);
  assert.match(html, /上下文预算、自动压缩、失败重试和运行限制/);
  assert.match(html, /切换来源会同时影响以上四项/);
  assert.doesNotMatch(html, /切换页面或关闭设置会放弃/);
});
