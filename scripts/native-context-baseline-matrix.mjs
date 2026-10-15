import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { summarizeDiagnostics } from './native-context-baseline.mjs';
import { sha256 } from './native-delegation-model-regression-lib.mjs';

export const BASELINE_CASES = Object.freeze([
  { id: 'short_zh', name: '中文短问答' }, { id: 'short_en', name: '英文短问答' },
  { id: 'continuous_read', name: '连续文件读取' }, { id: 'long_command_output', name: '长命令输出' },
  { id: 'mcp_skills', name: 'MCP 与所选 Skills' }, { id: 'long_task', name: '长任务与多轮工具' },
  { id: 'image', name: '图像输入' }, { id: 'delegation', name: '父子代理委派' }, { id: 'compaction', name: '上下文压缩' },
]);
const cases = new Set(BASELINE_CASES.map(item => item.id));
const bindingKeys = ['candidateSha', 'protocol', 'model', 'configurationDigest', 'materialDigest'];
const usageMetrics = ['cumulativeInputTokens', 'cumulativeOutputTokens', 'nonCachedInputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'];
const protocols = { responses: 'openai-responses', 'chat-completions': 'openai-chat-completions', anthropic: 'anthropic-messages',
  'openai-responses': 'openai-responses', 'openai-chat-completions': 'openai-chat-completions', 'anthropic-messages': 'anthropic-messages' };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const revision = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const model = value => typeof value === 'string' && /^[a-zA-Z0-9_.:\[\]\/-]{1,256}$/.test(value) && !value.includes('//');
const protocol = value => {
  const key = typeof value === 'string' ? value : value?.id;
  return Object.hasOwn(protocols, key) ? protocols[key] : null;
};
const keys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
function fixtureMarked(value, depth = 0) {
  if (depth > 64) return true;
  if (Array.isArray(value)) return value.some(item => fixtureMarked(item, depth + 1));
  return object(value) && (value.mock === true || value.fixture === true
    || ['mock', 'fixture', 'synthetic'].includes(value.source) || ['mock', 'fixture', 'synthetic'].includes(value.evidenceSource)
    || Object.values(value).some(item => object(item) || Array.isArray(item) ? fixtureMarked(item, depth + 1) : false));
}

export function validateMatrixManifest(value) {
  if (!object(value) || !keys(value, ['version', 'binding', 'reports']) || value.version !== 1 || !object(value.binding)
    || !keys(value.binding, bindingKeys) || !Array.isArray(value.reports) || value.reports.length > 256) throw new Error('invalid_manifest');
  const binding = {};
  for (const key of bindingKeys) {
    const item = value.binding[key] ?? null;
    if (item !== null && !(key === 'candidateSha' ? revision(item) : key === 'protocol' ? protocol(item) : key === 'model' ? model(item) : hash(item))) throw new Error('invalid_binding');
    binding[key] = key === 'protocol' ? protocol(item) : item;
  }
  const seen = new Set();
  const reports = value.reports.map(entry => {
    if (!object(entry) || !keys(entry, ['caseId', 'path', 'reportCaseId']) || !cases.has(entry.caseId)
      || typeof entry.path !== 'string' || !entry.path || entry.path.length > 4096 || /[\x00-\x1f]/.test(entry.path)
      || entry.reportCaseId !== undefined && (typeof entry.reportCaseId !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,200}$/.test(entry.reportCaseId))) throw new Error('invalid_report_reference');
    const identity = JSON.stringify([entry.caseId, entry.path, entry.reportCaseId ?? null]);
    if (seen.has(identity)) throw new Error('duplicate_report_reference');
    seen.add(identity);
    return { caseId: entry.caseId, path: entry.path, ...(entry.reportCaseId ? { reportCaseId: entry.reportCaseId } : {}) };
  });
  return { version: 1, binding, reports };
}

