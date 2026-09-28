import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateNativeCost } from '../src/shared/native-cost';
import { ConnectionStore } from '../src/main/engines/native/connections';

const pricing = { model: 'fixture', inputUSDPerMillion: 2, outputUSDPerMillion: 8 };
test('cost requires complete reported counts and the exact priced model', () => {
  assert.equal(estimateNativeCost({ inputTokens: 1_000_000, outputTokens: 500_000 }, pricing, 'fixture'), 6);
  assert.equal(estimateNativeCost({ inputTokens: 0, outputTokens: 0 }, pricing, 'fixture'), 0);
  for (const usage of [null, {}, { totalTokens: 50 }, { inputTokens: 5 }, { inputTokens: -1, outputTokens: 1 }, { inputTokens: 0.5, outputTokens: 1 }, { inputTokens: Infinity, outputTokens: 1 }]) {
    assert.equal(estimateNativeCost(usage, pricing, 'fixture'), undefined);
  }
  for (const price of [null, {}, { ...pricing, inputUSDPerMillion: NaN }, { ...pricing, outputUSDPerMillion: -1 }, { ...pricing, model: 'other' }]) {
    assert.equal(estimateNativeCost({ inputTokens: 1, outputTokens: 1 }, price, 'fixture'), undefined);
  }
  assert.equal(estimateNativeCost({ inputTokens: 1, outputTokens: 1 }, pricing, 'override'), undefined);
});

test('connection prices persist, snapshots stay immutable, and overrides never reuse unrelated rates', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-cost-'));
  try {
    const environment = { EVAL_KEY: 'private-test-token' };
    const store = new ConnectionStore(directory, { environment });
    const input = { name: 'Test', protocol: 'chat-completions' as const, baseURL: 'https://example.test/v1', model: 'fixture', auth: { mode: 'env' as const, variable: 'EVAL_KEY' }, allowLoopbackHttp: false, enabled: true, pricing };
    const first = store.upsert(input), snapshot = store.resolve(first.id);
    assert.equal(snapshot.protocol, 'chat-completions');
    assert.ok(Object.isFrozen(snapshot.pricing));
    first.pricing!.inputUSDPerMillion = 99;
    assert.equal(store.resolve(first.id).pricing?.inputUSDPerMillion, 2);
    store.upsert({ ...input, id: first.id, revision: first.revision, pricing: { ...pricing, inputUSDPerMillion: 7 } });
    assert.equal(snapshot.pricing?.inputUSDPerMillion, 2);
    const reopened = new ConnectionStore(directory, { environment });
    assert.equal(reopened.resolve(first.id).pricing?.inputUSDPerMillion, 7);
    assert.equal(estimateNativeCost({ inputTokens: 4, outputTokens: 2 }, snapshot.pricing, 'other'), undefined);
    const before = fs.readFileSync(path.join(directory, 'native/connections.json'), 'utf8');
    for (const price of [{ ...pricing, outputUSDPerMillion: Infinity }, { ...pricing, inputUSDPerMillion: -1 }, { ...pricing, model: '' }]) {
      assert.throws(() => reopened.upsert({ ...input, pricing: price }));
    }
    assert.equal(fs.readFileSync(path.join(directory, 'native/connections.json'), 'utf8'), before);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
