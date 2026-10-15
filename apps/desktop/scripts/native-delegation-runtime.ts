import { app, utilityProcess } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { StateStore } from '../src/main/store';
import { parseClaudeModelConfig } from '../src/main/claude-model-import';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { createNativeConfig } from '../src/main/engines/native/config';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { runNativeWorker } from '../src/main/engines/native/worker-host';
// @ts-expect-error 回归报告纯函数在 Node 与 Electron 之间共享，不进入产品包。
import { assessDelegationEvidence, contextBaseline, hasThreeParallelVariants, monotonicMs, normalizeObservedUsage, regressionMaterial, regressionPrompt, safeRegressionFailureCode, sha256, workspaceHashes } from '../../../scripts/native-delegation-model-regression-lib.mjs';

type Worker = NonNullable<NativeExecutorOptions['worker']>;
type SafeRequest = { id: string; runId: string; role: string; beginMs: number; upstreamBeginMs: number | null; endMs: number | null; outcome: string; requestBytes: number; requestDigest: string; components: Record<string, number>; usage: unknown; httpStatus: number | null };
interface Options { outputDirectory: string; claudeConfig: string; model?: string; protocol: 'anthropic' | 'responses' | 'chat-completions'; attempts: number; cases: string[]; candidateSha?: string }

function upstreamEndpoint(base: string, protocol: Options['protocol']) {
  const url = new URL(base), pathname = url.pathname.replace(/\/+$/, '');
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) throw new Error('invalid_connection');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('invalid_connection');
  const suffix = protocol === 'anthropic' ? 'messages' : protocol === 'responses' ? 'responses' : 'chat/completions';
  url.pathname = pathname.endsWith(`/v1/${suffix}`) ? pathname : pathname.endsWith('/v1') ? `${pathname}/${suffix}` : `${pathname}/v1/${suffix}`;
  return url.toString();
}

