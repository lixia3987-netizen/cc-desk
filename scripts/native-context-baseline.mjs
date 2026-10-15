import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { contextBaseline, sha256 } from './native-delegation-model-regression-lib.mjs';

const usageKeys = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'nonCachedInputTokens'];
const componentKeys = ['systemPrompt', 'permissions', 'projectRules', 'skills', 'instructions', 'tools', 'userInput', 'history', 'toolResults', 'reasoning', 'continuation', 'images', 'transport'];
const counter = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,1024}$/.test(value) ? value : null;

/** 仅投影协议允许的计数/hash，不复制原始请求、文档、URL 或任意 provider 字段。 */
export function projectDiagnostic(value) {
  if (!value || value.schemaVersion !== 1 || !safeId(value.requestKey) || !['started', 'request', 'dispatched', 'finished'].includes(value.phase)) return null;
  const components = {};
  for (const key of componentKeys) if (value.components?.[key]) components[key] = { bytes: counter(value.components[key].bytes), digest: digest(value.components[key].digest), accounting: ['logical', 'serialized'].includes(value.components[key].accounting) ? value.components[key].accounting : null, count: counter(value.components[key].count) };
  return { requestKey: value.requestKey, runId: safeId(value.identity?.runId), requestId: safeId(value.identity?.requestId), parentRunId: safeId(value.parentRunId), childId: safeId(value.childId),
    attempt: counter(value.attempt), purpose: ['normal', 'child', 'retry', 'summary_in_run', 'summary_before_send', 'summary_manual'].includes(value.purpose) ? value.purpose : null,
    protocol: safeId(value.protocol?.id), model: safeId(value.model), phase: value.phase, requestSent: [true, false, null].includes(value.requestSent) ? value.requestSent : null,
    startedAt: counter(value.startedAt), finishedAt: counter(value.finishedAt), elapsedMs: Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0 ? value.elapsedMs : null,
    estimatedInputTokens: counter(value.estimatedInputTokens), estimateMethod: ['utf8_bytes', 'tokenizer', 'calibrated', 'unknown'].includes(value.estimateMethod) ? value.estimateMethod : 'unknown',
    contextBytes: counter(value.contextBytes), contextDigest: digest(value.contextDigest), payloadBytes: counter(value.payloadBytes), payloadDigest: digest(value.payloadDigest), toolsetDigest: digest(value.toolsetDigest), components,
    usage: value.usage === null || value.usage === undefined ? null : Object.fromEntries(usageKeys.map(key => [key, counter(value.usage[key])])),
    outcome: ['completed', 'failed', 'cancelled'].includes(value.outcome) ? value.outcome : null };
}

/** started/request/dispatched/finished 是同一次请求的更新；重试的不同 requestKey 独立计数。 */
export function summarizeDiagnostics(records, metadata = {}) {
  const grouped = new Map(), conflicts = [];
  for (const record of records) {
    const projected = projectDiagnostic(record.event?.type === 'model_request_diagnostic' ? record.event.diagnostic : record.diagnostic ?? record);
    if (!projected) continue;
    const key = `${projected.runId}:${projected.requestKey}`, prior = grouped.get(key);
    if (prior && (prior.attempt !== projected.attempt || prior.contextDigest !== projected.contextDigest || prior.protocol !== projected.protocol || prior.model !== projected.model)) { conflicts.push(sha256(key)); continue; }
    const rank = { started: 0, request: 1, dispatched: 2, finished: 3 };
    if (!prior || rank[projected.phase] >= rank[prior.phase]) grouped.set(key, projected);
  }
  const requests = [...grouped.values()], partitions = new Map();
  for (const request of requests) {
    const key = JSON.stringify([request.protocol, request.model]);
    const group = partitions.get(key) ?? { protocol: request.protocol, model: request.model, requests: [] }; group.requests.push(request); partitions.set(key, group);
  }
  const baselineFor = subset => contextBaseline(subset.map(request => ({ id: request.requestKey, runId: request.runId, role: request.purpose,
    requestBytes: request.payloadBytes, components: request.components, usage: request.usage, outcome: request.outcome })));
  return { version: 1, kind: 'native_context_baseline', status: conflicts.length ? 'invalid' : requests.length ? 'measured' : 'not_run', source: 'production_diagnostics',
    label: metadata.label ?? null, candidateSha: metadata.candidateSha ?? null, configurationDigest: metadata.configurationDigest ?? null, createdAt: new Date().toISOString(),
    requestCount: requests.length, conflicts, groups: [...partitions.values()].map(group => ({ protocol: group.protocol, model: group.model, baseline: baselineFor(group.requests) })), requests,
    limitations: ['Logical component byte counts overlap and must not be summed as transport bytes.', 'Protocols and models are separate baselines.', 'Dispatched/requestSent confirms transport invocation, not provider billing.', 'Missing usage and pricing are unknown; no savings target is frozen by this report.'] };
}

async function readRecords(input) {
  const info = await stat(input), records = [];
  if (info.isDirectory()) {
    for (const entry of await readdir(input, { withFileTypes: true })) {
      if (entry.isDirectory()) records.push(...await readRecords(path.join(input, entry.name)));
      else if (entry.isFile() && entry.name === 'journal.jsonl') records.push(...await readRecords(path.join(input, entry.name)));
    }
    return records;
  }
  if (path.extname(input) === '.jsonl') return (await readFile(input, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const value = JSON.parse(await readFile(input, 'utf8'));
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.cases)) return value.cases.flatMap(item => item.attempts ?? []).filter(item => item.diagnostic).map(item => item.diagnostic);
  return value.requests ?? [];
}

export async function runContextBaseline({ input, out, label, candidateSha, configurationDigest }) {
  const result = summarizeDiagnostics(await readRecords(input), { label, candidateSha, configurationDigest });
  await mkdir(path.dirname(out), { recursive: true }); await writeFile(out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = {};
    for (let i = 2; i < process.argv.length; i += 2) { if (!['--input', '--out', '--label', '--candidate-sha', '--configuration-digest'].includes(process.argv[i]) || !process.argv[i + 1]) throw new Error('invalid_arguments'); args[process.argv[i].slice(2)] = process.argv[i + 1]; }
    if (!args.input || !args.out) throw new Error('input_and_output_required');
    const result = await runContextBaseline({ input: path.resolve(args.input), out: path.resolve(args.out), label: args.label, candidateSha: args['candidate-sha'], configurationDigest: args['configuration-digest'] });
    console.log(JSON.stringify({ reportFile: path.resolve(args.out), status: result.status, requestCount: result.requestCount })); process.exitCode = result.status === 'measured' ? 0 : 1;
  } catch { console.error('Native context baseline could not be created; provide production diagnostics and a fresh output file.'); process.exitCode = 1; }
}
