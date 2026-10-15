import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { summarizeDiagnostics } from '../native-context-baseline.mjs';
import { BASELINE_CASES, buildBaselineMatrix, compareBaselineMatrices, parseMatrixArguments, runBaselineMatrix, validateMatrixManifest } from '../native-context-baseline-matrix.mjs';

// 以下是离线单元数据，验证汇总规则，不作为真实模型运行或正式基线证据。
const binding = { candidateSha: 'a'.repeat(40), protocol: 'openai-responses', model: 'fixed-model', configurationDigest: 'b'.repeat(64), materialDigest: 'c'.repeat(64) };
const usage = input => ({ inputTokens: input, outputTokens: 2, nonCachedInputTokens: input - 3, cacheReadInputTokens: 3, cacheCreationInputTokens: 0 });
function diagnostic(caseId, overrides = {}) {
  return { schemaVersion: 1, requestKey: `${caseId}:1`, identity: { runId: `run:${caseId}`, requestId: `submit:${caseId}` }, attempt: 1, purpose: 'normal',
    protocol: { id: binding.protocol, version: 1 }, model: binding.model, phase: 'finished', requestSent: true, startedAt: 100, finishedAt: 110, elapsedMs: 10,
    estimatedInputTokens: 50, estimateMethod: 'utf8_bytes', contextBytes: 100, contextDigest: 'd'.repeat(64), payloadBytes: 150, payloadDigest: 'e'.repeat(64), toolsetDigest: 'f'.repeat(64),
    components: { tools: { bytes: 30, digest: 'f'.repeat(64), accounting: 'serialized' } }, usage: usage(10), outcome: 'completed', ...overrides };
}
function report(caseId, records = [diagnostic(caseId)]) {
  return { ...summarizeDiagnostics(records, { label: caseId, candidateSha: binding.candidateSha, configurationDigest: binding.configurationDigest }),
    evidenceSource: 'real_model', materialDigest: binding.materialDigest };
}
function fixture() {
  return { manifest: { version: 1, binding, reports: BASELINE_CASES.map(({ id }) => ({ caseId: id, path: `${id}.json` })) },
    loaded: BASELINE_CASES.map(({ id }) => ({ report: report(id), digest: '1'.repeat(64) })) };
}

test('固定九个场景，未收集和缺失元数据保持 pending 而不是零或已运行', () => {
  assert.deepEqual(BASELINE_CASES.map(item => item.id), ['short_zh', 'short_en', 'continuous_read', 'long_command_output', 'mcp_skills', 'long_task', 'image', 'delegation', 'compaction']);
  const empty = buildBaselineMatrix({ version: 1, binding: {}, reports: [] }, []);
  assert.equal(empty.status, 'pending'); assert.deepEqual(empty.coverage, { measured: 0, required: 9 });
  assert.ok(empty.cases.every(row => row.status === 'pending' && row.metrics === null && row.costUSD === null));
  const { manifest, loaded } = fixture(); loaded[0].report.candidateSha = null;
  const missing = buildBaselineMatrix(manifest, loaded);
  assert.equal(missing.cases[0].status, 'pending'); assert.ok(missing.cases[0].reasons.includes('candidateSha_unknown'));
});

test('同一候选协议模型配置素材才能比较，九场景元数据逐一核对', () => {
  const { manifest, loaded } = fixture(), first = buildBaselineMatrix(manifest, loaded);
  assert.equal(first.status, 'measured'); assert.equal(first.coverage.measured, 9);
  const currentLoaded = structuredClone(loaded); currentLoaded[0].report = report('short_zh', [diagnostic('short_zh', { usage: usage(20) })]);
  const current = buildBaselineMatrix(manifest, currentLoaded), compared = compareBaselineMatrices(first, current);
  assert.equal(compared.status, 'comparable'); assert.equal(compared.differences[0].cumulativeInputTokensDelta, 10); assert.equal(compared.differences[0].costUSDDelta, null);
  for (const key of Object.keys(binding)) {
    const different = structuredClone(current); different.binding[key] = key === 'model' ? 'another-model' : key === 'protocol' ? 'anthropic-messages' : '9'.repeat(key === 'candidateSha' ? 40 : 64);
    assert.equal(compareBaselineMatrices(first, different).status, 'blocked', key);
  }
  const mismatched = structuredClone(loaded); mismatched[0].report.materialDigest = '9'.repeat(64);
  assert.equal(buildBaselineMatrix(manifest, mismatched).cases[0].status, 'invalid');
});

