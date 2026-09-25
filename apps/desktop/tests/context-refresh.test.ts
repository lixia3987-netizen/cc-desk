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
import type { ContextUsage } from '../src/shared/execution';

const capabilities: Capabilities = { available: true, executable: '', version: 'fixture', flags: [], efforts: ['default'] };
const fixture = String.raw`
const readline = require('node:readline');
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
let alias = process.argv[3] || 'sonnet', model = process.argv[2] || 'claude-sonnet-4-6', turn = 0;
const done = modelUsage => output({type:'result',subtype:'success',result:'done',usage:{input_tokens:999999},modelUsage});
readline.createInterface({input:process.stdin}).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request') {
    const request = frame.request;
    if (request.model === 'bad') { output({type:'control_response',response:{subtype:'error',request_id:frame.request_id,error:'unsupported model'}}); return; }
    if (request.subtype === 'set_permission_mode' && request.mode === 'plan') { output({type:'control_response',response:{subtype:'error',request_id:frame.request_id,error:'unsupported mode'}}); return; }
    if (request.subtype === 'set_model') { alias = request.model; model = 'api-' + alias; }
    output({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response:{commands:['context','compact','clear'].map(name=>({name,builtin:true}))}}}); return;
  }
  if (frame.type !== 'user') return;
  const text = typeof frame.message.content === 'string' ? frame.message.content : frame.message.content[0].text;
  if (!text.startsWith('no-init')) output({type:'system',subtype:'init',model:alias});
  if (text.startsWith('/context')) {
    output({type:'assistant',context_usage:{model:text.includes('no-model')?undefined:'Sonnet 4.6',total_tokens:30000,raw_max_tokens:200000},message:{id:'report-'+(++turn),content:[]}});
    done(); return;
  }
  if (text.startsWith('/clear')) {
    const capacity = text === '/clear capacity';
    output({type:'conversation_reset',new_conversation_id:capacity?'33333333-3333-4333-8333-333333333333':'22222222-2222-4222-8222-222222222222'});
    done(capacity ? {[alias]:{contextWindow:250000},'provider-actual-model':{contextWindow:64000},'child-model':{contextWindow:1000000}} : undefined); return;
  }
  if (text === '/compact') {
    output({type:'system',subtype:'status',status:'compacting'});
    output({type:'assistant',message:{model:'summarization-model',usage:{input_tokens:190000},content:[]}});
    output({type:'system',subtype:'compact_boundary',compact_metadata:{trigger:'manual',pre_tokens:30000}}); done(); return;
  }
  const id = 'message-' + (++turn);
  const usage = text.includes('no-usage') ? undefined : text === 'real-zero' ? {input_tokens:0} : {input_tokens:2000,cache_read_input_tokens:9000,cache_creation_input_tokens:1000};
  if (text.startsWith('switch-api')) model = 'another-api-model';
  if (text.startsWith('switch-selection')) {
    const originalAlias = alias;
    alias = 'other-selection'; output({type:'system',subtype:'init',model:alias});
    done(text.endsWith('capacity') ? {[originalAlias]:{contextWindow:250000},[alias]:{contextWindow:64000}} : undefined); return;
  }
  const routed = text.includes('routed-');
  output({type:'stream_event',event:{type:'message_start',message:{id,model:routed&&!text.startsWith('no-init')?alias:model,usage}}});
  output({type:'assistant',message:{id,model:routed?'provider-actual-model':model,usage:text==='partial-usage'?{input_tokens:0}:usage,content:[{type:'text',text:'done'}]}});
  if (text.endsWith('routed-tool-continuation')) {
    output({type:'assistant',message:{id:id+'-tool',model:'provider-tool-model',content:[{type:'tool_use',id:'tool-1',name:'Read',input:{file_path:'README.md'}}]}});
    output({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool-1',content:'file contents'}]}});
    output({type:'stream_event',event:{type:'message_start',message:{id:id+'-next',model:'provider-continuation-model',usage:{input_tokens:3000,cache_read_input_tokens:12000,cache_creation_input_tokens:1500}}}});
    output({type:'assistant',message:{id:id+'-next',model:'provider-final-model',usage:{input_tokens:3000},content:[{type:'text',text:'done'}]}});
  }
  output({type:'system',subtype:'init',parent_tool_use_id:'child',model:'child-model'});
  output({type:'stream_event',parent_tool_use_id:'child',event:{type:'message_start',message:{id:'child',model:'child-model',usage:{input_tokens:800000}}}});
  output({type:'assistant',parent_tool_use_id:'child',message:{id:'child',model:'child-model',usage:{input_tokens:800000},content:[]}});
  output({type:'result',parent_tool_use_id:'child',subtype:'success',usage:{input_tokens:800000},modelUsage:{[alias]:{contextWindow:1000000}}});
  const modelUsage = text === 'routed-capacity-conflict' ? {[alias]:{contextWindow:250000},'provider-actual-model':{contextWindow:64000},'child-model':{contextWindow:1000000}}
    : text === 'routed-capacity-only' ? {'provider-actual-model':{contextWindow:64000}}
    : text === 'routed-capacity-canonical' ? {'provider-alias':{canonicalModel:alias,contextWindow:300000},'provider-actual-model':{contextWindow:64000}}
    : undefined;
  done(modelUsage);
});
process.stdin.on('end',()=>process.exit(0));
`;

