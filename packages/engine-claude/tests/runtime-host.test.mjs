import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ClaudeRuntime } from '@cc-desk/engine-claude';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const capabilities = { available: true, executable: process.execPath, version: 'fixture', flags: [], efforts: ['default'] };

/** No Electron, desktop imports, StateStore or application state shape are required. */
function setup(count = 1, { throwObservers = false, invocation } = {}) {
  const sessions = new Map(Array.from({ length: count }, () => {
    const id = randomUUID();
    return [id, { id, kind: 'agent', execution: { providerId: 'claude', mode: 'structured', conversationId: randomUUID() },
      cwd: process.cwd(), started: false, archived: false, status: 'idle', model: '', effort: 'default', permissionMode: 'default' }];
  }));
  const snapshots = new Map();
  const journal = [];
  const observers = new Set();
  let failModelWrite = false;
  let flushes = 0;
  const history = {
    get(id) {
      if (!snapshots.has(id)) snapshots.set(id, { sessionId: id, taskState: 'idle', messages: [], pending: [] });
      return snapshots.get(id);
    },
    getMessage(id, messageId) { return this.get(id).messages.find(message => message.id === messageId); },
    upsertMessage(id, message) {
      assert.ok(journal.some(item => item.id === id && (item.event.type === 'message' && item.event.message.id === message.id || item.event.type === 'text_delta' && item.event.id === message.id)), 'journal must precede the projection');
      const messages = this.get(id).messages;
      const index = messages.findIndex(item => item.id === message.id);
      if (index < 0) messages.push(message); else messages[index] = message;
    },
    append(id, event) { journal.push({ id, event: structuredClone(event) }); },
    changed() {}, flush() { flushes++; }, delete(id) { snapshots.delete(id); }, exportPath() { throw new Error('unused'); },
  };
  const host = {
    sessions: {
      get: id => sessions.get(id),
      update(id, patch) {
        if (failModelWrite && patch.model) { const error = new Error('fixture disk failure'); error.name = 'ClaudePersistenceError'; throw error; }
        Object.assign(sessions.get(id), patch);
      },
    },
    conversations: () => ({ history, archive: { page() { throw new Error('unused'); }, search() { throw new Error('unused'); }, forget() {} } }),
    subtasks: () => ({ begin() {}, observe() {}, end() {} }),
    launch: { environment: () => ({ ...process.env }), invocation() { throw new Error('fixture selects the command'); } },
    maxSessions: () => count,
    async signalProcessGroup(pid, signal) { try { process.kill(-pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } },
    onState() { if (throwObservers) throw new Error('state observer failed'); },
    onConversation() { for (const callback of [...observers]) callback(); if (throwObservers) throw new Error('conversation observer failed'); },
    onAcceptedPrompt() {},
  };
  const runtime = new ClaudeRuntime(host, {
    invocation: invocation ?? (() => ({ file: process.execPath, args: [fileURLToPath(new URL('./fixtures/claude-process.mjs', import.meta.url))] })),
    transcriptExists: async () => false,
    onEvent() { if (throwObservers) throw new Error('journal observer failed'); },
  });
  const until = condition => new Promise((resolve, reject) => {
    const check = () => { if (condition()) { clearTimeout(timer); observers.delete(check); resolve(); } };
    const timer = setTimeout(() => { observers.delete(check); reject(new Error('fixture transition did not occur')); }, 5000);
    observers.add(check); check();
  });
  return { runtime, sessions, history, journal, until, ids: [...sessions.keys()], failModelWrite: () => { failModelWrite = true; }, flushes: () => flushes };
}

test('independent runtime host isolates approvals across sessions and turns despite observer failures', async () => {
  const fixture = setup(2, { throwObservers: true });
  const { runtime, ids: [first, second], until } = fixture;
  try {
    const firstTurn = runtime.send(first, 'first', capabilities);
    const secondTurn = runtime.send(second, 'second', capabilities);
    await until(() => runtime.attention().length === 2);
    const firstRequest = runtime.snapshot(first).pending[0].requestId;
    const secondRequest = runtime.snapshot(second).pending[0].requestId;
    assert.notEqual(firstRequest, secondRequest);
    assert.notEqual(firstRequest, 'reused-wire-request');
    assert.throws(() => runtime.respond(second, firstRequest, { behavior: 'allow' }), /失效/);
    runtime.respond(first, firstRequest, { behavior: 'allow' });
    assert.equal((await firstTurn).success, true);
    assert.ok(fixture.flushes() > 0, 'turn resolution follows the host flush barrier');
    const nextTurn = runtime.send(first, 'again', capabilities);
    await until(() => runtime.snapshot(first).pending.length === 1);
    const nextRequest = runtime.snapshot(first).pending[0].requestId;
    assert.notEqual(nextRequest, firstRequest);
    assert.throws(() => runtime.respond(first, firstRequest, { behavior: 'allow' }), /失效/);
    runtime.respond(first, nextRequest, { behavior: 'allow' });
    runtime.respond(second, secondRequest, { behavior: 'deny' });
    assert.equal((await nextTurn).success, true);
    assert.equal((await secondTurn).success, false);
  } finally { await runtime.shutdown(); }
});

test('confirmed model persists across a later permission rejection; host write failure stops the runtime', async () => {
  const fixture = setup();
  const { runtime, ids: [id] } = fixture;
  try {
    await runtime.prepareCommands(id, capabilities);
    await assert.rejects(runtime.updateConfig(id, { model: 'confirmed-model', permissionMode: 'plan' }), /fixture denied/);
    assert.equal(fixture.sessions.get(id).model, 'confirmed-model');
    assert.equal(fixture.sessions.get(id).permissionMode, 'default');
    fixture.failModelWrite();
    await assert.rejects(runtime.updateConfig(id, { model: 'cannot-persist' }), /fixture disk failure/);
    assert.equal(fixture.sessions.get(id).model, 'confirmed-model');
    await assert.rejects(runtime.send(id, 'must not reuse inconsistent process', capabilities), /停止|正在启动/);
    assert.equal(runtime.snapshot(id).taskState, 'error');
  } finally { await runtime.shutdown(); }
});

test('natural CLI root exit releases inherited descendant pipes and the explicit lifetime barrier', { skip: process.platform !== 'linux', timeout: 12000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-natural-release-'));
  const childFile = path.join(directory, 'child');
  const exitFile = path.join(directory, 'exit');
  const childCode = `process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});require('node:fs').writeFileSync(${JSON.stringify(childFile)}, String(process.pid));setInterval(()=>{},1000);`;
  const rootCode = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore',1,2]});require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const frame=JSON.parse(line);process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response:{commands:[]}}})+'\\n')});setInterval(()=>{if(fs.existsSync(${JSON.stringify(exitFile)}))process.exit(0)},10);`;
  const fixture = setup(1, { invocation: () => ({ file: process.execPath, args: ['-e', rootCode] }) });
  const id = fixture.ids[0];
  let childPid = 0;
  const live = async pid => {
    const namespace = await fs.readlink('/proc/self/ns/pid');
    const depth = (await fs.readFile('/proc/self/status', 'utf8')).match(/^NSpid:\s+(.+)$/m)[1].trim().split(/\s+/).length;
    for (const entry of await fs.readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const status = await fs.readFile(`/proc/${entry}/status`, 'utf8');
        if (status.match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/).length !== depth || /^State:\s+[ZX]/m.test(status)) continue;
        if (Number(status.match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/).at(-1)) === pid && await fs.readlink(`/proc/${entry}/ns/pid`) === namespace) return true;
      } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    }
    return false;
  };
  try {
    await fixture.runtime.prepareCommands(id, capabilities);
    for (let n = 0; n < 100; n++) { try { childPid = Number(await fs.readFile(childFile, 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
    assert.ok(childPid);
    let released = false;
    const barrier = fixture.runtime.whenReleased(id).then(() => { released = true; });
    await fs.writeFile(exitFile, 'exit');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(released, false);
    assert.equal(await live(childPid), true);
    assert.equal(fixture.runtime.has(id), true);
    await barrier;
    assert.equal(await live(childPid), false);
    assert.equal(fixture.runtime.has(id), false);
    assert.equal(fixture.sessions.get(id).status, 'stopped');
    await fixture.runtime.stopAndWait(id);
  } finally {
    if (childPid && await live(childPid)) process.kill(childPid, 'SIGKILL');
    await fixture.runtime.shutdown();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('whenReleased rejects a known failed tree cleanup even while inherited streams remain open', { timeout: 8000 }, async () => {
  const fixture = setup();
  const id = fixture.ids[0];
  let failure;
  try {
    await fixture.runtime.prepareCommands(id, capabilities);
    const connection = fixture.runtime.entries.get(id).connection;
    const originalTermination = connection.termination;
    assert.equal(originalTermination, undefined, 'the fixture must have a live, unclosed connection before injecting a failed release');
    // Model the exact state of a failed tree release while close is still pending.
    connection.termination = Promise.resolve(false);
    try {
      await assert.rejects(fixture.runtime.whenReleased(id), /工作目录未释放/);
      assert.equal(fixture.runtime.has(id), true);
    } finally { connection.termination = originalTermination; }
    await fixture.runtime.stopAndWait(id);
  } catch (error) { failure = error; }
  try { await fixture.runtime.shutdown(); }
  catch (cleanup) {
    // Preserve the real release failure: a second shutdown rejection must not
    // replace it with the less specific aggregate seen in the Windows runner.
    if (failure) throw new AggregateError([failure, cleanup], `Release fixture failed: ${failure.message}; shutdown failed: ${cleanup.message}`);
    throw cleanup;
  }
  if (failure) throw failure;
});