/** 透明转发原始请求与 SSE；仅观察长度、hash、时间与允许的计数字段。 */
async function observedTransport(endpoint: string, protocol: Options['protocol'], workers: Map<string, any>, network: SafeRequest[], onChildRequest: () => void) {
  const controllers = new Set<AbortController>();
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const match = request.url?.match(/^\/worker\/([a-zA-Z0-9-]+)\//), runId = match?.[1] ?? 'unknown';
    const worker = workers.get(runId), observation: SafeRequest = { id: randomUUID(), runId, role: worker?.role ?? 'unknown', beginMs: monotonicMs(), upstreamBeginMs: null, endMs: null, outcome: 'pending', requestBytes: 0, requestDigest: '', components: {}, usage: null, httpStatus: null };
    network.push(observation);
    const controller = new AbortController(); controllers.add(controller);
    const closed = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', closed);
    const rawUsage: Record<string, unknown> = {};
    let pending = '';
    const inspect = (text: string) => {
      pending += text;
      const lines = pending.split('\n'); pending = lines.pop() ?? '';
      if (pending.length > 1_048_576) pending = '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try {
          const event = JSON.parse(line.slice(5)), usage = event.message?.usage ?? event.response?.usage ?? event.usage;
          if (!usage || typeof usage !== 'object') continue;
          for (const key of ['input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'total_tokens']) {
            if (Object.hasOwn(usage, key)) rawUsage[key] = Number.isSafeInteger(usage[key]) && usage[key] >= 0 ? usage[key] : null;
          }
          for (const key of ['input_tokens_details', 'prompt_tokens_details']) if (usage[key] && typeof usage[key] === 'object') {
            const counters = { ...((rawUsage[key] && typeof rawUsage[key] === 'object') ? rawUsage[key] as Record<string, unknown> : {}) };
            for (const counter of ['cached_tokens', 'cache_write_tokens']) if (Object.hasOwn(usage[key], counter)) counters[counter] = Number.isSafeInteger(usage[key][counter]) && usage[key][counter] >= 0 ? usage[key][counter] : null;
            if (Object.keys(counters).length) rawUsage[key] = counters;
          }
          observation.usage = normalizeObservedUsage(protocol, rawUsage);
        } catch { /* 原始事件仅在内存中检查，不保存模型文本或凭据。 */ }
      }
    };
    try {
      if (!worker || request.method !== 'POST') { response.writeHead(404); response.end(); observation.outcome = 'rejected_route'; return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) { chunks.push(Buffer.from(chunk)); if (chunks.reduce((sum, item) => sum + item.byteLength, 0) > 32 * 1024 * 1024) throw new Error('request_limit'); }
      const body = Buffer.concat(chunks); observation.requestBytes = body.byteLength; observation.requestDigest = sha256(body);
      const parsed = JSON.parse(body.toString('utf8'));
      const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value ?? null));
      observation.components = { instructions: bytes(parsed.system ?? parsed.instructions), tools: bytes(parsed.tools), contextItems: bytes(parsed.messages ?? parsed.input), envelope: body.byteLength };
      if (parsed.tool_choice && !['auto', 'none'].includes(parsed.tool_choice.type ?? parsed.tool_choice)) worker.forcedToolChoiceObserved = true;
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) if (value && !['host', 'connection', 'content-length', 'transfer-encoding'].includes(name)) headers.set(name, Array.isArray(value) ? value.join(',') : value);
      observation.upstreamBeginMs = monotonicMs();
      const upstreamRequest = fetch(endpoint, { method: 'POST', body, headers, signal: controller.signal, redirect: 'error' });
      if (worker.role === 'child') onChildRequest();
      const upstream = await upstreamRequest;
      observation.httpStatus = upstream.status;
      response.writeHead(upstream.status, Object.fromEntries([...upstream.headers.entries()].filter(([name]) => !['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(name))));
      if (upstream.body) {
        const decoder = new TextDecoder();
        for await (const chunk of upstream.body as any) { inspect(decoder.decode(chunk, { stream: true })); response.write(Buffer.from(chunk)); }
        inspect(decoder.decode() + '\n');
      }
      response.end(); observation.outcome = upstream.ok ? 'completed' : 'http_error';
    } catch { observation.outcome = controller.signal.aborted ? 'cancelled' : 'connection_failed'; if (!response.headersSent) response.writeHead(502); response.end(); }
    finally { observation.endMs = monotonicMs(); controllers.delete(controller); response.off('close', closed); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('transport_unavailable');
  return { origin: `http://127.0.0.1:${address.port}`, close: async () => { for (const controller of controllers) controller.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

async function readReceipts(directory: string): Promise<any[]> {
  const result: any[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await readReceipts(file));
    else if (entry.name === 'receipt.json') {
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (value.version === 1 && value.parentIdentity && value.childId) result.push(value);
    }
  }
  return result;
}

async function executeCase(options: Options, connection: { apiKey: string; model: string; authHeader: 'authorization' | 'x-api-key'; endpoint: string }, mode: string, attempt: number) {
  const caseId = `${mode}-${attempt}-${randomUUID()}`, caseRoot = path.join(options.outputDirectory, 'private-evidence', caseId), cwd = path.join(caseRoot, 'project'), data = path.join(caseRoot, 'data');
  await fs.mkdir(cwd, { recursive: true });
  const material = regressionMaterial();
  for (const [file, text] of Object.entries(material.files)) await fs.writeFile(path.join(cwd, file), text as string, { flag: 'wx' });
  const beforeHashes = await workspaceHashes(cwd), workers = new Map<string, any>(), network: SafeRequest[] = [];
  let executor: NativeStructuredExecutor | undefined, sessionId: string | undefined, cancelRequestedMs: number | null = null, cancellation: Promise<void> | undefined;
  const cancelIfOverlapping = () => {
    if (mode !== 'cancel' || cancellation || !executor || !sessionId) return;
    if (new Set(network.filter(request => request.role === 'child' && request.endMs === null).map(request => request.runId)).size >= 2) {
      cancelRequestedMs = monotonicMs(); cancellation = executor.stopAndWait(sessionId);
    }
  };
  const transport = await observedTransport(connection.endpoint, options.protocol, workers, network, cancelIfOverlapping), store = new StateStore(data), connections = new ConnectionStore(data);
  const created = connections.import({ name: 'Real model regression', protocol: options.protocol, authHeader: connection.authHeader, baseURL: transport.origin, model: connection.model, allowLoopbackHttp: true, enabled: true, auth: { mode: 'memory' } }, { mode: 'memory', secret: connection.apiKey });
  const projectId = randomUUID(), now = new Date().toISOString(), conversationId = randomUUID(); sessionId = randomUUID();
  store.change(state => {
    state.projects.push({ id: projectId, path: cwd, name: 'Read-only regression materials', createdAt: now });
    state.sessions.push({ id: sessionId!, projectId, title: 'Real delegation regression', kind: 'agent', cwd, execution: { providerId: 'native', mode: 'structured', conversationId },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: created.id, maxModelRequests: 40, maxToolCalls: 80, maxActiveMs: 240000, maxInputTokens: 128000, maxOutputTokens: 4096, autoCompact: 'off', modelRetry: 'off', mcpConnections: [] } }),
      started: false, status: 'idle', archived: false, createdAt: now, updatedAt: now });
  });
  const worker: Worker = async supplied => {
    const runId = supplied.request.identity.runId, config = supplied.request.configuration;
    const observation = { workerId: randomUUID(), runId, identity: structuredClone(supplied.request.identity), role: config.delegated ? 'child' : 'parent', childId: null,
      beginMs: monotonicMs(), endMs: null, pid: null, exitCode: null, result: undefined as any, records: [] as any[],
      promptDigest: sha256(supplied.model.instructions ?? ''), promptBytes: Buffer.byteLength(supplied.model.instructions ?? ''), toolsetDigest: sha256(supplied.tools.definitions), toolNames: supplied.tools.definitions.map(tool => tool.name),
      readOnly: config.toolPolicy === 'read_only' || (config.nativeExecutionPolicy as any)?.toolPolicy === 'read_only', forcedToolChoiceObserved: false,
      lifecycle: { invoked: true, forkCalled: false, spawned: false, exited: false, resultObserved: false }, failureCode: null as string | null,
      workerPathIsProductionBundle: path.resolve(supplied.workerPath ?? path.join(__dirname, '../native/worker.cjs')) === path.resolve(options.outputDirectory, 'runtime/native/worker.cjs') };
    workers.set(runId, observation);
    const durable = supplied.store;
    try {
      const result = await runNativeWorker({ ...supplied, model: { ...supplied.model, baseURL: `${transport.origin}/worker/${runId}` }, store: {
        beginRun: request => durable.beginRun(request), ensureCapacity: (id, bytes) => durable.ensureCapacity(id, bytes), checkpoint: (id, context) => durable.checkpoint(id, context),
        append: async (id, event) => { const committed = await durable.append(id, event); observation.records.push({ identity: structuredClone(id), event: structuredClone(event), monotonicMs: monotonicMs() }); return committed; },
      }, fork: (file, args, forkOptions) => {
        // 只观察生产 utilityProcess，绝不替代模型、工具调用或子执行器。
        observation.lifecycle.forkCalled = true;
        const child = utilityProcess.fork(file, args, forkOptions);
        child.once('spawn', () => { observation.pid = child.pid ?? null; observation.lifecycle.spawned = true; });
        child.once('exit', code => { observation.exitCode = code; observation.lifecycle.exited = true; });
        return child;
      } });
      observation.result = result; observation.lifecycle.resultObserved = true;
      if (result.status !== 'completed') observation.failureCode = safeRegressionFailureCode(result.reason);
      return result;
    } catch (error) { observation.failureCode = safeRegressionFailureCode(error, 'worker_execution_failed'); throw error;
    } finally { observation.endMs = monotonicMs(); }
  };
  const beganMs = monotonicMs();
  let shutdownConfirmed = false, sendSucceeded = false, executionReason: string | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let executionPhase = 'initialize', sendResultObserved = false, sendFailureCode: string | null = null, shutdownFailureCode: string | null = null, hostRecoveryRequired: boolean | null = null;
  const hostErrors: string[] = [];
  // 产品错误只映射成固定机器码；真实错误正文保持在内存，不写报告。
  executor = new NativeStructuredExecutor(store, connections, new ExecutionEvents(), { worker, onError: error => hostErrors.push(safeRegressionFailureCode(error, 'host_metadata_error')) });
  try {
    await executor.initialize();
    executionPhase = 'send';
    if (mode === 'cancel') timer = setTimeout(() => { if (!cancellation && executor && sessionId) { cancelRequestedMs = monotonicMs(); cancellation = executor.stopAndWait(sessionId); } }, 30000);
    const result = await executor.send(sessionId, regressionPrompt(mode, attempt), [], undefined, { requestId: randomUUID(), source: 'direct', nativeExecutionPolicy: { toolPolicy: 'read_only' } });
    sendSucceeded = result.success; sendResultObserved = true;
    if (!result.success) {
      const parent = [...workers.values()].find(value => value.role === 'parent');
      sendFailureCode = safeRegressionFailureCode(parent?.result?.reason ?? parent?.failureCode, parent ? 'executor_failed_after_worker' : 'executor_rejected_before_worker');
      if (typeof result.error === 'string' && result.error.startsWith('并行分析要求未满足')) sendFailureCode = 'delegation_audit_unmet';
    }
  } catch (error) { executionReason = 'execution_failed'; sendFailureCode = safeRegressionFailureCode(error, `${executionPhase}_failed`); }
  finally {
    if (timer) clearTimeout(timer);
    await cancellation?.catch(() => {});
    executionPhase = 'shutdown';
    try { await executor.shutdown(); hostRecoveryRequired = executor.recoveryRequired(sessionId); shutdownConfirmed = executor.activeCount === 0 && !hostRecoveryRequired; }
    catch (error) { executionReason = 'cleanup_unconfirmed'; shutdownFailureCode = safeRegressionFailureCode(error, 'shutdown_failed'); }
    await transport.close(); store.flush();
  }
  const afterHashes = await workspaceHashes(cwd), receipts = await readReceipts(path.join(data, 'native', 'delegations'));
  for (const receipt of receipts) { const observation = workers.get(receipt.identity.runId); if (observation) observation.childId = receipt.childId; }
  const observations = [...workers.values()], parent = observations.find(value => value.role === 'parent') ?? { runId: '', records: [], result: undefined };
  const children = receipts.map(receipt => ({ childId: receipt.childId, parentRunId: receipt.parentIdentity.runId, ...(workers.get(receipt.identity.runId) ?? {}), result: workers.get(receipt.identity.runId)?.result }));
  const physicalCleanup = shutdownConfirmed && observations.every(value => value.endMs !== null && value.exitCode !== null) && network.every(value => value.endMs !== null);
  const evidence = assessDelegationEvidence({ source: 'real_model', mode, parent, children, workers: observations, network, expected: material.values, beforeHashes, afterHashes, cleanupConfirmed: physicalCleanup });
  if (observations.some(value => value.forcedToolChoiceObserved)) { evidence.checks.noForcedToolChoice = false; evidence.status = 'failed'; }
  const attempts = observations.flatMap(value => value.records.filter((record: any) => ['model_request_started', 'model_request_failed', 'model_response', 'model_request_diagnostic'].includes(record.event.type)).map((record: any) => ({ runId: value.runId, role: value.role, monotonicMs: record.monotonicMs,
    type: record.event.type, attempt: record.event.attempt ?? null, failure: record.event.failure ?? null, usage: record.event.response?.usage ?? null,
    ...(record.event.diagnostic ? { diagnostic: record.event.diagnostic } : {}) })));
  return { caseId, mode, attempt, source: 'real_model', status: evidence.status, beganMs, endedMs: monotonicMs(), sendSucceeded, executionReason, cancelRequestedMs,
    execution: { phase: executionPhase, sendResultObserved, failureCode: sendFailureCode, shutdownFailureCode, hostErrors, workerInvocations: observations.length, physicalWorkersSpawned: observations.filter(value => value.lifecycle.spawned).length, modelRequestsStarted: attempts.filter(value => value.type === 'model_request_started').length, transportInvocations: network.filter(value => value.upstreamBeginMs !== null).length, hostRecoveryRequired },
    promptVariant: mode === 'parallel' ? (attempt - 1) % 3 + 1 : 1, inputDigest: sha256(regressionPrompt(mode, attempt)), materialHashes: beforeHashes, evidence, network, baseline: contextBaseline(network), attempts,
    workers: observations.map(({ records: _records, result, ...value }) => ({ ...value, terminal: result ? { status: result.status, committed: result.committed, reason: result.reason, modelRequests: result.modelRequests, toolCalls: result.toolCalls, usage: result.usage } : null })),
    childReceipts: receipts.map(receipt => ({ childId: receipt.childId, batchId: receipt.batchId, identity: receipt.identity, parentIdentity: receipt.parentIdentity, status: receipt.status, mode: receipt.mode, committed: receipt.result?.committed ?? null })) };
}

async function main() {
  const options = JSON.parse(await fs.readFile(process.argv[2], 'utf8')) as Options, reportFile = path.join(options.outputDirectory, 'report.json');
  const report: any = { version: 1, source: 'real_model', status: 'not_run', releaseGate: 'not_run', startedAt: new Date().toISOString(), cases: [], protocol: options.protocol,
    candidateSha: options.candidateSha ?? null, limitations: ['Private production journals are retained locally; this report contains no document, model output, request headers or credential values.', 'Provider usage/pricing may be unavailable. Human acceptance is not implied.'] };
  try {
    if (!report.candidateSha) { try { report.candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { report.candidateSha = null; } }
    const sourceFiles = {};
    for (const directory of ['packages/agent-core/src', 'packages/agent-node/src', 'apps/desktop/src', 'scripts']) Object.assign(sourceFiles, Object.fromEntries(Object.entries(await workspaceHashes(path.resolve(directory))).map(([file, hash]) => [`${directory}/${file}`, hash])));
    report.candidateSourceDigest = sha256(sourceFiles);
    report.runtimeBundleDigest = sha256(await fs.readFile(__filename));
    report.workerBundleDigest = sha256(await fs.readFile(path.join(__dirname, '../native/worker.cjs')));
    let configuration: any;
    try { configuration = JSON.parse(await fs.readFile(options.claudeConfig, 'utf8')); } catch { report.reason = 'no_config'; return; }
    const source = options.model ? { ...configuration, env: { ...configuration.env, ANTHROPIC_MODEL: options.model } } : configuration;
    const parsed = parseClaudeModelConfig(source, options.claudeConfig), apiKey = parsed.secret, model = parsed.preview.model;
    if (!apiKey || !model) { report.reason = 'no_config'; return; }
    const endpoint = upstreamEndpoint(parsed.preview.baseURL, options.protocol);
    report.model = model; report.modelSelection = { source: options.model ? 'explicit_argument' : parsed.preview.modelSource ?? 'existing_configuration', nativeImportable: parsed.preview.models.find(value => value.model === model)?.nativeImportable ?? null, preservedConfiguredLabel: !options.model };
    report.connectionOriginDigest = sha256(new URL(endpoint).origin); report.configuration = { maxModelRequests: 40, maxToolCalls: 80, maxActiveMs: 240000, maxInputTokens: 128000, maxOutputTokens: 4096, autoCompact: 'off', modelRetry: 'off', toolPolicy: 'read_only', mcpConnections: [] };
    for (const mode of options.cases) for (let attempt = 1; attempt <= (mode === 'parallel' ? options.attempts : 1); attempt++) {
      try { report.cases.push(await executeCase(options, { apiKey, model, authHeader: parsed.authHeader, endpoint }, mode, attempt)); }
      catch (error) { report.cases.push({ mode, attempt, source: 'real_model', status: 'failed', reason: 'runtime_case_failed', execution: { failureCode: safeRegressionFailureCode(error, 'case_setup_failed') } }); }
      // 每一次失败与重试均写入同一报告，不能只保留最后一次成功。
      await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    }
    report.status = report.cases.length && report.cases.every((value: any) => value.status === 'passed') ? 'passed' : 'failed';
    report.parallelVariantsObserved = hasThreeParallelVariants(report.cases);
    const complete = report.parallelVariantsObserved && /^[a-f0-9]{40}$/.test(report.candidateSha ?? '') && ['parallel', 'question', 'single', 'injection', 'missing', 'cancel'].every(mode => options.cases.includes(mode));
    report.releaseGate = complete ? report.status : 'not_run';
    if (!report.candidateSha) report.reason = 'candidate_revision_unavailable';
    if (report.cases.some((value: any) => value.network?.some((request: any) => request.outcome === 'connection_failed'))) report.reason = 'connection_failed';
    report.baseline = contextBaseline(report.cases.flatMap((value: any) => value.network ?? []));
  } catch (error) { report.reason = 'runtime_unavailable'; report.failureCode = safeRegressionFailureCode(error, 'runtime_setup_failed'); }
  finally { report.finishedAt = new Date().toISOString(); await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); app.exit(report.status === 'passed' ? 0 : 1); }
}

app.whenReady().then(main).catch(() => app.exit(1));