function setup(configuredModel = '', restoredContext?: ContextUsage) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-context-refresh-'));
  const script = path.join(directory, 'cli.cjs'); fs.writeFileSync(script, fixture);
  const store = new StateStore(directory), now = new Date().toISOString();
  const session: Session = { id: randomUUID(), projectId: randomUUID(), title: 'context', kind: 'agent', cwd: directory,
    execution: { providerId: 'claude', mode: 'structured', conversationId: randomUUID() }, started: false,
    engineConfig: { schemaVersion: 1, options: { model: configuredModel, effort: 'default', permissionMode: 'default' } }, status: 'idle', archived: false, createdAt: now, updatedAt: now };
  store.change(state => state.sessions.push(session));
  if (restoredContext) {
    const history = new ChatHistory(directory, () => false);
    history.append(session.id, { type: 'context', context: restoredContext }); history.flush();
  }
  let initialModel = '', initialAlias = '';
  const runtime = new ChatRuntime(store, () => {}, () => {}, {
    invocation: () => ({ file: process.execPath, args: [script, initialModel, initialAlias] }), transcriptExists: async () => true,
  });
  return { runtime, directory, session, store, send: async (text: string) => {
      const result = await runtime.send(session.id, text, capabilities); assert.equal(result.success, true, result.error); return result;
    },
    context: () => runtime.snapshot(session.id).context,
    nextProcess: (model: string, alias = '') => { initialModel = model; initialAlias = alias; },
    cleanup: async () => { await runtime.shutdown(); store.flush(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('reported capacity binds to the starting selection across routed aliases, missing metadata and repeated reports', async () => {
  const s = setup();
  try {
    await s.send('/context'); assert.equal(s.context()?.inputTokens, 30000);
    const reported = s.context(); await s.send('no-usage');
    assert.equal(s.context()?.requestModel, 'sonnet'); assert.equal(s.context()?.selectionModel, 'sonnet');
    assert.equal(s.context()?.measuredAt, reported?.measuredAt); assert.equal(s.context()?.contextWindow, 200000);
    await s.send('switch-api-no-usage'); assert.equal(s.context()?.contextWindow, 200000); assert.equal(s.context()?.inputTokens, 30000);
    await s.send('/context');
    await s.send('normal'); assert.equal(s.context()?.inputTokens, 12000); assert.equal(s.context()?.contextWindow, 200000);
    const previous = s.context(); await s.send('no-usage'); assert.deepEqual(s.context(), previous);
    await s.send('/context'); await s.send('normal');
    assert.equal(s.context()?.contextWindow, 200000); assert.equal(s.context()?.requestModel, 'sonnet');
    const saved = new ChatHistory(s.directory, () => false);
    assert.deepEqual(saved.get(s.session.id).context, s.context()); saved.flush();
  } finally { await s.cleanup(); }
});

test('restored contexts retain capacity for the same starting selection and invalidate a new process selection', async () => {
  const s = setup();
  try {
    await s.send('/context'); await s.send('normal');
    await s.runtime.stopIdle(s.session.id); s.nextProcess('replacement-api');
    await s.send('no-usage');
    assert.equal(s.context()?.requestModel, 'sonnet');
    assert.equal(s.context()?.contextWindow, 200000); assert.equal(s.context()?.inputTokens, 12000);
    await s.send('/context'); await s.send('normal');
    await s.runtime.stopIdle(s.session.id); s.nextProcess('third-api');
    await s.send('/context'); await s.send('normal');
    assert.equal(s.context()?.requestModel, 'sonnet'); assert.equal(s.context()?.contextWindow, 200000);
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
    assert.deepEqual(s.store.state.sessions[0].engineConfig.options, { model: 'new-model', effort: 'default', permissionMode: 'default' });
    assert.deepEqual(new StateStore(s.directory).state.sessions[0].engineConfig, s.store.state.sessions[0].engineConfig);
    assert.equal(s.context()?.contextWindow, undefined); assert.equal(s.context()?.inputTokens, undefined);
    await s.send('/context'); await s.send('normal');
    assert.equal(s.context()?.contextWindow, 200000);
    await s.send('switch-api-no-usage');
    assert.equal(s.context()?.requestModel, 'new-model');
    assert.equal(s.context()?.contextWindow, 200000); assert.equal(s.context()?.inputTokens, 12000);
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

test('routed models and rejected controls preserve capacity; CLI selection changes take effect on the next turn', async () => {
  const s = setup();
  try {
    await s.send('/context'); await s.send('normal');
    await assert.rejects(s.runtime.updateConfig(s.session.id, { model: 'bad' }), /unsupported model/);
    assert.equal(s.context()?.contextWindow, 200000);
    await s.send('switch-api'); assert.equal(s.context()?.contextWindow, 200000); assert.equal(s.context()?.inputTokens, 12000);
    await s.send('/context'); await s.send('switch-selection');
    assert.equal(s.context()?.contextWindow, 200000); assert.equal(s.context()?.inputTokens, 30000);
    assert.equal(s.context()?.requestModel, 'sonnet'); assert.equal(s.context()?.selectionModel, 'sonnet');
    await s.send('no-usage');
    assert.equal(s.context()?.contextWindow, undefined); assert.equal(s.context()?.inputTokens, undefined);
    assert.equal(s.context()?.requestModel, 'other-selection'); assert.equal(s.context()?.selectionModel, 'other-selection');
    await s.send('/context'); await s.runtime.updateConfig(s.session.id, { model: 'new-model' });
    assert.equal(s.context()?.contextWindow, undefined); assert.equal(s.context()?.inputTokens, undefined);
    await s.send('/context'); await s.runtime.stopIdle(s.session.id);
    await s.runtime.updateConfig(s.session.id, { model: 'offline-model' });
    assert.equal(s.context()?.contextWindow, undefined);
  } finally { await s.cleanup(); }
});

test('one starting model remains bound through streaming aliases, tool continuations and child model metadata', async () => {
  const s = setup();
  try {
    await s.send('/context'); await s.send('routed-response');
    assert.equal(s.context()?.requestModel, 'sonnet'); assert.equal(s.context()?.selectionModel, 'sonnet');
    assert.equal(s.context()?.model, 'sonnet'); assert.equal(s.context()?.inputTokens, 12000); assert.equal(s.context()?.contextWindow, 200000);
    await s.send('routed-tool-continuation');
    assert.equal(s.context()?.requestModel, 'sonnet'); assert.equal(s.context()?.selectionModel, 'sonnet');
    assert.equal(s.context()?.inputTokens, 16500); assert.equal(s.context()?.contextWindow, 200000);
    assert.equal(s.context()?.model, 'sonnet');
  } finally { await s.cleanup(); }
});

test('a confirmed model control resets a changed runtime selection even when the saved configuration is identical', async () => {
  const s = setup('sonnet');
  try {
    await s.send('/context'); await s.send('switch-selection');
    assert.equal(s.context()?.requestModel, 'sonnet'); assert.equal(s.context()?.contextWindow, 200000);
    await s.send('routed-capacity-conflict');
    assert.equal(s.session.engineConfig.options.model, 'sonnet');
    assert.equal(s.context()?.requestModel, 'other-selection'); assert.equal(s.context()?.inputTokens, 12000); assert.equal(s.context()?.contextWindow, 250000);
    await s.runtime.updateConfig(s.session.id, { model: 'sonnet' });
    assert.equal(s.context()?.inputTokens, undefined); assert.equal(s.context()?.contextWindow, undefined);
    await s.send('no-usage');
    assert.equal(s.context()?.requestModel, 'sonnet'); assert.equal(s.context()?.selectionModel, 'sonnet');
    assert.equal(s.context()?.inputTokens, undefined); assert.equal(s.context()?.contextWindow, undefined);
    await s.send('routed-capacity-conflict');
    assert.equal(s.context()?.requestModel, 'sonnet'); assert.equal(s.context()?.inputTokens, 12000); assert.equal(s.context()?.contextWindow, 250000);
  } finally { await s.cleanup(); }
});

test('result capacity uses only the starting model or its canonical entry and preserves an unmatched context report', async () => {
  const s = setup();
  try {
    await s.send('routed-capacity-only');
    assert.equal(s.context()?.inputTokens, 12000); assert.equal(s.context()?.contextWindow, undefined);
    await s.send('/context'); await s.send('routed-capacity-only');
    assert.equal(s.context()?.inputTokens, 12000); assert.equal(s.context()?.contextWindow, 200000);
    await s.send('routed-capacity-conflict');
    assert.equal(s.context()?.requestModel, 'sonnet'); assert.equal(s.context()?.inputTokens, 12000); assert.equal(s.context()?.contextWindow, 250000);
    await s.send('routed-capacity-canonical');
    assert.equal(s.context()?.requestModel, 'sonnet'); assert.equal(s.context()?.inputTokens, 12000); assert.equal(s.context()?.contextWindow, 300000);
    await s.send('switch-selection-capacity');
    assert.equal(s.context()?.requestModel, 'sonnet'); assert.equal(s.context()?.inputTokens, 12000); assert.equal(s.context()?.contextWindow, 250000);
    await s.send('no-usage');
    assert.equal(s.context()?.requestModel, 'other-selection'); assert.equal(s.context()?.inputTokens, undefined); assert.equal(s.context()?.contextWindow, undefined);
  } finally { await s.cleanup(); }
});

test('without init metadata the configured model or first root model is frozen before routed continuations', async () => {
  for (const configuredModel of ['', 'configured-model']) {
    const s = setup(configuredModel);
    try {
      await s.send('no-init-routed-tool-continuation');
      const expectedModel = configuredModel || 'claude-sonnet-4-6';
      assert.equal(s.context()?.requestModel, expectedModel); assert.equal(s.context()?.selectionModel, expectedModel);
      assert.equal(s.context()?.model, expectedModel); assert.equal(s.context()?.inputTokens, 16500);
      assert.equal(s.context()?.contextWindow, undefined);
    } finally { await s.cleanup(); }
  }
});

test('legacy persisted routed request identity migrates to its saved selection without discarding a valid measurement', async () => {
  const legacy: ContextUsage = { status: 'ready', model: 'old-provider-model', requestModel: 'old-provider-model', selectionModel: 'sonnet',
    inputTokens: 18000, contextWindow: 200000, source: 'request', measuredAt: '2026-09-24T00:00:00.000Z' };
  const s = setup('', legacy);
  try {
    await s.send('switch-api-no-usage');
    assert.equal(s.context()?.requestModel, 'sonnet'); assert.equal(s.context()?.selectionModel, 'sonnet');
    assert.equal(s.context()?.inputTokens, 18000); assert.equal(s.context()?.contextWindow, 200000); assert.equal(s.context()?.measuredAt, legacy.measuredAt);
    await s.send('routed-response');
    assert.equal(s.context()?.requestModel, 'sonnet'); assert.equal(s.context()?.inputTokens, 12000); assert.equal(s.context()?.contextWindow, 200000);
  } finally { await s.cleanup(); }
});

test('compact clears usage; clear removes the old report and accepts only newly reported capacity for the starting model', async () => {
  const s = setup();
  try {
    await s.send('/context'); await s.send('routed-response'); await s.send('/compact');
    assert.equal(s.context()?.status, 'compacted'); assert.equal(s.context()?.inputTokens, undefined);
    assert.equal(s.context()?.contextWindow, 200000); assert.equal(s.context()?.requestModel, 'sonnet');
    await s.send('routed-tool-continuation');
    assert.equal(s.context()?.inputTokens, 16500); assert.equal(s.context()?.contextWindow, 200000);
    await s.send('/clear capacity');
    assert.equal(s.context()?.inputTokens, undefined); assert.equal(s.context()?.measuredAt, undefined); assert.equal(s.context()?.contextWindow, 250000);
    await s.send('routed-capacity-only');
    assert.equal(s.context()?.requestModel, 'sonnet'); assert.equal(s.context()?.inputTokens, 12000); assert.equal(s.context()?.contextWindow, 250000);
    await s.send('/clear');
    assert.equal(s.context()?.inputTokens, undefined); assert.equal(s.context()?.contextWindow, undefined);
    await s.send('routed-capacity-only');
    assert.equal(s.context()?.requestModel, 'sonnet'); assert.equal(s.context()?.selectionModel, 'sonnet');
    assert.equal(s.context()?.inputTokens, 12000); assert.equal(s.context()?.contextWindow, undefined);
  } finally { await s.cleanup(); }
});
