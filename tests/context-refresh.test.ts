import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatRuntime } from '../src/main/chat-runtime';
import { ChatHistory } from '../src/main/chat-history';
import { StateStore } from '../src/main/store';
import type { Capabilities, Session } from '../src/shared/types';

const capabilities: Capabilities = { available: true, executable: '', version: 'fixture', flags: [], efforts: ['default'] };
const fixture = String.raw`
const readline = require('node:readline');
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
let alias = process.argv[3] || 'sonnet', model = process.argv[2] || 'claude-sonnet-4-6', turn = 0;
const done = () => output({type:'result',subtype:'success',result:'done',usage:{input_tokens:999999}});
readline.createInterface({input:process.stdin}).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request') {
    const request = frame.request;
    if (request.model === 'bad') { output({type:'control_response',response:{subtype:'error',request_id:frame.request_id,error:'unsupported model'}}); return; }
    if (request.subtype === 'set_permission_mode' && request.mode === 'plan') { output({type:'control_response',response:{subtype:'error',request_id:frame.request_id,error:'unsupported mode'}}); return; }
    if (request.subtype === 'set_model') { alias = request.model; model = 'api-' + alias; }
    output({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response:{commands:[{name:'context',builtin:true}]}}}); return;
  }
  if (frame.type !== 'user') return;
  const text = typeof frame.message.content === 'string' ? frame.message.content : frame.message.content[0].text;
  output({type:'system',subtype:'init',model:alias});
  if (text.startsWith('/context')) {
    output({type:'assistant',context_usage:{model:text.includes('no-model')?undefined:'Sonnet 4.6',total_tokens:30000,raw_max_tokens:200000},message:{id:'report-'+(++turn),content:[]}});
    done(); return;
  }
  const id = 'message-' + (++turn);
  const usage = text.includes('no-usage') ? undefined : text === 'real-zero' ? {input_tokens:0} : {input_tokens:2000,cache_read_input_tokens:9000,cache_creation_input_tokens:1000};
  if (text.startsWith('switch-api')) model = 'another-api-model';
  if (text === 'switch-selection') { alias = 'other-selection'; output({type:'system',subtype:'init',model:alias}); done(); return; }
  output({type:'stream_event',event:{type:'message_start',message:{id,model,usage}}});
  output({type:'assistant',message:{id,model,usage:text==='partial-usage'?{input_tokens:0}:usage,content:[{type:'text',text:'done'}]}});
  output({type:'assistant',parent_tool_use_id:'child',message:{id:'child',model:'child-model',usage:{input_tokens:800000},content:[]}});
  done();
});
process.stdin.on('end',()=>process.exit(0));
`;

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-context-refresh-'));
  const script = path.join(directory, 'cli.cjs'); fs.writeFileSync(script, fixture);
  const store = new StateStore(directory), now = new Date().toISOString();
  const session: Session = { id: randomUUID(), projectId: randomUUID(), title: 'context', kind: 'agent', cwd: directory,
    execution: { providerId: 'claude', mode: 'structured', conversationId: randomUUID() }, started: false,
    model: '', effort: 'default', permissionMode: 'default', status: 'idle', archived: false, createdAt: now, updatedAt: now };
  store.change(state => state.sessions.push(session));
  let initialModel = '', initialAlias = '';
  const runtime = new ChatRuntime(store, () => {}, () => {}, {
    invocation: () => ({ file: process.execPath, args: [script, initialModel, initialAlias] }), transcriptExists: async () => true,
  });
  return { runtime, directory, session, send: (text: string) => runtime.send(session.id, text, capabilities),
    context: () => runtime.snapshot(session.id).context,
    nextProcess: (model: string, alias = '') => { initialModel = model; initialAlias = alias; },
    cleanup: async () => { await runtime.shutdown(); store.flush(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('reported capacity survives actual request aliases, missing metadata and repeated reports without result modelUsage', async () => {
  const s = setup();
  try {
    await s.send('/context'); assert.equal(s.context()?.inputTokens, 30000);
    const reported = s.context(); await s.send('no-usage');
    assert.equal(s.context()?.requestModel, 'claude-sonnet-4-6');
    assert.equal(s.context()?.measuredAt, reported?.measuredAt); assert.equal(s.context()?.contextWindow, 200000);
    await s.send('switch-api-no-usage'); assert.equal(s.context()?.contextWindow, undefined);
    await s.send('/context');
    await s.send('normal'); assert.equal(s.context()?.inputTokens, 12000); assert.equal(s.context()?.contextWindow, 200000);
    const previous = s.context(); await s.send('no-usage'); assert.deepEqual(s.context(), previous);
    await s.send('/context'); await s.send('normal');
    assert.equal(s.context()?.contextWindow, 200000); assert.equal(s.context()?.requestModel, 'another-api-model');
    const saved = new ChatHistory(s.directory, () => false);
    assert.deepEqual(saved.get(s.session.id).context, s.context()); saved.flush();
  } finally { await s.cleanup(); }
});

test('restored contexts distinguish an actual model change from a fresh report before the first request', async () => {
  const s = setup();
  try {
    await s.send('/context'); await s.send('normal');
    await s.runtime.stopIdle(s.session.id); s.nextProcess('replacement-api');
    await s.send('no-usage');
    assert.equal(s.context()?.requestModel, 'replacement-api');
    assert.equal(s.context()?.contextWindow, undefined); assert.equal(s.context()?.inputTokens, undefined);
    await s.send('/context'); await s.send('normal');
    await s.runtime.stopIdle(s.session.id); s.nextProcess('third-api');
    await s.send('/context'); await s.send('normal');
    assert.equal(s.context()?.requestModel, 'third-api'); assert.equal(s.context()?.contextWindow, 200000);
    await s.runtime.stopIdle(s.session.id); s.nextProcess('fourth-api', 'new-selection');
    await s.send('no-usage');
    assert.equal(s.context()?.selectionModel, 'new-selection');
    assert.equal(s.context()?.contextWindow, undefined); assert.equal(s.context()?.inputTokens, undefined);
  } finally { await s.cleanup(); }
});

test('a confirmed model switch invalidates context even if a later permission change is rejected', async () => {
  const s = setup();
  try {
    await s.send('/context'); await s.send('normal');
    await assert.rejects(s.runtime.updateConfig(s.session.id, { model: 'new-model', permissionMode: 'plan' }), /unsupported mode/);
    assert.equal(s.context()?.contextWindow, undefined); assert.equal(s.context()?.inputTokens, undefined);
    await s.send('/context'); await s.send('normal');
    assert.equal(s.context()?.contextWindow, 200000);
    await s.send('switch-api-no-usage');
    assert.equal(s.context()?.contextWindow, undefined); assert.equal(s.context()?.inputTokens, undefined);
  } finally { await s.cleanup(); }
});

test('partial usage for one root message retains cache fields, while a new zero-usage request stays zero', async () => {
  const s = setup();
  try {
    await s.send('/context no-model'); await s.send('partial-usage');
    assert.equal(s.context()?.inputTokens, 10000); assert.equal(s.context()?.contextWindow, 200000);
    await s.send('real-zero'); assert.equal(s.context()?.inputTokens, 0); assert.equal(s.context()?.contextWindow, 200000);
  } finally { await s.cleanup(); }
});

test('actual API or CLI selection changes invalidate capacity and rejected live model changes preserve it', async () => {
  const s = setup();
  try {
    await s.send('/context'); await s.send('normal');
    await assert.rejects(s.runtime.updateConfig(s.session.id, { model: 'bad' }), /unsupported model/);
    assert.equal(s.context()?.contextWindow, 200000);
    await s.send('switch-api'); assert.equal(s.context()?.contextWindow, undefined);
    await s.send('/context'); await s.send('switch-selection');
    assert.equal(s.context()?.contextWindow, undefined); assert.equal(s.context()?.inputTokens, undefined);
    await s.send('/context'); await s.runtime.updateConfig(s.session.id, { model: 'new-model' });
    assert.equal(s.context()?.contextWindow, undefined); assert.equal(s.context()?.inputTokens, undefined);
    await s.send('/context'); await s.runtime.stopIdle(s.session.id);
    await s.runtime.updateConfig(s.session.id, { model: 'offline-model' });
    assert.equal(s.context()?.contextWindow, undefined);
  } finally { await s.cleanup(); }
});
