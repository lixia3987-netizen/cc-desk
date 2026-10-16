import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateNativeCost, nativeCostEstimate, nativeCostLabel, type NativeModelPricing } from '../src/shared/native-cost';
import { chatUsageLabel } from '../src/shared/chat';
import { ConnectionStore } from '../src/main/engines/native/connections';

const pricing = { model: 'fixture', inputUSDPerMillion: 2, outputUSDPerMillion: 8 };
const uncached = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, nonCachedInputTokens: inputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
test('cost requires complete reported counts and the exact priced model', () => {
  assert.equal(estimateNativeCost(uncached(1_000_000, 500_000), pricing, 'fixture'), 6);
  assert.equal(estimateNativeCost(uncached(0, 0), pricing, 'fixture'), 0);
  assert.equal(nativeCostEstimate({ inputTokens: 12, outputTokens: 1 }, pricing, 'fixture').reason, 'missing_cache_usage', 'old records stay readable without inventing cache zero');
  for (const usage of [null, {}, { totalTokens: 50 }, { inputTokens: 5 }, { inputTokens: -1, outputTokens: 1 }, { inputTokens: 0.5, outputTokens: 1 }, { inputTokens: Infinity, outputTokens: 1 }]) {
    assert.equal(estimateNativeCost(usage, pricing, 'fixture'), undefined);
  }
  for (const price of [null, {}, { ...pricing, inputUSDPerMillion: NaN }, { ...pricing, outputUSDPerMillion: -1 }, { ...pricing, model: 'other' }]) {
    assert.equal(estimateNativeCost({ inputTokens: 1, outputTokens: 1 }, price, 'fixture'), undefined);
  }
  assert.equal(estimateNativeCost({ inputTokens: 1, outputTokens: 1 }, pricing, 'override'), undefined);
});

test('cache input is included once and each nonzero cache category requires a matching rate', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 500_000, nonCachedInputTokens: 600_000, cacheReadInputTokens: 300_000, cacheCreationInputTokens: 100_000 };
  const cachedPricing = { ...pricing, cacheReadUSDPerMillion: 0.2, cacheCreationUSDPerMillion: 3 };
  assert.equal(estimateNativeCost(usage, cachedPricing, 'fixture'), 5.56);
  assert.equal(nativeCostEstimate(usage, pricing, 'fixture').reason, 'missing_cache_pricing');
  assert.equal(nativeCostEstimate({ ...usage, cacheReadInputTokens: null }, cachedPricing, 'fixture').reason, 'missing_cache_usage');
  assert.equal(nativeCostEstimate({ ...usage, nonCachedInputTokens: 1_000_000 }, cachedPricing, 'fixture').reason, 'inconsistent_usage');
  assert.equal(estimateNativeCost(usage, { ...cachedPricing, cacheReadUSDPerMillion: 0, cacheCreationUSDPerMillion: 0 }, 'fixture'), 5.2);
  for (const invalid of [-1, 0.5, NaN, Infinity]) assert.equal(estimateNativeCost({ ...usage, cacheReadInputTokens: invalid }, cachedPricing, 'fixture'), undefined);
});

test('native usage text identifies cumulative scope, fee source and unknown cache without printing zero', () => {
  const label = chatUsageLabel({ inputTokens: 42, outputTokens: 0, cacheReadInputTokens: null,
    nativeCost: nativeCostEstimate({ inputTokens: 42, outputTokens: 0 }, pricing, 'fixture') }, true);
  assert.match(label, /本回合累计.*输入 42.*输出 0/);
  assert.match(label, /非缓存输入 未知.*缓存读取 未知.*缓存创建 未知/);
  assert.match(label, /费用未知.*服务未报告完整缓存分项.*用户填写费率/);
  assert.doesNotMatch(label, /缓存读取 0|估价 \$0/);
  assert.match(nativeCostLabel(nativeCostEstimate(uncached(1, 1), pricing, 'other')), /模型.*不一致/);
});

test('connection prices persist, snapshots stay immutable, and overrides never reuse unrelated rates', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-cost-'));
  try {
    const environment = { EVAL_KEY: 'private-test-token' };
    const store = new ConnectionStore(directory, { environment });
    const input = { name: 'Test', protocol: 'chat-completions' as const, baseURL: 'https://example.test/v1', model: 'fixture', auth: { mode: 'env' as const, variable: 'EVAL_KEY' }, allowLoopbackHttp: false, enabled: true, pricing: { ...pricing, cacheReadUSDPerMillion: 0.2, cacheCreationUSDPerMillion: 3 } };
    const first = store.upsert(input), snapshot = store.resolve(first.id);
    assert.equal(snapshot.protocol, 'chat-completions');
    assert.ok(Object.isFrozen(snapshot.pricing));
    first.pricing!.inputUSDPerMillion = 99;
    assert.equal(store.resolve(first.id).pricing?.inputUSDPerMillion, 2);
    store.upsert({ ...input, id: first.id, revision: first.revision, pricing: { ...input.pricing, inputUSDPerMillion: 7 } });
    assert.equal(snapshot.pricing?.inputUSDPerMillion, 2);
    const reopened = new ConnectionStore(directory, { environment });
    assert.equal(reopened.resolve(first.id).pricing?.inputUSDPerMillion, 7);
    assert.equal(reopened.resolve(first.id).pricing?.cacheReadUSDPerMillion, 0.2);
    assert.equal(reopened.resolve(first.id).pricing?.cacheCreationUSDPerMillion, 3);
    assert.equal(estimateNativeCost({ inputTokens: 4, outputTokens: 2 }, snapshot.pricing, 'other'), undefined);
    const before = fs.readFileSync(path.join(directory, 'native/connections.json'), 'utf8');
    for (const price of [{ ...pricing, outputUSDPerMillion: Infinity }, { ...pricing, inputUSDPerMillion: -1 }, { ...pricing, model: '' }, { ...pricing, cacheReadUSDPerMillion: -1 }, { ...pricing, cacheCreationUSDPerMillion: NaN }, { ...pricing, cacheReadUSDPerMillion: null }, { ...pricing, cacheCreationUSDPerMillion: '1' }, { ...pricing, secret: 'must-not-persist' }]) {
      assert.throws(() => reopened.upsert({ ...input, pricing: price as unknown as NativeModelPricing }));
    }
    assert.equal(fs.readFileSync(path.join(directory, 'native/connections.json'), 'utf8'), before);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
