import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, runAgent } from '../packages/agent-core/dist/index.js';
import { createNativeModel, extractNativeAssistantText } from '../packages/agent-node/dist/native-model.js';
import { NativeRunStore } from '../packages/agent-node/dist/run-store.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const definition = { name: 'regression_probe', description: 'Read the isolated regression nonce. Call once before answering.',
  risk: 'read', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
function deadline(milliseconds, parent) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timer = setTimeout(cancel, milliseconds);
  parent.addEventListener('abort', cancel, { once: true });
  if (parent.aborted) cancel();
  return { signal: controller.signal, dispose() { clearTimeout(timer); parent.removeEventListener('abort', cancel); } };
}
function argumentsFor(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--claude-config', '--model', '--out'].includes(argv[index]) || !argv[index + 1]) throw new Error('invalid_arguments');
    result[argv[index].slice(2)] = argv[index + 1];
  }
  return result;
}
/** Uses the existing Claude connection in memory; neither tokens nor config contents enter reports. */
export async function runNativeModelRegression(options) {
  const configuration = JSON.parse(await readFile(options.claudeConfig, 'utf8'));
  const environment = configuration.env ?? {};
  const modelName = options.model ?? environment.ANTHROPIC_MODEL ?? environment[`ANTHROPIC_DEFAULT_${String(configuration.model ?? '').toUpperCase()}_MODEL`];
  const apiKey = environment.ANTHROPIC_AUTH_TOKEN ?? environment.ANTHROPIC_API_KEY;
  if (!apiKey || !environment.ANTHROPIC_BASE_URL || !modelName) throw new Error('existing_connection_unavailable');
  const rootDirectory = path.join(options.outputDirectory, 'journals');
  await mkdir(options.outputDirectory, { recursive: true });
  const reportFile = path.join(options.outputDirectory, 'report.json');
  const report = { version: 1, model: modelName, protocol: 'anthropic', startedAt: new Date().toISOString(), cases: [] };
  const transport = { protocol: 'anthropic', baseURL: environment.ANTHROPIC_BASE_URL, model: modelName,
    apiKey, authHeader: environment.ANTHROPIC_AUTH_TOKEN ? 'authorization' : 'x-api-key',
    instructions: 'Follow the regression instructions exactly. Use regression_probe only when requested. Keep the final answer short.',
    toolDefinitions: [definition], timeoutMs: 120_000 };
  const model = createNativeModel(transport);
  const nonce = randomUUID();
  let toolExecutions = 0, fetches = 0, currentCase = 'real_tool_continuation';
  const originalFetch = globalThis.fetch;
  const usageObservations = [];
  globalThis.fetch = async (...args) => {
    const request = ++fetches, response = await originalFetch(...args);
    if (!response.ok || !response.body) return response;
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '';
    const inspect = text => {
      pending += text;
      const lines = pending.split('\n'); pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try {
          const event = JSON.parse(line.slice(5));
          if (!['message_start', 'message_delta'].includes(event.type)) continue;
          const source = event.type === 'message_start' ? event.message?.usage : event.usage;
          if (!source || typeof source !== 'object') continue;
          const counters = {};
          for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'total_tokens']) {
            if (Object.hasOwn(source, key)) counters[key] = typeof source[key] === 'number' ? source[key] : source[key] === null ? null : 'non_numeric';
          }
          usageObservations.push({ request, event: event.type, counters });
        } catch { /* Raw stream data stays in memory and is never reported. */ }
      }
    };
    return new Response(new ReadableStream({
      async pull(target) {
        try { const chunk = await reader.read(); if (chunk.done) { inspect(decoder.decode()); target.close(); }
          else { inspect(decoder.decode(chunk.value, { stream: true })); target.enqueue(chunk.value); } }
        catch (error) { target.error(error); }
      }, cancel: reason => reader.cancel(reason),
    }), { status: response.status, headers: response.headers });
  };
  const countedFetch = globalThis.fetch;
  const controller = new AbortController();
  const tools = {
    definitions: [definition],
    async prepare(call, context) {
      assert.equal(call.name, definition.name);
      const input = JSON.parse(call.arguments);
      assert.deepEqual(input, {});
      return { call, definition, input, inputDigest: digest(canonicalJson(input)), policyRevision: context.policyRevision,
        requiresApproval: false, preconditions: {} };
    },
    async validate() {},
    async execute() { toolExecutions++; return { status: 'completed', output: { nonce } }; },
  };
  const host = { now: () => Date.now(), digest, deadline, emit() {} };
  const approvals = { async request() { throw new Error('unexpected_approval'); } };
  const run = async (store, identity, input) => runAgent({ identity, input, signal: controller.signal,
    configuration: { regression: true }, policyRevision: 'native-regression-v1',
    budget: { maxModelRequests: 4, maxToolCalls: 2, maxActiveMs: 180_000, maxInputTokens: 64_000, maxOutputTokens: 4096 } },
  { model, tools, store, host, approvals });
  const identityFor = conversationId => ({ sessionId: randomUUID(), conversationId, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 });
  let store;
  try {
    const conversationId = randomUUID(), identity = identityFor(conversationId);
    store = await NativeRunStore.open({ rootDirectory, conversationId, forbiddenValues: [apiKey] });
    const result = await run(store, identity, 'Call regression_probe exactly once. Read its returned nonce, then reply only with that nonce.');
    const text = extractNativeAssistantText(result.context.items);
    assert.equal(result.status, 'completed'); assert.equal(result.committed, true);
    assert.equal(toolExecutions, 1); assert.ok(result.modelRequests >= 2); assert.ok(text.includes(nonce));
    const blocks = result.context.items.flatMap(item => item && typeof item === 'object' && Array.isArray(item.content) ? item.content : []);
    report.cases.push({ name: 'real_tool_continuation', status: 'passed', modelRequests: result.modelRequests, toolCalls: result.toolCalls,
      thinkingObserved: blocks.some(block => block?.type === 'thinking' || block?.type === 'redacted_thinking') });
    currentCase = 'restart_and_receipt_replay';
    const priorContext = structuredClone(store.loadContext());
    await store.close();
    store = await NativeRunStore.open({ rootDirectory, conversationId, forbiddenValues: [apiKey] });
    assert.deepEqual(store.loadContext(), priorContext);
    const before = fetches;
    const duplicate = await run(store, identity, 'Call regression_probe exactly once. Read its returned nonce, then reply only with that nonce.');
    assert.equal(duplicate.status, 'completed'); assert.equal(fetches, before); assert.equal(toolExecutions, 1);
    const nextIdentity = { ...identity, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 2 };
    const continued = await run(store, nextIdentity, 'Using the previous tool result, reply with its nonce again. Do not call any tools.');
    assert.equal(continued.status, 'completed'); assert.ok(extractNativeAssistantText(continued.context.items).includes(nonce));
    assert.equal(toolExecutions, 1);
    report.cases.push({ name: 'restart_and_receipt_replay', status: 'passed', modelRequests: continued.modelRequests, duplicateNetworkRequests: 0 });
    await store.close(); store = undefined;

    // Cut a real service response at its first complete SSE event. Retain no upstream text in the report.
    currentCase = 'real_stream_cut_and_restart';
    globalThis.fetch = async (...args) => {
      const response = await countedFetch(...args);
      if (!response.ok || !response.body) return response;
      const reader = response.body.getReader();
      let prefix = '';
      const decoder = new TextDecoder();
      while (!/\r?\n\r?\n/.test(prefix)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        prefix += decoder.decode(chunk.value, { stream: true });
        if (prefix.length > 65_536) throw new Error('unexpected_stream_prefix');
      }
      const boundary = prefix.match(/\r?\n\r?\n/);
      const first = boundary ? prefix.slice(0, boundary.index + boundary[0].length) : prefix;
      await reader.cancel();
      return new Response(new ReadableStream({ start(target) { target.enqueue(new TextEncoder().encode(first)); target.close(); } }),
        { status: response.status, headers: response.headers });
    };
    const interruptedConversation = randomUUID(), interruptedIdentity = identityFor(interruptedConversation);
    store = await NativeRunStore.open({ rootDirectory, conversationId: interruptedConversation, forbiddenValues: [apiKey] });
    const failed = await run(store, interruptedIdentity, 'Reply with OK. Do not call tools.');
    assert.equal(failed.status, 'failed'); assert.equal(failed.reason, 'model_protocol');
    const diagnostic = store.replay(0, 1000).find(record => record.event.type === 'model_request_failed')?.event.failure;
    assert.ok(diagnostic?.reason); assert.ok(diagnostic?.stage); assert.equal(diagnostic?.protocol, 'anthropic-messages');
    await store.close();
    store = await NativeRunStore.open({ rootDirectory, conversationId: interruptedConversation, forbiddenValues: [apiKey] });
    const saved = store.replay(0, 1000).find(record => record.event.type === 'model_request_failed')?.event.failure;
    assert.deepEqual(saved, diagnostic);
    const beforeReplay = fetches;
    await run(store, interruptedIdentity, 'Reply with OK. Do not call tools.');
    assert.equal(fetches, beforeReplay);
    report.cases.push({ name: 'real_stream_cut_and_restart', status: 'passed', diagnostic, duplicateNetworkRequests: 0 });
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    // Never copy adapter/provider messages: configuration may contain credentials.
    report.failure = { case: currentCase, kind: error instanceof assert.AssertionError ? 'assertion' : 'execution', code: /^[a-z_]{1,64}$/.test(error?.code ?? '') ? error.code : 'regression_failed' };
    if (store) report.failure.diagnostic = store.replay(0, 1000).filter(record => record.event.type === 'model_request_failed').at(-1)?.event.failure;
  } finally {
    await store?.close().catch(() => {});
    globalThis.fetch = originalFetch;
    report.finishedAt = new Date().toISOString(); report.networkRequests = fetches; report.toolExecutions = toolExecutions;
    report.usageObservations = usageObservations;
    await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  return { reportFile, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = argumentsFor(process.argv.slice(2));
    if (!args.out) throw new Error('output_directory_required');
    const result = await runNativeModelRegression({ claudeConfig: args['claude-config'] ?? path.join(homedir(), '.claude', 'settings.json'),
      model: args.model, outputDirectory: path.resolve(args.out) });
    console.log(JSON.stringify({ reportFile: result.reportFile, ...result.report }));
    process.exitCode = result.report.status === 'passed' ? 0 : 1;
  } catch { console.error('Native model regression could not start; check the existing connection and a fresh output directory.'); process.exitCode = 1; }
}