function actualBinding(report, selected) {
  const reportedProtocol = protocol(report.protocol) ?? protocol(report.groups?.length === 1 ? report.groups[0].protocol : null);
  const reportedModel = report.model ?? (report.groups?.length === 1 ? report.groups[0].model : null);
  const configurationDigest = hash(report.configurationDigest) ? report.configurationDigest
    : object(report.configuration) ? sha256(canonical(report.configuration)) : null;
  // 素材摘要必须由收集方冻结；不以请求正文摘要、配置摘要或 manifest 值代替。
  const materialDigest = selected?.materialDigest ?? report.materialDigest;
  return { candidateSha: revision(report.candidateSha) ? report.candidateSha : null, protocol: reportedProtocol,
    model: model(reportedModel) ? reportedModel : null, configurationDigest, materialDigest: hash(materialDigest) ? materialDigest : null };
}

function selectSource(report, entry) {
  if (!object(report)) return { issue: 'unsupported_report' };
  let selected;
  if (entry.reportCaseId) {
    if (!Array.isArray(report.cases)) return { issue: 'report_case_missing' };
    const matching = report.cases.filter(item => item?.caseId === entry.reportCaseId);
    if (matching.length !== 1) return { issue: 'report_case_missing_or_duplicate' };
    [selected] = matching;
  } else if (Array.isArray(report.cases)) {
    if (report.cases.length !== 1) return { issue: 'report_case_selection_required' };
    [selected] = report.cases;
  }
  if (fixtureMarked(report)) return { invalid: 'fixture_cannot_be_real_model' };
  if (report.status === 'invalid') return { invalid: 'source_report_invalid' };
  const real = report.source === 'real_model' || report.source === 'production_diagnostics' && report.evidenceSource === 'real_model';
  if (!real || selected && selected.source !== undefined && selected.source !== 'real_model') return { issue: 'real_transport_not_verified' };
  if (report.status === 'not_run' || selected?.status === 'not_run') return { issue: 'not_run' };
  const source = selected ?? report;
  const measuredCaseId = source.baselineCaseId ?? report.baselineCaseId
    ?? (report.kind === 'native_context_baseline' ? report.label : selected?.mode === 'parallel' ? 'delegation' : null);
  if (measuredCaseId === null || measuredCaseId === undefined) return { issue: 'case_identity_unknown' };
  if (measuredCaseId !== entry.caseId) return { invalid: 'case_identity_mismatch' };
  let records = source.records ?? source.diagnostics;
  if (!Array.isArray(records) && Array.isArray(source.attempts)) records = source.attempts.filter(item => item?.diagnostic).map(item => item.diagnostic);
  if (!Array.isArray(records) && report.kind === 'native_context_baseline' && Array.isArray(source.requests)) {
    // 已生成的安全报告可再次投影；不导入任意扩展字段或模型正文。
    records = source.requests.map(item => ({ ...item, schemaVersion: 1,
      identity: { runId: item.runId, requestId: item.requestId }, protocol: { id: item.protocol } }));
  }
  if (!Array.isArray(records)) return { issue: 'diagnostics_missing', selected };
  return { records, selected };
}

function bindingIssues(expected, actual) {
  return bindingKeys.flatMap(key => expected[key] == null || actual[key] == null ? [`${key}_unknown`]
    : expected[key] !== actual[key] ? [`${key}_mismatch`] : []);
}