test('生产标记不替代真实来源，mock 或 fixture 不能冒称真实基线', () => {
  const { manifest, loaded } = fixture();
  for (const badSource of ['fixture', 'mock', 'synthetic']) {
    const values = structuredClone(loaded); values[0].report.source = badSource; values[0].report.evidenceSource = 'real_model';
    const matrix = buildBaselineMatrix(manifest, values);
    assert.equal(matrix.cases[0].status, 'invalid'); assert.ok(matrix.cases[0].reasons.includes('fixture_cannot_be_real_model'));
  }
  const unverified = structuredClone(loaded); delete unverified[0].report.evidenceSource;
  assert.equal(buildBaselineMatrix(manifest, unverified).cases[0].status, 'pending');
  const conflicting = structuredClone(loaded); conflicting[0].report.mock = true;
  assert.equal(buildBaselineMatrix(manifest, conflicting).status, 'invalid');
  assert.throws(() => validateMatrixManifest({ ...manifest, reports: [{ ...manifest.reports[0], evidenceSource: 'real_model' }] }));
});

test('诊断生命周期去重，失败重试保留未知，禁止将同一请求复用为多个场景', () => {
  const { manifest, loaded } = fixture(), first = diagnostic('short_zh');
  loaded[0].report = report('short_zh', [{ ...first, phase: 'started', usage: null }, { ...first, phase: 'request', usage: null }, first, first,
    diagnostic('short_zh', { requestKey: 'short_zh:2', attempt: 2, purpose: 'retry', usage: null, outcome: 'failed' })]);
  const row = buildBaselineMatrix(manifest, loaded).cases[0];
  assert.equal(row.requestCount, 2); assert.equal(row.status, 'pending'); assert.ok(row.reasons.includes('usage_unknown'));
  assert.deepEqual(row.metrics.cumulativeInputTokens, { knownSubtotal: 10, unknownRequests: 1, total: null });
  assert.equal(row.metrics.peakInputTokensComplete, false); assert.equal(row.diagnostics[1].outcome, 'failed');
  loaded[1].report = { ...report('short_en'), requests: [loaded[0].report.requests[0]] };
  const reused = buildBaselineMatrix(manifest, loaded);
  assert.ok(reused.cases[0].reasons.includes('request_reused_across_cases')); assert.equal(reused.cases[1].status, 'invalid');
  assert.equal(compareBaselineMatrices(reused, reused).status, 'blocked');
});

test('安全投影不导出正文凭据URL扩展字段，不把逻辑分项相加为token', () => {
  const { manifest, loaded } = fixture();
  const original = diagnostic('short_zh', { secret: 'PRIVATE_SENTINEL', responseText: 'PRIVATE_SENTINEL', baseURL: 'https://PRIVATE_SENTINEL.invalid' });
  original.components.tools.raw = 'PRIVATE_SENTINEL';
  loaded[0].report = { source: 'real_model', baselineCaseId: 'short_zh', ...binding, records: [original] };
  const matrix = buildBaselineMatrix(manifest, loaded);
  assert.equal(matrix.cases[0].status, 'measured'); assert.ok(!JSON.stringify(matrix).includes('PRIVATE_SENTINEL'));
  assert.equal(matrix.cases[0].metrics.cumulativeInputTokens.total, 10);
  const invalid = structuredClone(loaded); invalid[0].report.records[0].protocol.id = 'anthropic-messages';
  assert.equal(buildBaselineMatrix(manifest, invalid).cases[0].status, 'invalid');
  const inconsistent = structuredClone(loaded); inconsistent[0].report.records[0].usage.nonCachedInputTokens = 10;
  assert.ok(buildBaselineMatrix(manifest, inconsistent).cases[0].reasons.includes('input_components_inconsistent'));
});

test('CLI只读生成新文件，缺失报告写pending，已有输出不覆盖', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-matrix-'));
  try {
    const manifest = path.join(root, 'manifest.json'), out = path.join(root, 'matrix.json');
    await writeFile(manifest, JSON.stringify({ version: 1, binding, reports: [{ caseId: 'short_zh', path: 'missing.json' }] }));
    const result = await runBaselineMatrix({ manifest, out });
    assert.equal(result.status, 'pending'); assert.ok(result.cases[0].reasons.includes('report_unavailable'));
    const original = await readFile(out, 'utf8'); await assert.rejects(runBaselineMatrix({ manifest, out }), { code: 'EEXIST' });
    assert.equal(await readFile(out, 'utf8'), original);
    assert.deepEqual(parseMatrixArguments(['--manifest', manifest, '--out', out, '--compare', out]), { manifest, out, compare: out });
    for (const args of [['--out', out], ['--manifest', manifest, '--out', out, '--out', out], ['--manifest', manifest, '--out', out, '--run-model', 'true']]) assert.throws(() => parseMatrixArguments(args));
    assert.throws(() => validateMatrixManifest({ version: 1, binding: { protocol: 'toString' }, reports: [] }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
