import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeModelBudget } from '../src/main/engines/native/model-budget';

const configured = { maxInputTokens: 64_000, maxOutputTokens: 8192 };
const million = {
  contextWindow: { value: 1_048_576, source: 'fallback' as const },
  maxInputTokens: { value: 1_048_576, source: 'fallback' as const },
};

test('legacy and explicit custom input ceilings remain below a larger known model window', () => {
  assert.deepEqual(nativeModelBudget(configured, million), configured);
  assert.deepEqual(nativeModelBudget({ ...configured, inputBudgetMode: 'custom' }, million), { ...configured, inputBudgetMode: 'custom' });
  assert.deepEqual(configured, { maxInputTokens: 64_000, maxOutputTokens: 8192 });
});

test('model input mode follows known capacity while reserving the effective output ceiling', () => {
  assert.deepEqual(nativeModelBudget({ ...configured, inputBudgetMode: 'model' }, million), {
    inputBudgetMode: 'model', maxInputTokens: 1_040_384, maxOutputTokens: 8192,
  });
  const capped = nativeModelBudget({ ...configured, inputBudgetMode: 'model' }, {
    ...million, maxInputTokens: { value: 900_000, source: 'provider' }, maxOutputTokens: { value: 1024, source: 'provider' },
  });
  assert.equal(capped.maxInputTokens, 900_000); assert.equal(capped.maxOutputTokens, 1024);
  const contextOnly = nativeModelBudget({ ...configured, inputBudgetMode: 'model' }, { contextWindow: { value: 32_000, source: 'catalog' } });
  assert.equal(contextOnly.maxInputTokens, 32_000 - 8192);
});

test('model mode uses an explicit input limit when total capacity is unknown, and never infers input from output alone', () => {
  assert.equal(nativeModelBudget({ ...configured, inputBudgetMode: 'model' }, { maxInputTokens: { value: 128_000, source: 'provider' } }).maxInputTokens, 128_000);
  assert.deepEqual(nativeModelBudget({ ...configured, inputBudgetMode: 'model' }), { ...configured, inputBudgetMode: 'model' });
  assert.deepEqual(nativeModelBudget({ ...configured, inputBudgetMode: 'model' }, { maxOutputTokens: { value: 1024, source: 'provider' } }), {
    inputBudgetMode: 'model', maxInputTokens: 64_000, maxOutputTokens: 1024,
  });
});

test('both input modes reject a known window with no room left after output reservation', () => {
  for (const inputBudgetMode of ['custom', 'model'] as const) {
    assert.throws(() => nativeModelBudget({ ...configured, inputBudgetMode }, { contextWindow: { value: 8192, source: 'provider' } }), /未发起模型请求/);
  }
});
