import { createHash } from 'node:crypto';
import { runAgent, type AgentEvent, type AgentPorts, type RunIdentity } from '@cc-desk/agent-core';
import { ResponsesModel } from '@cc-desk/agent-node/responses-model';
import { checkedMessage, MAX_WORKER_MESSAGE_BYTES, MAX_WORKER_PENDING, sameRun, WORKER_PROTOCOL, type WorkerReply, type WorkerStart } from './worker-protocol';

const port = process.parentPort;
if (!port) throw new Error('Native worker requires an Electron utilityProcess parent.');
// Worker transport contains credentials. Disable diagnostic reports that could include them.
process.report.reportOnFatalError = false;
process.report.reportOnSignal = false;
process.report.reportOnUncaughtException = false;
const abort = new AbortController();
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; dispose(): void }>();
let identity: RunIdentity | undefined, sequence = 0, replySequence = 0, started = false, completed = false;
let eventChain: Promise<unknown> = Promise.resolve(), eventBytes = 0;
function fail(error: unknown) {
  abort.abort();
  for (const item of pending.values()) { item.dispose(); item.reject(new Error('Native worker host disconnected.')); }
  pending.clear();
  // Do not transmit arbitrary errors, headers, environment or model credentials.
  port.postMessage({ type: 'fatal', version: WORKER_PROTOCOL, identity, seq: ++sequence, message: error instanceof Error && error.message === 'Native event backlog exceeded.' ? error.message : 'Native worker execution failed.' });
  process.exit(1);
}
function rpc<T>(method: string, args: unknown, signal?: AbortSignal): Promise<T> {
  if (!identity || pending.size >= MAX_WORKER_PENDING) return Promise.reject(new Error('Native worker request limit exceeded.'));
  const seq = ++sequence, requestId = `${identity.runId}:${seq}`;
  const message = { type: 'request', version: WORKER_PROTOCOL, identity, seq, requestId, method, args };
  checkedMessage(message);
  return new Promise<T>((resolve, reject) => {
    const cancel = () => port.postMessage({ type: 'rpc_cancel', version: WORKER_PROTOCOL, identity, seq: ++sequence, requestId });
    const dispose = () => signal?.removeEventListener('abort', cancel);
    pending.set(requestId, { resolve: value => resolve(value as T), reject, dispose });
    try {
      port.postMessage(message);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
    } catch (error) { dispose(); pending.delete(requestId); reject(error); }
  });
}
function emit(event: AgentEvent): Promise<void> {
  const bytes = Buffer.byteLength(JSON.stringify(event));
  eventBytes += bytes;
  if (eventBytes > MAX_WORKER_MESSAGE_BYTES) { abort.abort(); return Promise.reject(new Error('Native event backlog exceeded.')); }
  const next = eventChain.then(() => rpc<void>('event', event));
  eventChain = next.finally(() => { eventBytes -= bytes; });
  void eventChain.catch(() => { abort.abort(); });
  return next;
}
async function start(message: WorkerStart) {
  identity = message.request.identity;
  const context = <T extends { signal: AbortSignal }>(value: T) => { const { signal: _signal, ...rest } = value; return rest; };
  const ports: AgentPorts = {
    model: new ResponsesModel(message.model),
    tools: {
      definitions: message.definitions,
      prepare: (call, execution) => rpc('tools.prepare', { call, context: context(execution) }, execution.signal),
      validate: (prepared, execution) => rpc('tools.validate', { prepared, context: context(execution) }, execution.signal),
      execute: (prepared, execution, approval) => rpc('tools.execute', { prepared, context: context(execution), approval }, execution.signal),
    },
    store: {
      beginRun: request => rpc('store.beginRun', request),
      append: async (run, event) => {
        // Drain this response's streaming RPCs before its authoritative UI replacement.
        if (event.type === 'model_response') await eventChain;
        return rpc('store.append', { identity: run, event });
      },
      ensureCapacity: (run, bytes) => rpc('store.ensureCapacity', { identity: run, bytes }),
      checkpoint: (run, saved) => rpc('store.checkpoint', { identity: run, context: saved }),
    },
    approvals: { request: (request, signal) => rpc('approval', request, signal) },
    host: {
      now: () => Date.now(),
      digest: value => createHash('sha256').update(value).digest('hex'),
      deadline: (milliseconds, parent) => {
        const controller = new AbortController();
        const cancel = () => controller.abort(parent.reason);
        const timer = setTimeout(() => controller.abort(new Error('Native deadline exceeded.')), milliseconds);
        parent.addEventListener('abort', cancel, { once: true });
        if (parent.aborted) cancel();
        return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent.removeEventListener('abort', cancel); } };
      },
      emit,
    },
  };
  const result = await runAgent({ ...message.request, signal: abort.signal }, ports);
  await eventChain;
  completed = true;
  port.postMessage({ type: 'done', version: WORKER_PROTOCOL, identity, seq: ++sequence, result });
  // Exit only after the host acknowledges the final result; host still owns all tools.
}
port.on('message', event => {
  try {
    const message = checkedMessage(event.data);
    if (message.version !== WORKER_PROTOCOL) throw new Error('Native worker protocol version mismatch.');
    if (message.type === 'start') {
      if (started) throw new Error('Native worker already started.');
      started = true;
      void start(message as unknown as WorkerStart).catch(fail);
      return;
    }
    if (!identity || !message.identity || !sameRun(message.identity as RunIdentity, identity)) throw new Error('Native worker identity mismatch.');
    if (message.type === 'cancel') { abort.abort(); return; }
    if (message.type === 'finish' && completed) { process.exit(0); }
    if (message.type !== 'reply') throw new Error('Unexpected native worker message.');
    const reply = message as unknown as WorkerReply;
    if (!Number.isSafeInteger(reply.seq) || reply.seq <= replySequence) throw new Error('Stale native host reply.');
    replySequence = reply.seq;
    const item = pending.get(reply.requestId);
    if (!item) throw new Error('Unknown native worker reply.');
    pending.delete(reply.requestId);
    item.dispose();
    if (reply.error) item.reject(new Error(reply.error)); else item.resolve(reply.value);
  } catch (error) { fail(error); }
});
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
port.postMessage({ type: 'ready', version: WORKER_PROTOCOL, pid: process.pid });
