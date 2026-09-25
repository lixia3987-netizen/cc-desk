import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { BrowserWindow } from 'electron';
import { z } from 'zod';
import { createClaudeConfig, parseClaudeConfig } from '@cc-desk/engine-claude/config';
import { claudeCapabilities, validateClaudeSession } from '@cc-desk/engine-claude';
import { StateStore } from '../src/main/store';
import { SessionCreation } from '../src/main/session-creation';
import { ExecutionRegistry } from '../src/main/execution/registry';
import { ClaudeStructuredExecutor } from '../src/main/engines/claude/structured-executor';
import type { ChatSnapshot, ChatTurnResult, ChatPage, ChatSearchPage } from '../src/shared/chat';
import type { Capabilities } from '../src/shared/types';
import type { ExecutionEvent } from '../src/shared/execution-events';

// Only the native file picker is substituted. The package, desktop host,
// SessionCreation, SessionService IPC, subprocess and persistence remain real.
const require = createRequire(import.meta.url);
const electronPath = require.resolve('electron');
const previousElectron = require.cache[electronPath];
let exportDestination = '';
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true,
  exports: { dialog: { showSaveDialog: async () => ({ canceled: false, filePath: exportDestination }) } },
} as NodeModule;
after(() => { if (previousElectron) require.cache[electronPath] = previousElectron; else delete require.cache[electronPath]; });