/** 只读收集报告，不连接模型、不执行工具，也不从 run 汇总中重复叠加用量。 */
export function buildBaselineMatrix(manifestValue, loadedReports, { createdAt = new Date().toISOString() } = {}) {
  const manifest = validateMatrixManifest(manifestValue);
  const rows = BASELINE_CASES.map(item => {
    const entries = manifest.reports.map((entry, index) => ({ entry, loaded: loadedReports[index] })).filter(value => value.entry.caseId === item.id);
    const pending = reason => ({ caseId: item.id, name: item.name, status: 'pending', reasons: [reason], actualBinding: null,
      requestCount: 0, metrics: null, diagnostics: [], sourceReportDigests: [], costUSD: null, costSource: 'unknown' });
    if (!entries.length) return pending('case_not_collected');
    const reasons = [], invalid = [], diagnostics = [], digests = [], observedBindings = [];
    for (const { entry, loaded } of entries) {
      if (!loaded?.report) { reasons.push('report_unavailable'); continue; }
      const source = selectSource(loaded.report, entry);
      if (source.invalid) { invalid.push(source.invalid); continue; }
      if (source.issue) { reasons.push(source.issue); continue; }
      const actual = actualBinding(loaded.report, source.selected);
      observedBindings.push(actual);
      for (const issue of bindingIssues(manifest.binding, actual)) (issue.endsWith('_mismatch') ? invalid : reasons).push(issue);
      if (hash(loaded.digest)) digests.push(loaded.digest);
      diagnostics.push(...source.records);
    }
    const summary = summarizeDiagnostics(diagnostics, { label: item.id, candidateSha: manifest.binding.candidateSha, configurationDigest: manifest.binding.configurationDigest });
    if (summary.status === 'invalid') invalid.push('conflicting_request_identity');
    if (summary.requestCount === 0) reasons.push('diagnostics_missing');
    if (summary.groups.some(group => manifest.binding.protocol !== null && group.protocol !== manifest.binding.protocol
      || manifest.binding.model !== null && group.model !== manifest.binding.model)) invalid.push('diagnostic_model_or_protocol_mismatch');
    const group = summary.groups.length === 1 ? summary.groups[0] : null;
    const baseline = group?.baseline ?? null;
    if (summary.requests.some(request => request.phase !== 'finished' || request.requestSent === null || !request.outcome)) reasons.push('request_outcome_unknown');
    if (summary.requestCount && !summary.requests.some(request => request.requestSent === true)) reasons.push('no_confirmed_transport');
    if (summary.requests.some(request => {
      const usage = request.usage, counts = [usage?.inputTokens, usage?.nonCachedInputTokens, usage?.cacheReadInputTokens, usage?.cacheCreationInputTokens];
      return counts.every(Number.isSafeInteger) && (usage.nonCachedInputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens !== usage.inputTokens);
    })) invalid.push('input_components_inconsistent');
    if (baseline && usageMetrics.some(key => baseline[key].total !== null && !Number.isSafeInteger(baseline[key].total))) invalid.push('cumulative_count_overflow');
    if (baseline && usageMetrics.some(key => baseline[key].total === null)) reasons.push('usage_unknown');
    if (summary.requests.some(request => request.payloadBytes === null)) reasons.push('wire_measurement_unknown');
    return { caseId: item.id, name: item.name, status: invalid.length ? 'invalid' : reasons.length ? 'pending' : 'measured',
      reasons: [...new Set([...invalid, ...reasons])], actualBinding: observedBindings.length === 1 ? observedBindings[0] : observedBindings.length ? observedBindings : null,
      requestCount: summary.requestCount,
      metrics: baseline ? { peakInputTokens: baseline.peakInputTokens, peakInputTokensComplete: baseline.peakInputTokensComplete,
        ...Object.fromEntries(usageMetrics.map(key => [key, baseline[key]])) } : null,
      diagnostics: summary.requests, sourceReportDigests: [...new Set(digests)], costUSD: null, costSource: 'unknown' };
  });
  const owners = new Map();
  for (const row of rows) for (const request of row.diagnostics) {
    const key = JSON.stringify([request.runId, request.requestKey]), previous = owners.get(key);
    if (previous && previous.caseId !== row.caseId) {
      for (const target of [previous, row]) { target.status = 'invalid'; if (!target.reasons.includes('request_reused_across_cases')) target.reasons.push('request_reused_across_cases'); }
    } else owners.set(key, row);
  }
  return { version: 1, kind: 'native_context_baseline_matrix', source: 'production_diagnostics', createdAt,
    status: rows.some(row => row.status === 'invalid') ? 'invalid' : rows.every(row => row.status === 'measured') ? 'measured' : 'pending',
    binding: manifest.binding, cases: rows, coverage: { measured: rows.filter(row => row.status === 'measured').length, required: BASELINE_CASES.length },
    limitations: ['本报告只整理已存在的生产诊断，不启动付费模型。', 'fixture 和 mock 不能登记为真实模型基线。',
      '逻辑分类字节可能重叠，不相加为传输大小，也不冒称实际 token。', '失败、取消和重试作为各自请求保留；父子请求、摘要和诊断阶段不重复累计。',
      '缺失场景、来源、元数据、用量或价格保持 pending / unknown；本报告不冻结节省百分比，也不替代正式验收。'] };
}

