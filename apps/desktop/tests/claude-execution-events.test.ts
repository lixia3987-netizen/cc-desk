import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ChatRuntime } from '../src/main/chat-runtime';
import { ClaudeStructuredExecutor } from '../src/main/engines/claude/structured-executor';
import { ExecutionEvents } from '../src/main/execution/events';
import { StateStore } from '../src/main/store';
import type { Capabilities, Session } from '../src/shared/types';
import type { ChatJournalEvent } from '../src/shared/execution-events';

const fixture = String.raw`
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const session = process.argv[2];
readline.createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
  } else if (frame.type === 'user') {
    send({ type: 'system', subtype: 'init', session_id: session, model: 'fixture', permissionMode: 'default' });
    send({ type: 'stream_event', event: { type: 'message_start', message: { id: 'reply', model: 'fixture', usage: { input_tokens: 12 } } } });
    send({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } } });
    send({ type: 'control_request', request_id: 'permission-1', request: { subtype: 'can_use_tool', tool_name: 'Read', input: { file_path: 'README.md' } } });
  } else if (frame.type === 'control_response') {
    if (frame.response.request_id !== 'permission-1') throw new Error('Public approval identity was not mapped back to its wire request');
    send({ type: 'assistant', message: { id: 'reply', content: [{ type: 'text', text: 'hello' }] } });
    send({ type: 'result', subtype: 'success', result: 'hello', session_id: session, usage: { input_tokens: 12, output_tokens: 1 } });
  }
});
`;
const capabilities: Capabilities = { available: true, executable: 'fixture', version: 'fixture', flags: [], efforts: ['default'] };

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-execution-events-'));
  const store = new StateStore(directory);
  const session: Session = {
    id: randomUUID(), projectId: randomUUID(), title: 'events', kind: 'agent', cwd: directory,
    execution: { providerId: 'claude', mode: 'structured', conversationId: randomUUID() },
    started: false, engineConfig: { schemaVersion: 1, options: { model: '', effort: 'default', permissionMode: 'default' } }, status: 'idle', archived: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  store.change(state => state.sessions.push(session));
  const script = path.join(directory, 'fixture.cjs'); fs.writeFileSync(script, fixture);
  const events: ChatJournalEvent[] = [];
  const runtime = new ChatRuntime(store, () => {}, () => {}, {
    transcriptExists: async () => false, initializationTimeoutMs: 2000,
    invocation: () => ({ file: process.execPath, args: [script, session.execution.conversationId!] }),
    onEvent: (id, event) => {
      assert.equal(id, session.id);
      const journal = fs.readFileSync(path.join(directory, 'chat', id + '.jsonl'), 'utf8').trim().split('\n');
      assert.equal(JSON.parse(journal.at(-1)!).type, event.type, 'events are emitted only after durable append');
      events.push(structuredClone(event));
      if (event.type === 'message') event.message.text = 'observer mutation';
    },
  });
  return { directory, store, session, runtime, events, async cleanup() { await runtime.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('Claude structured execution emits durable normalized events without exposing protocol frames or mutable projection references', async () => {
  const s = setup();
  try {
    const turn = s.runtime.send(s.session.id, 'hello', capabilities);
    const deadline = Date.now() + 3000;
    while (!s.runtime.snapshot(s.session.id).pending.length) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for approval');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const approvalId = s.runtime.snapshot(s.session.id).pending[0].requestId;
    assert.notEqual(approvalId, 'permission-1', 'public approval identity is bound to this run');
    assert.throws(() => s.runtime.respond(s.session.id, 'permission-1', { behavior: 'allow' }), /审批已失效/);
    s.runtime.respond(s.session.id, approvalId, { behavior: 'allow' });
    assert.throws(() => s.runtime.respond(s.session.id, approvalId, { behavior: 'allow' }), /审批已失效/);
    assert.equal((await turn).success, true);
    const types = new Set(s.events.map(event => event.type));
    for (const type of ['state', 'message', 'text_delta', 'metadata', 'context', 'approval_requested', 'approval_resolved', 'result']) assert.ok(types.has(type as ChatJournalEvent['type']), type);
    assert.equal(s.runtime.snapshot(s.session.id).messages.filter(message => message.role === 'assistant').map(message => message.text).join(''), 'hello');
    assert.ok(s.events.every(event => !('request_id' in event) && !('session_id' in event) && !('parent_tool_use_id' in event)));
  } finally { await s.cleanup(); }
});

test('Claude public executor preserves local identity and rejects sessions owned by another provider', async () => {
  const s = setup();
  const events = new ExecutionEvents();
  const observed: string[] = [];
  events.subscribe(event => { if (event.type === 'journal') { assert.equal(event.identity.sessionId, s.session.id); assert.equal(event.identity.providerId, 'claude'); observed.push(event.event.type); } });
  const executor = new ClaudeStructuredExecutor(s.store, () => capabilities, events, {
    transcriptExists: async () => false, initializationTimeoutMs: 2000,
    invocation: () => ({ file: process.execPath, args: [path.join(s.directory, 'fixture.cjs'), s.session.execution.conversationId!] }),
  });
  try {
    const turn = executor.send(s.session.id, 'hello');
    const deadline = Date.now() + 3000;
    while (!executor.snapshot(s.session.id).pending.length) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for approval');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const approvalId = executor.snapshot(s.session.id).pending[0].requestId;
    assert.notEqual(approvalId, 'permission-1');
    executor.respond(s.session.id, approvalId, { behavior: 'allow' });
    assert.equal((await turn).success, true);
    assert.ok(observed.includes('result'));
    await executor.stopIdle(s.session.id);
    s.store.change(state => { state.sessions[0].execution.providerId = 'fixture-provider'; });
    assert.throws(() => executor.snapshot(s.session.id), /只支持.*Claude/);
    assert.throws(() => executor.hydrate(s.session.id), /只支持.*Claude/);
    assert.throws(() => executor.send(s.session.id, 'foreign session'), /只支持.*Claude/);
    assert.deepEqual(executor.attention(), []);
  } finally { await executor.shutdown(); await s.cleanup(); }
});

test('structured shutdown waits for an ignoring descendant after the CLI root has exited', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  const s = setup(); let childPid = 0, rootPid = 0;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const processRunning = async (pid: number) => {
    try { const result = await promisify(execFile)('ps', ['-o', 'stat=', '-p', String(pid)]); return Boolean(result.stdout.trim()) && !result.stdout.trim().startsWith('Z'); }
    catch { return false; }
  };
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!condition()) { if (Date.now() > deadline) throw new Error('Timed out waiting for process lifecycle'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  try {
    const rootFile = path.join(s.directory, 'root-pid'), childFile = path.join(s.directory, 'child-pid'), heartbeat = path.join(s.directory, 'heartbeat');
    const childCode = `const fs = require('node:fs'); process.on('SIGTERM', () => {}); process.on('SIGHUP', () => {}); fs.writeFileSync(${JSON.stringify(childFile)}, String(process.pid)); setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())), 20);`;
    const rootCode = `const fs = require('node:fs'); const {spawn} = require('node:child_process'); process.on('SIGTERM', () => process.exit(0)); fs.writeFileSync(${JSON.stringify(rootFile)}, String(process.pid)); spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {stdio:'ignore'});\n`;
    fs.writeFileSync(path.join(s.directory, 'fixture.cjs'), rootCode + fixture);
    await s.runtime.prepareCommands(s.session.id, capabilities);
    await until(() => fs.existsSync(childFile) && fs.existsSync(heartbeat));
    rootPid = Number(fs.readFileSync(rootFile, 'utf8')); childPid = Number(fs.readFileSync(childFile, 'utf8'));
    let finished = false;
    const shutdown = s.runtime.shutdown().then(() => { finished = true; });
    await until(() => !alive(rootPid));
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(await processRunning(childPid), true, 'descendant ignores graceful termination');
    assert.equal(finished, false, 'root exit must not resolve shutdown before process-group escalation');
    await shutdown;
    let running = await processRunning(childPid);
    for (let attempts = 0; running && attempts < 20; attempts++) { await new Promise(resolve => setTimeout(resolve, 10)); running = await processRunning(childPid); }
    assert.equal(running, false, 'the descendant has stopped when shutdown settles');
    assert.equal(s.runtime.activeCount, 0);
  } finally {
    for (const pid of [childPid, rootPid]) if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ } }
    await s.cleanup();
  }
});