const fixtureSource = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const write = frame => process.stdout.write(JSON.stringify(frame) + '\n');
let pending;
readline.createInterface({ input: process.stdin }).on('line', line => {
  fs.appendFileSync(process.argv[2], line + '\n');
  const frame = JSON.parse(line);
  if (frame.type === 'control_request') {
    const request = frame.request;
    if (request.subtype === 'set_permission_mode' && request.mode === 'plan') {
      write({ type:'control_response', response:{ subtype:'error', request_id:frame.request_id, error:'fixture rejects plan' } }); return;
    }
    write({ type:'control_response', response:{ subtype:'success', request_id:frame.request_id, response:{commands:[]} } });
  } else if (frame.type === 'user') {
    pending = 'reused-wire-request';
    write({type:'system',subtype:'init',session_id:process.argv[3],permissionMode:'default'});
    write({type:'control_request',request_id:pending,request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'fixture-only'}}});
  } else if (frame.type === 'control_response' && frame.response.request_id === pending) {
    pending = undefined;
    write({type:'result',subtype:'success',session_id:process.argv[3],result:'persisted needle answer',is_error:frame.response.response.behavior !== 'allow'});
  }
}).on('close', () => process.exit(0));
`;
const capabilities: Capabilities = {
  available: true, executable: process.execPath, version: 'fixture', efforts: ['default', 'high'],
  flags: ['--print', '--input-format', '--output-format', '--verbose', '--permission-prompt-tool', '--resume', '--session-id'],
};

async function setup(root: string) {
  const { SessionService } = await import('../src/main/session-service');
  const projectPath = path.join(root, 'project'); fs.mkdirSync(projectPath, { recursive: true });
  const script = path.join(root, 'fixture.cjs'); fs.writeFileSync(script, fixtureSource);
  const wire = path.join(root, 'wire.jsonl');
  const store = new StateStore(path.join(root, 'data'));
  if (!store.state.projects.length) store.change(state => state.projects.push({ id: randomUUID(), path: projectPath, name: 'Engine host fixture', createdAt: new Date().toISOString() }));
  const registry = new ExecutionRegistry(id => {
    const session = store.state.sessions.find(item => item.id === id);
    if (!session) throw new Error('Missing integration session');
    return session;
  });
  const executor = new ClaudeStructuredExecutor(store, () => capabilities, registry.events, {
    invocation: session => ({ file: process.execPath, args: [script, wire, session.execution.conversationId!] }),
    transcriptExists: async () => false,
  });
  registry.register({
    providerId: 'claude', mode: 'structured', executor,
    capabilities: () => claudeCapabilities(capabilities, 'structured'), validateSession: validateClaudeSession,
    configuration: () => ({ schemaVersion: 1, defaults: createClaudeConfig(), fields: [] }),
    validateConfig: config => createClaudeConfig(parseClaudeConfig(config)),
    createIdentity: input => ({ providerId: 'claude', mode: 'structured', conversationId: input.conversationId ?? randomUUID(), imported: !!input.conversationId }),
  });
  const delivered: { channel: string; args: unknown[] }[] = [];
  const window = { webContents: { send(channel: string, ...args: unknown[]) { delivered.push({ channel, args }); } } } as unknown as BrowserWindow;
  const service = new SessionService(store, registry, () => {}, () => window, {
    history: async () => ({ entries: [], total: 0, nextOffset: null }), diagnose: async () => { throw new Error('Unused query'); },
  });
  const handlers = new Map<string, (input: unknown) => unknown>();
  service.register(<T>(name: string, schema: z.ZodType<T>, action: (data: T) => unknown) => handlers.set(name, input => action(schema.parse(input))));
  const call = async <T>(name: string, input?: unknown): Promise<T> => {
    const handler = handlers.get(name); assert.ok(handler, name + ' must be registered');
    return await handler(input) as T;
  };
  const until = (condition: () => boolean) => new Promise<void>((resolve, reject) => {
    const stop = registry.events.subscribe(() => check());
    const timer = setTimeout(() => { stop(); reject(new Error('Expected engine event did not occur')); }, 5000);
    const check = () => { if (condition()) { stop(); clearTimeout(timer); resolve(); } };
    check();
  });
  const creation = new SessionCreation(store, service, () => {}, 'claude');
  const create = () => creation.create({ projectId: store.state.projects[0].id, title: '', kind: 'agent', isolated: false, mode: 'structured', engineConfig: createClaudeConfig() });
  return { store, registry, executor, service, call, until, create, delivered, wire };
}

test('packaged Claude runs through desktop creation and IPC, then reloads durable history and exports it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdesk-engine-host-'));
  const previousConfig = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  let fixture: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    fixture = await setup(root);
    const session = await fixture.create();
    assert.notEqual(session.id, session.execution.conversationId);
    const turn = fixture.call<ChatTurnResult>('chat:send', { id: session.id, text: 'integration prompt' });
    await fixture.until(() => fixture!.executor.snapshot(session.id).pending.length === 1);
    const approval = (await fixture.call<ChatSnapshot>('chat:snapshot', session.id)).pending[0];
    assert.notEqual(approval.requestId, 'reused-wire-request');
    await fixture.call('chat:respond', { id: session.id, requestId: approval.requestId, decision: { behavior: 'allow' } });
    assert.equal((await turn).success, true);
    await assert.rejects(fixture.call('chat:respond', { id: session.id, requestId: approval.requestId, decision: { behavior: 'allow' } }), /失效/);
    assert.equal(fixture.store.state.sessions[0].started, true);
    assert.equal(fixture.store.state.sessions[0].titleSource, 'auto');
    const journalPath = path.join(fixture.store.directory, 'chat', session.id + '.jsonl');
    const journal = fs.readFileSync(journalPath, 'utf8');
    assert.ok(journal.includes('persisted needle answer'));
    assert.ok(journal.includes(approval.requestId));
    assert.ok(fs.readFileSync(fixture.wire, 'utf8').includes('reused-wire-request'));
    assert.ok(fixture.delivered.some(item => item.channel === 'chat:changed' && item.args[1] === 'waiting_approval'));
    assert.ok(fixture.delivered.filter(item => item.channel === 'execution:event').every(item => {
      const event = item.args[0] as ExecutionEvent;
      return event.type !== 'journal' || !['message', 'text_delta'].includes(event.event.type);
    }), 'IPC notifications omit full message bodies');

    await assert.rejects(fixture.call('session:update', { id: session.id, engineConfig: createClaudeConfig({ model: 'confirmed-model', permissionMode: 'plan' }) }), /fixture rejects plan/);
    assert.deepEqual(parseClaudeConfig(fixture.store.state.sessions[0].engineConfig), { model: 'confirmed-model', effort: 'default', permissionMode: 'default' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.store.directory, 'workspace.json'), 'utf8')).sessions[0].engineConfig.options.model, 'confirmed-model');
    await fixture.service.shutdown(); fixture = undefined;

    fixture = await setup(root);
    assert.equal(fixture.registry.activeCount, 0);
    assert.equal(parseClaudeConfig(fixture.store.state.sessions[0].engineConfig).model, 'confirmed-model');
    const restored = await fixture.call<ChatSnapshot>('chat:snapshot', session.id);
    assert.deepEqual(restored.pending, []);
    assert.ok(restored.messages.some(message => message.text === 'persisted needle answer'));
    const page = await fixture.call<ChatPage>('chat:page', { id: session.id });
    assert.ok(page.messages.some(message => message.text === 'persisted needle answer'));
    const search = await fixture.call<ChatSearchPage>('chat:search', { id: session.id, query: 'needle' });
    assert.ok(search.hits.length > 0);
    exportDestination = path.join(root, 'export.events.jsonl');
    assert.equal(await fixture.call('session:export', session.id), exportDestination);
    assert.equal(fs.readFileSync(exportDestination, 'utf8'), fs.readFileSync(journalPath, 'utf8'));
    assert.equal(fixture.registry.activeCount, 0, 'reading and exporting does not start a CLI');
  } finally {
    try { await fixture?.service.shutdown(); }
    finally {
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousConfig;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('a real desktop journal write failure cannot report a successful subprocess turn', async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdesk-engine-host-disk-'));
  const fixture = await setup(root);
  try {
    const session = await fixture.create();
    const turn = fixture.call<ChatTurnResult>('chat:send', { id: session.id, text: 'disk failure prompt' });
    await fixture.until(() => fixture.executor.snapshot(session.id).pending.length === 1);
    const approval = fixture.executor.snapshot(session.id).pending[0];
    const journalPath = path.join(fixture.store.directory, 'chat', session.id + '.jsonl');
    const append = fs.appendFileSync;
    const failure = context.mock.method(fs, 'appendFileSync', (...args: Parameters<typeof fs.appendFileSync>) => {
      if (String(args[0]) === journalPath) throw new Error('integration journal disk failure');
      return append(...args);
    });
    try {
      await assert.rejects(fixture.call('chat:respond', { id: session.id, requestId: approval.requestId, decision: { behavior: 'allow' } }), /integration journal disk failure/);
      const result = await turn;
      assert.equal(result.success, false);
      assert.match(result.error ?? '', /integration journal disk failure/);
      assert.equal(fixture.executor.snapshot(session.id).taskState, 'error');
    } finally { failure.mock.restore(); }
  } finally {
    try { await fixture.service.shutdown(); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
