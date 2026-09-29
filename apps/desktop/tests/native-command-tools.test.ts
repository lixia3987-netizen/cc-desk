import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PreparedTool, RunIdentity, ToolExecutionContext } from '@cc-desk/agent-core';
import { LocalToolPort } from '@cc-desk/agent-node/tools';
import { loadProjectInstructions } from '@cc-desk/agent-node/project-instructions';
import type { CommandHandle, CommandRequest, CommandResult, ProcessSupervisor } from '@cc-desk/agent-node/process-supervisor';
import type { NativeCommandLifecycleEvent } from '@cc-desk/contracts/native-commands';
import { createCommandTools } from '../src/main/engines/native/command-tools';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { resolve, promise }; }
const baseResult = (): CommandResult => ({ exitCode: null, signal: null, stdout: '', stderr: '', outputBytes: 0, truncated: false, timedOut: false, cancelled: false, cleanup: 'released' });
function fakeSupervisor() {
  const children: Array<{ command: CommandRequest; signal?: AbortSignal; result: CommandResult; settled: boolean; stops: number; finish(result?: Partial<CommandResult>): void }> = [];
  const supervisor = { start(_owner: string, command: CommandRequest, signal?: AbortSignal): CommandHandle {
    const done = deferred<CommandResult>();
    const child = { command, signal, result: baseResult(), settled: false, stops: 0,
      finish(result: Partial<CommandResult> = { exitCode: 0 }) { if (child.settled) return; child.result = { ...child.result, ...result }; child.settled = true; done.resolve(structuredClone(child.result)); } };
    signal?.addEventListener('abort', () => child.finish({ cancelled: true }), { once: true });
    children.push(child);
    return { started: Promise.resolve(true), closed: done.promise,
      snapshot: () => ({ started: true, stopping: child.stops > 0, settled: child.settled, result: structuredClone(child.result) }),
      stop: async () => { child.stops++; child.finish({ cancelled: true }); return structuredClone(child.result); } };
  } } as unknown as ProcessSupervisor;
  return { supervisor, children };
}
const call = (id: string, name: string, input: unknown) => ({ id, name, arguments: JSON.stringify(input) });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t: import('node:test').TestContext, options: {
  secrets?: string[]; record?(event: NativeCommandLifecycleEvent): Promise<void>; remainingMs?: number;
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-command-tools-'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'Read instructions before commands.');
  const identity: RunIdentity = { sessionId: 'session', conversationId: 'conversation', runId: randomUUID(), requestId: 'request', workerGeneration: 1 };
  const abort = new AbortController(), process = fakeSupervisor(), events: NativeCommandLifecycleEvent[] = [];
  let owned = true, failed = false, controls = 0;
  const manager = createCommandTools({ identity, taskId: 'task', supervisor: process.supervisor, signal: abort.signal, forbiddenValues: options.secrets ?? [],
    remainingMs: () => options.remainingMs ?? 200000,
    assertOwnership: async () => { if (!owned) throw new Error('Lost ownership'); }, onFailure: () => { failed = true; abort.abort(); },
    record: async (_call, event) => { await options.record?.(event); events.push(structuredClone(event)); } });
  const local = new LocalToolPort({ projectRoot: root, supervisor: process.supervisor, ownerId: identity.runId,
    initialInstructions: await loadProjectInstructions({ projectRoot: root }),
    assertOwnership: async () => { if (!owned) throw new Error('Lost ownership'); },
    startCommand: (prepared, context, command) => manager.start(prepared, context, command) });
  const context = (): ToolExecutionContext => ({ identity, policyRevision: 'policy', signal: new AbortController().signal, maxOutputBytes: 16384 });
  const prepare = (id = 'start', input = {}) => local.prepare(call(id, 'start_command', { executable: 'program', argv: ['literal ; no shell'], cwd: '.', ...input }), context());
  const approval = (prepared: PreparedTool) => ({ decision: 'approved' as const, expiresAt: Date.now() + 60000,
    binding: { ...identity, toolCallId: prepared.call.id, inputDigest: prepared.inputDigest, policyRevision: prepared.policyRevision } });
  const start = async (id = 'start', input = {}) => { const prepared = await prepare(id, input); return local.execute(prepared, context(), approval(prepared)); };
  const control = async (name: string, input: unknown, ctx = context()) => { const prepared = await manager.prepare(call(`control-${controls++}`, name, input), ctx); return manager.execute(prepared, ctx); };
  t.after(async () => { abort.abort(); await manager.closeAll().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  return { root, identity, abort, ...process, events, manager, local, context, prepare, approval, start, control,
    setOwned(value: boolean) { owned = value; }, get failed() { return failed; } };
}

test('start requires an exact approval, is single-flight, and observes the run lifetime signal', async t => {
  const f = await fixture(t), prepared = await f.prepare(), context = f.context();
  await assert.rejects(f.local.execute(prepared, context), /approval/);
  // A failed authorization attempt cannot be retried under the same call identity.
  const approved = await f.prepare('approved');
  const [first, same] = await Promise.all([f.local.execute(approved, context, f.approval(approved)), f.local.execute(approved, context, f.approval(approved))]);
  assert.deepEqual(first, same); assert.equal(f.children.length, 1);
  assert.equal(f.children[0].signal, f.abort.signal); assert.notEqual(f.children[0].signal, context.signal);
  assert.deepEqual(f.children[0].command.argv, ['literal ; no shell']);
  assert.deepEqual(f.events.map(event => event.status), ['prepared', 'running']);
  assert.equal((first.output as any).finished, false);
  f.setOwned(false);
  await assert.rejects(f.local.execute(approved, context, f.approval(approved)), /ownership/i);
});

for (const cause of ['instructions', 'approval', 'ownership'] as const) test(`the post-intent ${cause} guard prevents launch`, async t => {
  let injected: (() => Promise<void>) | undefined;
  const f = await fixture(t, { record: async event => { if (event.status === 'prepared') await injected?.(); } });
  const prepared = await f.prepare(), approval = f.approval(prepared);
  injected = async () => {
    if (cause === 'instructions') await fs.writeFile(path.join(f.root, 'AGENTS.md'), 'Changed after intent was saved.');
    else if (cause === 'approval') approval.expiresAt = 0;
    else f.setOwned(false);
  };
  const result = await f.local.execute(prepared, f.context(), approval);
  assert.equal(result.status, 'not_executed'); assert.equal(f.children.length, 0);
  assert.deepEqual(f.events.map(event => event.status), ['prepared', 'finished']);
  assert.equal((f.events.at(-1) as any).result.cleanup, 'released'); assert.equal(f.failed, false);
});

test('active/lifetime capacity and command budgets never authorize an extra process', async t => {
  const f = await fixture(t, { remainingMs: 10000 });
  const one = await f.start('one', { timeoutMs: 180000, maxOutputBytes: 65536 }), two = await f.start('two');
  assert.equal((await f.start('third')).status, 'not_executed'); assert.equal(f.children.length, 2);
  assert.equal(f.children[0].command.timeoutMs, 10000); assert.equal(f.children[0].command.maxOutputBytes, 65536);
  await f.control('stop_command', { commandId: (one.output as any).commandId });
  await f.control('stop_command', { commandId: (two.output as any).commandId });
  for (let i = 2; i < 8; i++) { const result = await f.start(`later-${i}`); await f.control('stop_command', { commandId: (result.output as any).commandId }); }
  assert.equal((await f.start('ninth')).status, 'not_executed'); assert.equal(f.children.length, 8);
});

test('status/stop wait for durable closure; no control authorizes other runs, PIDs, stdin or restart', async t => {
  const gate = deferred<void>(); let terminalStarted = false;
  const f = await fixture(t, { record: async event => { if (event.status === 'finished') { terminalStarted = true; await gate.promise; } } });
  const launched = await f.start(), commandId = (launched.output as any).commandId;
  const prepared = await f.manager.prepare(call('status', 'command_status', { commandId }), f.context());
  await assert.rejects(f.manager.execute(prepared, { ...f.context(), identity: { ...f.identity, workerGeneration: 2 } }), /active run/);
  for (const input of [{ commandId: randomUUID() }, { commandId, pid: 123 }, { commandId, stdin: 'new command' }]) await assert.rejects(f.control('stop_command', input), /Unknown/);
  f.children[0].finish({ exitCode: 0 }); await tick(); assert.equal(terminalStarted, true);
  const beforeCommit = (await f.control('command_status', { commandId })).output as any;
  assert.equal(beforeCommit.finished, false); assert.equal(beforeCommit.state, 'running');
  let stopped = false; const stop = f.control('stop_command', { commandId }).then(result => { stopped = true; return result; });
  await tick(); assert.equal(stopped, false);
  gate.resolve(); assert.equal(((await stop).output as any).finished, true);
  await f.manager.closeAll();
  await assert.rejects(f.control('command_status', { commandId }), /active run/);
});

test('output pagination uses stable safe UTF-16 offsets and never splits an emoji', async t => {
  const f = await fixture(t), launched = await f.start(), commandId = (launched.output as any).commandId;
  f.children[0].result.stdout = '前😀后'; f.children[0].result.outputBytes = 10;
  f.children[0].finish({ exitCode: 0 }); await tick();
  const first = (await f.control('read_command_output', { commandId, stream: 'stdout', offset: 0, limit: 2 })).output as any;
  assert.equal(first.text, '前'); assert.equal(first.nextOffset, 1); assert.equal(first.hasMore, true);
  const second = (await f.control('read_command_output', { commandId, stream: 'stdout', offset: 1, limit: 2 })).output as any;
  const tooSmall = await f.control('read_command_output', { commandId, stream: 'stdout', offset: 1, limit: 1 });
  assert.equal(tooSmall.status, 'failed'); assert.equal((tooSmall.output as any).error, 'page_limit_too_small');
  assert.equal(second.text, '😀'); assert.equal(second.nextOffset, 3); assert.equal(second.currentEnd, 4);
  await assert.rejects(f.control('read_command_output', { commandId, stream: 'stdout', offset: 2 }), /surrogate/);
  await assert.rejects(f.control('read_command_output', { commandId, stream: 'stdout', offset: 5 }), /outside/);
  assert.equal(((await f.control('read_command_output', { commandId, stream: 'stdout', offset: 4 })).output as any).text, '');
});

for (const escaped of [false, true]) test(`split ${escaped ? 'JSON unicode' : 'plain'} credentials never escape live pages or terminal receipts`, async t => {
  const secret = 'sk-protected-test-secret';
  const f = await fixture(t, { secrets: [secret] }), launched = await f.start(), commandId = (launched.output as any).commandId;
  const encoded = escaped ? [...secret].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('') : secret;
  const firstChunk = 'A'.repeat(200) + encoded.slice(0, encoded.length - 3);
  f.children[0].result.stdout = firstChunk; f.children[0].result.outputBytes = Buffer.byteLength(firstChunk);
  const first = (await f.control('read_command_output', { commandId, stream: 'stdout', limit: 4096 })).output as any;
  assert.match(first.text, /^A*$/); assert.equal(first.text.includes('sk-'), false); assert.equal(first.text.includes('\\u'), false);
  f.children[0].result.stdout += encoded.slice(-3); f.children[0].result.outputBytes = Buffer.byteLength(f.children[0].result.stdout);
  await f.control('read_command_output', { commandId, stream: 'stdout', offset: first.nextOffset });
  await tick(); assert.equal(f.failed, true);
  await assert.rejects(f.manager.closeAll(), /unconfirmed/);
  const terminal = f.events.find(event => event.status === 'unknown') as Extract<NativeCommandLifecycleEvent, { status: 'finished' | 'unknown' }>;
  assert.ok(terminal); assert.equal(terminal.result.stdout, ''); assert.equal(terminal.result.stderr, ''); assert.equal(terminal.result.truncated, true);
  assert.equal(JSON.stringify(f.events).includes(secret), false); assert.equal(JSON.stringify(f.events).includes(encoded), false);
});

test('truncated terminal output retains a protected-prefix suffix and marks it incomplete', async t => {
  const f = await fixture(t, { secrets: ['sk-protected-secret'] }), launched = await f.start(), commandId = (launched.output as any).commandId;
  f.children[0].finish({ stdout: 'safe\nsk-protec', outputBytes: 20000, truncated: true, exitCode: 0 }); await tick();
  const page = (await f.control('read_command_output', { commandId, stream: 'stdout' })).output as any;
  assert.equal(page.text.includes('sk-'), false); assert.equal(page.truncated, true); assert.equal(page.finished, true);
  assert.equal(f.failed, false);
});

test('failed lifecycle persistence closes the real handle and permanently retains the recovery barrier', async t => {
  const f = await fixture(t, { record: async event => { if (event.status === 'finished') throw new Error('disk failed'); } });
  await f.start(); f.children[0].finish({ exitCode: 0 }); await tick(); await tick();
  assert.equal(f.failed, true); assert.ok(f.children[0].stops >= 1);
  await assert.rejects(f.manager.closeAll(), /unconfirmed/);
  assert.equal(f.events.at(-1)?.status, 'unknown'); assert.equal(f.children.length, 1);
});

test('start_command is not advertised without a durable host and cannot exceed explicit bounds', async t => {
  const f = await fixture(t), plain = new LocalToolPort({ projectRoot: f.root, supervisor: f.supervisor, ownerId: f.identity.runId });
  assert.equal(plain.definitions.some(definition => definition.name === 'start_command'), false);
  for (const input of [{ timeoutMs: 3600001 }, { maxOutputBytes: 65537 }, { env: {} }, { stdin: 'yes' }]) await assert.rejects(f.prepare(randomUUID(), input));
  const prepared = await f.prepare();
  const changed = structuredClone(prepared); changed.input.argv = ['changed'];
  await assert.rejects(f.local.execute(changed, f.context(), f.approval(prepared)), /changed/);
  assert.equal(f.children.length, 0);
});


test('terminal UTF-8 output cannot inflate beyond the approved aggregate byte budget', async t => {
  const f = await fixture(t), launched = await f.start('bytes', { maxOutputBytes: 256 }), commandId = (launched.output as any).commandId;
  f.children[0].finish({ stdout: '\ufffd'.repeat(256), stderr: 'also output', outputBytes: 256, exitCode: 0 }); await tick();
  const event = f.events.at(-1) as Extract<NativeCommandLifecycleEvent, { status: 'finished' | 'unknown' }>;
  assert.equal(event.status, 'finished'); assert.ok(Buffer.byteLength(event.result.stdout) + Buffer.byteLength(event.result.stderr) <= 256);
  assert.equal(event.result.truncated, true); assert.equal(((await f.control('command_status', { commandId })).output as any).truncated, true);
});


test('run cancellation remains effective after start returned and cleanup uncertainty never becomes success', async t => {
  const f = await fixture(t), launched = await f.start(), commandId = (launched.output as any).commandId;
  f.children[0].result.cleanup = 'cleanup_failed';
  f.abort.abort(); await tick();
  assert.equal(f.children[0].settled, true); assert.equal(f.children[0].result.cancelled, true);
  assert.equal(f.events.at(-1)?.status, 'unknown');
  // A later physical retry cannot rewrite the durable unknown receipt.
  f.children[0].result.cleanup = 'released';
  await assert.rejects(f.manager.closeAll(), /unconfirmed/);
  assert.equal(f.events.filter(event => event.status === 'unknown').length, 1);
  assert.equal(f.events.filter(event => event.status === 'finished').length, 0);
  assert.equal((f.events.at(-1) as any).commandId, commandId); assert.equal(f.children.length, 1);
});