export function compareBaselineMatrices(previous, current) {
  const invalidShape = value => !object(value) || value.kind !== 'native_context_baseline_matrix' || value.version !== 1 || value.source !== 'production_diagnostics'
    || fixtureMarked(value) || !object(value.binding)
    || !Array.isArray(value.cases) || value.cases.length !== BASELINE_CASES.length || new Set(value.cases.map(row => row?.caseId)).size !== BASELINE_CASES.length
    || value.cases.some(row => !cases.has(row?.caseId));
  if (invalidShape(previous) || invalidShape(current)) return { status: 'blocked', reasons: ['invalid_matrix'] };
  const mismatches = bindingIssues(previous.binding, current.binding);
  if (mismatches.length) return { status: 'blocked', reasons: mismatches };
  if ([previous, current].some(value => value.status === 'invalid' || value.cases.some(row => row.status === 'invalid'))) return { status: 'blocked', reasons: ['invalid_measurement'] };
  if ([previous, current].some(value => value.status !== 'measured' || value.cases.some(row => row.status !== 'measured' || row.requestCount < 1
    || !row.metrics?.peakInputTokensComplete || usageMetrics.some(key => !Number.isSafeInteger(row.metrics?.[key]?.total) || row.metrics[key].total < 0)))) return { status: 'pending', reasons: ['complete_real_baseline_required'] };
  const differences = BASELINE_CASES.map(({ id }) => {
    const before = previous.cases.find(row => row.caseId === id), after = current.cases.find(row => row.caseId === id);
    const delta = (left, right) => typeof left === 'number' && Number.isFinite(left) && typeof right === 'number' && Number.isFinite(right) ? right - left : null;
    return { caseId: id, requestCountDelta: delta(before.requestCount, after.requestCount), peakInputTokensDelta: delta(before.metrics?.peakInputTokens, after.metrics?.peakInputTokens),
      ...Object.fromEntries(usageMetrics.map(key => [`${key}Delta`, delta(before.metrics?.[key]?.total, after.metrics?.[key]?.total)])), costUSDDelta: null };
  });
  return { status: 'comparable', reasons: [], differences, limitations: ['只对同一候选、协议、模型、配置和冻结素材比较两次测量。', '数值差异不证明优化因果关系或真实账单节省，费用未知。'] };
}

async function readBoundedJson(file, maximum = 64 * 1024 * 1024) {
  const info = await stat(file);
  if (!info.isFile() || info.size > maximum) throw new Error('input_limit');
  const bytes = await readFile(file);
  return { report: JSON.parse(bytes.toString('utf8')), digest: sha256(bytes) };
}

export function parseMatrixArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.slice(2);
    if (!['--manifest', '--out', '--compare'].includes(argv[i]) || !argv[i + 1] || Object.hasOwn(options, key)) throw new Error('invalid_arguments');
    options[key] = path.resolve(argv[i + 1]);
  }
  if (!options.manifest || !options.out) throw new Error('manifest_and_output_required');
  return options;
}

export async function runBaselineMatrix({ manifest: manifestFile, out, compare }) {
  const { report: manifestValue } = await readBoundedJson(manifestFile, 1024 * 1024);
  const manifest = validateMatrixManifest(manifestValue), loaded = [];
  for (const entry of manifest.reports) {
    try { loaded.push(await readBoundedJson(path.resolve(path.dirname(manifestFile), entry.path))); }
    catch { loaded.push(null); }
  }
  const result = buildBaselineMatrix(manifest, loaded);
  if (compare) {
    let prior;
    try { prior = (await readBoundedJson(compare)).report; } catch { prior = null; }
    result.comparison = compareBaselineMatrices(prior, result);
  }
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseMatrixArguments(process.argv.slice(2)), result = await runBaselineMatrix(options);
    console.log(JSON.stringify({ reportFile: options.out, status: result.status, measured: result.coverage.measured, required: result.coverage.required, comparison: result.comparison?.status ?? null }));
    process.exitCode = result.status === 'invalid' || result.comparison?.status === 'blocked' ? 1 : result.status === 'pending' || result.comparison?.status === 'pending' ? 2 : 0;
  } catch { console.error('无法生成 Native 上下文基线矩阵：请提供有效 manifest 和未存在的输出文件。'); process.exitCode = 1; }
}
