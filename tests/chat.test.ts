import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatRuntime } from '../src/main/chat-runtime';
import { ChatHistory } from '../src/main/chat-history';
import { readTranscriptPreview } from '../src/main/chat-import';
import { chatArguments, JsonLineDecoder, userContent } from '../src/main/chat-protocol';
import { StateStore } from '../src/main/store';
import type { Capabilities, Session } from '../src/shared/types';

const capabilities: Capabilities = { available: true, executable: 'claude', version: 'fixture', flags: ['--session-id', '--resume', '--fork-session', '--permission-mode', '--model', '--effort', '--print', '--input-format', '--output-format', '--verbose', '--permission-prompt-tool', '--include-partial-messages'], efforts: ['default', 'high', 'max'] };
const until = async (condition: () => boolean, timeout = 4000) => {
  const end = Date.now() + timeout;
  while (!condition()) { if (Date.now() > end) throw new Error('Timed out waiting for subprocess event'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
// A real subprocess implementing the wire contract from the official Python SDK.
// This validates transport/lifecycle behavior; it does NOT authenticate to a model.
const fixture = String.raw`
const readline = require('node:readline');
const fs = require('node:fs');
const session = process.argv[2];
let permissionMode = process.argv[5] || 'default';
const bypassEnabled = permissionMode === 'bypassPermissions';
const output = value => process.stdout.write(JSON.stringify(value)+'\n');
let turn=0;let pending;let current='';
const done = text => { output({type:'assistant',message:{id:'msg-'+turn,content:[{type:'text',text}]}}); output({type:'result',subtype:'success',is_error:false,result:text,session_id:session,usage:{input_tokens:12,output_tokens:3},duration_ms:42,total_cost_usd:0.001,num_turns:1}); };
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(process.argv[3],line+'\n');
 if(m.type==='control_request'){
  const r=m.request;
  if(r.subtype==='initialize'&&process.argv[4]==='fail-init'){output({type:'control_response',response:{subtype:'error',request_id:m.request_id,error:'initialize failed'}});return;}
  if(r.model==='no-ack')return;
  if(r.subtype==='set_permission_mode'){
   if(r.mode==='bypassPermissions'&&!bypassEnabled){output({type:'control_response',response:{subtype:'error',request_id:m.request_id,error:'bypass was not enabled at launch'}});return;}
   permissionMode=r.mode;
  }
  output({type:'control_response',response:r.model==='bad'?{subtype:'error',request_id:m.request_id,error:'unknown model'}:{subtype:'success',request_id:m.request_id,response:{}}});
  if(r.subtype==='interrupt'){if(pending)output({type:'control_cancel_request',request_id:pending.id});pending=undefined;done('interrupted');}
  return;
 }
 if(m.type==='user'){
  ++turn;current=m.message.content[0].text;
  output({type:'system',subtype:'init',session_id:current==='wrong-session'?'11111111-1111-4111-8111-111111111111':session,model:'fixture-model',permissionMode,mcp_servers:[{name:'memory',status:'connected'}]});
  if(current==='child-init')output({type:'system',subtype:'init',session_id:'11111111-1111-4111-8111-111111111111',parent_tool_use_id:'parent',model:'child-model',permissionMode:'acceptEdits'});
  if(current==='malformed'){process.stdout.write('not-json\n');return;}
  if(current==='crash'){output({type:'result',subtype:'error_during_execution',is_error:true,errors:['fixture auth failure'],session_id:session});process.exitCode=1;process.stdin.destroy();return;}
  if(current==='multi-block'||current==='partial-blocks'){
   output({type:'stream_event',event:{type:'message_start',message:{id:'msg-'+turn}}});
   for(const [index,text] of [[1,'第一段'],[3,'第二段']]){
    output({type:'stream_event',event:{type:'content_block_start',index,content_block:{type:'text',text:''}}});
    output({type:'stream_event',event:{type:'content_block_delta',index,delta:{type:'text_delta',text}}});
   }
   if(current==='partial-blocks')for(const text of ['第一段','第二段'])output({type:'assistant',message:{id:'msg-'+turn,content:[{type:'text',text}]}});
   else output({type:'assistant',message:{id:'msg-'+turn,content:[{type:'text',text:'第一段'},{type:'text',text:'第二段'}]}});
   output({type:'result',subtype:'success',result:'第一段\n第二段',session_id:session});return;
  }
  if(current==='interleaved-blocks'||current==='envelope-blocks'||current==='equal-blocks'){
   if(current==='interleaved-blocks')output({type:'stream_event',event:{type:'message_start',message:{id:'msg-'+turn}}});
   for(const [index,text] of [[0,'first block'],[1,current==='equal-blocks'?'first block':'second block']]){
    if(current==='interleaved-blocks'){
     output({type:'stream_event',event:{type:'content_block_start',index,content_block:{type:'text',text:''}}});
     output({type:'stream_event',event:{type:'content_block_delta',index,delta:{type:'text_delta',text}}});
     output({type:'stream_event',event:{type:'content_block_stop',index}});
    }
    output({type:'assistant',uuid:'partial-'+turn+'-'+index,message:{id:'msg-'+turn,content:[{type:'text',text}]}});
   }
   output({type:'stream_event',event:{type:'message_stop'}});
   output({type:'result',subtype:'success',result:current==='equal-blocks'?'first block\nfirst block':'first block\nsecond block',session_id:session});return;
  }
  if(current==='long-reply'){
   const text='你'.repeat(270000);
   output({type:'stream_event',event:{type:'message_start',message:{id:'msg-'+turn}}});
   output({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}});
   for(let i=0;i<text.length;i+=18000)output({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:text.slice(i,i+18000)}}});
   done(text);return;
  }
  if(current==='repeated-valid'){
   for(const id of ['first','second'])output({type:'assistant',message:{id,content:[{type:'text',text:'same reply'}]}});
   output({type:'result',subtype:'success',result:'same reply',session_id:session});return;
  }
  if(current==='child-scope'){
   for(const parent of ['parent',null]){
    output({type:'stream_event',parent_tool_use_id:parent,event:{type:'message_start',message:{id:'same-api-id'}}});
    output({type:'stream_event',parent_tool_use_id:parent,event:{type:'content_block_start',index:0,content_block:{type:'text',text:'same reply'}}});
    output({type:'assistant',parent_tool_use_id:parent,message:{id:'same-api-id',content:[{type:'text',text:'same reply'}]}});
   }
   output({type:'result',subtype:'success',parent_tool_use_id:'parent',result:'child-only summary',session_id:session});
   output({type:'result',subtype:'success',result:'same reply',session_id:session});return;
  }
  if(current==='missing-message-id'){
   output({type:'stream_event',event:{type:'message_start',message:{id:'stream-'+turn}}});
   output({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:'ordinary reply'}}});
   for(let i=0;i<2;i++)output({type:'assistant',uuid:'envelope-'+turn,message:{content:[{type:'text',text:'ordinary reply'}]}});
   output({type:'result',subtype:'success',result:'ordinary reply',session_id:session});return;
  }
  if(current==='background-progress'||current==='background-approve'||current==='background-question'){
   output({type:'system',subtype:'task_started',task_id:'child',description:'background fixture'});
   const intermediate={type:'result',uuid:'background-result-'+turn,subtype:'success',result:'parent waiting',session_id:session};
   output(intermediate);output(intermediate);
   output({type:'system',subtype:'task_notification',task_id:'child',status:'completed',summary:'child done'});
   if(current==='background-approve'||current==='background-question'){
    const question=current==='background-question';
    pending={id:'permission-'+turn,question,input:question?{questions:[{question:'Which database?',options:[{label:'SQLite'}]}]}:{command:'fixture only'}};
    output({type:'control_request',request_id:pending.id,request:{subtype:'can_use_tool',tool_name:question?'AskUserQuestion':'Bash',input:pending.input}});return;
   }
   output({type:'stream_event',event:{type:'message_start',message:{id:'msg-'+turn}}});
   output({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}});
   let ticks=0;const timer=setInterval(()=>{
    output({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'x'}}});
    if(++ticks===6){clearInterval(timer);done('xxxxxx');}
   },30);return;
  }
  if(current==='background-no-final'){
   output({type:'system',subtype:'task_started',task_id:'child',description:'background fixture'});
   const intermediate={type:'result',uuid:'background-result-'+turn,subtype:'success',result:'parent waiting',session_id:session};
   output(intermediate);output(intermediate);
   output({type:'system',subtype:'task_notification',task_id:'child',status:'completed',summary:'child done'});return;
  }
  if(current==='approve'||current==='question'||current==='cancel'){
   const question=current==='question';const input=question?{questions:[{question:'Which database?',header:'Database',options:[{label:'SQLite',description:'Local'},{label:'Postgres'}],multiSelect:false}]}:{command:'touch approved-file',description:'fixture only'};
   const toolName=question?'AskUserQuestion':'Bash';
   output({type:'assistant',message:{id:'tools-'+turn,content:[{type:'tool_use',id:'tool-'+turn,name:toolName,input}]}});
   pending={id:'permission-'+turn,input,question};output({type:'control_request',request_id:pending.id,request:{subtype:'can_use_tool',tool_name:toolName,input,tool_use_id:'tool-'+turn}});
   if(current==='cancel')setTimeout(()=>{output({type:'control_cancel_request',request_id:pending.id});pending=undefined;done('cancelled request');},80);
   return;
  }
  output({type:'stream_event',event:{type:'message_start',message:{id:'msg-'+turn,model:'fixture-model'}}});
  output({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}});
  const delta=JSON.stringify({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'你好 🌏'}}})+'\n';
  process.stdout.write(delta.slice(0,20));process.stdout.write(delta.slice(20));
  if(current==='hang')return;
  done('你好 🌏');return;
 }
 if(m.type==='control_response'&&pending&&m.response.request_id===pending.id){
  const response=m.response.response;
  const text=response.behavior==='deny'?'denied':pending.question?'answer:'+response.updatedInput.answers['Which database?']:'approved';
  output({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool-'+turn,content:text,is_error:response.behavior==='deny'}]}});pending=undefined;
  // An interrupting denial is followed by the interrupt control request, which ends the turn.
  // Emitting a result here too races a second result into the next test turn.
  if(!response.interrupt)done(text);
 }
});
`;
function setup(options: { initialFailure?: boolean; noTranscript?: boolean } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-'));
  const store = new StateStore(directory);
  const session: Session = { id: randomUUID(), projectId: randomUUID(), title: 'chat', kind: 'claude', adapter: 'structured', cwd: directory, claudeId: randomUUID(), started: false, model: '', effort: 'default', permissionMode: 'default', status: 'idle', archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  store.change(state => state.sessions.push(session));
  const script = path.join(directory, 'fixture.cjs'); fs.writeFileSync(script, fixture);
  const record = path.join(directory, 'stdin.jsonl');
  const observedId = randomUUID(); const starts: boolean[] = [], launches: string[][] = [];
  const runtime = new ChatRuntime(store, () => {}, () => {}, { initializationTimeoutMs: 1500, controlTimeoutMs: 150, backgroundResultTimeoutMs: 80, transcriptExists: async () => !options.noTranscript && starts.length > 0, invocation: (session, caps, resumed) => { launches.push(chatArguments(session, caps, resumed)); starts.push(resumed); return { file: process.execPath, args: [script, observedId, record, options.initialFailure && starts.length === 1 ? 'fail-init' : '', session.permissionMode] }; } });
  const sent = () => fs.readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { directory, store, session, runtime, starts, launches, observedId, sent, cleanup: async () => { await runtime.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('stream framing handles split/coalesced records, blank lines, UTF8 and rejects malformed/oversized frames', () => {
  const values: unknown[] = []; const decoder = new JsonLineDecoder(value => values.push(value), 100);
  decoder.push('{"text":"你'); decoder.push('好🌏"}\n\n{"n":2}\n'); decoder.push('{"tail":true}'); decoder.finish();
  assert.deepEqual(values, [{ text: '你好🌏' }, { n: 2 }, { tail: true }]);
  assert.throws(() => new JsonLineDecoder(() => {}).push('not-json\n'), /非 JSON/);
  assert.throws(() => new JsonLineDecoder(() => {}, 10).push('x'.repeat(11)), /上限/);
});

test('arguments retain approval support and preserve the explicitly selected permission mode', () => {
  const s = setup();
  try {
    const args = chatArguments({ ...s.session, model: 'name; $(echo bad)' }, capabilities, false);
    assert.ok(args.includes('--permission-prompt-tool')); assert.ok(args.includes('stdio'));
    assert.ok(args.includes('name; $(echo bad)')); assert.ok(!args.some(value => value.includes('dangerously')));
    const bypass=chatArguments({...s.session,permissionMode:'bypassPermissions'},capabilities,false);
    assert.equal(bypass[bypass.indexOf('--permission-mode')+1],'bypassPermissions');
    assert.equal(bypass[bypass.indexOf('--permission-prompt-tool')+1],'stdio');
    assert.throws(() => chatArguments(s.session, { ...capabilities, flags: capabilities.flags.filter(flag => flag !== '--permission-prompt-tool') }, false), /不支持结构化/);
    assert.ok(chatArguments(s.session, capabilities, true).includes('--resume'));
  } finally { fs.rmSync(s.directory, { recursive: true, force: true }); }
});

test('persistent subprocess streams one assistant message, synchronizes identity, supports multiple turns and resume', async () => {
  const s = setup();
  try {
    assert.equal((await s.runtime.send(s.session.id, 'hello', capabilities)).success, true);
    let snapshot = s.runtime.snapshot(s.session.id);
    assert.equal(snapshot.taskState, 'completed'); assert.equal(snapshot.messages.filter(message => message.role === 'assistant').length, 1);
    assert.equal(snapshot.messages.find(message => message.role === 'assistant')!.text, '你好 🌏');
    assert.equal(s.store.state.sessions[0].claudeId, s.observedId);
    assert.equal(snapshot.usage?.inputTokens, 12); assert.equal(snapshot.mcpServers?.[0].name, 'memory');
    await s.runtime.send(s.session.id, 'second', capabilities); assert.equal(s.starts.length, 1);
    s.runtime.stop(s.session.id); await until(() => !s.runtime.has(s.session.id));
    await s.runtime.send(s.session.id, 'third', capabilities); assert.deepEqual(s.starts, [false, true]);
    snapshot = s.runtime.snapshot(s.session.id); assert.equal(snapshot.messages.filter(message => message.role === 'user').length, 3);
    assert.match(fs.readFileSync(s.runtime.exportPath(s.session.id), 'utf8'), /text_delta/);
  } finally { await s.cleanup(); }
});

test('permission and question responses are scoped to pending requests and preserve immutable original input', async () => {
  const s = setup();
  try {
    const result = s.runtime.send(s.session.id, 'approve', capabilities);
    await until(() => s.runtime.snapshot(s.session.id).pending.length === 1);
    const snapshot = s.runtime.snapshot(s.session.id); const request = snapshot.pending[0];
    assert.equal(snapshot.taskState, 'waiting_approval');
    request.input.command = 'tampered';
    await assert.rejects(s.runtime.send(s.session.id, 'parallel', capabilities), /上一轮/);
    assert.throws(() => s.runtime.respond(s.session.id, 'wrong', { behavior: 'allow' }), /失效/);
    s.runtime.respond(s.session.id, request.requestId, { behavior: 'allow' });
    assert.throws(() => s.runtime.respond(s.session.id, request.requestId, { behavior: 'allow' }), /失效/);
    assert.equal((await result).summary, 'approved');
    const response = s.sent().find(message => message.type === 'control_response');
    assert.equal(response.response.response.updatedInput.command, 'touch approved-file');
    const questionResult = s.runtime.send(s.session.id, 'question', capabilities);
    await until(() => s.runtime.snapshot(s.session.id).pending.length === 1);
    const question = s.runtime.snapshot(s.session.id).pending[0];
    assert.equal(s.runtime.snapshot(s.session.id).taskState, 'waiting_input');
    assert.throws(() => s.runtime.respond(s.session.id, question.requestId, { behavior: 'allow', answers: {} }), /全部问题/);
    s.runtime.respond(s.session.id, question.requestId, { behavior: 'allow', answers: { 'Which database?': 'SQLite' } });
    assert.equal((await questionResult).summary, 'answer:SQLite');
    const denied = s.runtime.send(s.session.id, 'approve', capabilities);
    await until(() => s.runtime.snapshot(s.session.id).pending.length === 1);
    s.runtime.respond(s.session.id, s.runtime.snapshot(s.session.id).pending[0].requestId, { behavior: 'deny', message: 'No deletion' });
    assert.equal((await denied).summary, 'denied');
  } finally { await s.cleanup(); }
});

test('CLI cancellation expires approval, interrupt ends only the turn, configuration changes require acknowledgements', async () => {
  const s = setup();
  try {
    const cancelled = s.runtime.send(s.session.id, 'cancel', capabilities);
    await until(() => s.runtime.snapshot(s.session.id).pending.length === 1);
    const request = s.runtime.snapshot(s.session.id).pending[0];
    await cancelled; assert.throws(() => s.runtime.respond(s.session.id, request.requestId, { behavior: 'allow' }), /失效/);
    await s.runtime.updateConfig(s.session.id, { model: 'new-model', permissionMode: 'plan' });
    assert.equal(s.store.state.sessions[0].model, 'new-model'); assert.equal(s.store.state.sessions[0].permissionMode, 'plan');
    await assert.rejects(s.runtime.updateConfig(s.session.id, { model: 'bad' }), /unknown model/);
    assert.equal(s.store.state.sessions[0].model, 'new-model');
    await assert.rejects(s.runtime.updateConfig(s.session.id, { effort: 'max' }), /停止会话/);
    const hanging = s.runtime.send(s.session.id, 'hang', capabilities);
    await until(() => s.runtime.snapshot(s.session.id).taskState === 'thinking');
    await s.runtime.interrupt(s.session.id);
    assert.equal((await hanging).interrupted, true); assert.equal(s.runtime.snapshot(s.session.id).taskState, 'interrupted');
    assert.equal(s.runtime.has(s.session.id), true);
    assert.equal((await s.runtime.send(s.session.id, 'after interruption', capabilities)).success, true);
  } finally { await s.cleanup(); }
});

test('bypass switches restart idle CLI processes, resume identity and retain interactive questions', async () => {
  const s=setup();
  try {
    await s.runtime.send(s.session.id,'first turn',capabilities);
    const originalId=s.store.state.sessions[0].claudeId;
    await s.runtime.updateConfig(s.session.id,{permissionMode:'bypassPermissions',model:undefined,effort:undefined});
    assert.equal(s.runtime.has(s.session.id),false);
    assert.equal(s.store.state.sessions[0].permissionMode,'bypassPermissions');
    assert.equal(s.runtime.snapshot(s.session.id).permissionMode,'bypassPermissions');
    const questionResult=s.runtime.send(s.session.id,'question',capabilities);
    await until(()=>s.runtime.snapshot(s.session.id).pending.length===1);
    assert.deepEqual(s.starts,[false,true]);
    assert.equal(s.launches[1][s.launches[1].indexOf('--resume')+1],originalId);
    assert.equal(s.launches[1][s.launches[1].indexOf('--permission-mode')+1],'bypassPermissions');
    assert.equal(s.runtime.snapshot(s.session.id).taskState,'waiting_input');
    const request=s.runtime.snapshot(s.session.id).pending[0];
    await assert.rejects(s.runtime.updateConfig(s.session.id,{permissionMode:'default'}),/等待当前任务/);
    s.runtime.respond(s.session.id,request.requestId,{behavior:'allow',answers:{'Which database?':'SQLite'}});
    assert.equal((await questionResult).summary,'answer:SQLite');
    assert.equal(s.store.state.sessions[0].observedPermissionMode,'bypassPermissions');
    await s.runtime.updateConfig(s.session.id,{permissionMode:'plan'});
    assert.equal(s.runtime.has(s.session.id),false);
    await s.runtime.send(s.session.id,'after bypass',capabilities);
    assert.deepEqual(s.starts,[false,true,true]);
    assert.equal(s.store.state.sessions[0].claudeId,originalId);
    assert.equal(s.launches[2][s.launches[2].indexOf('--permission-mode')+1],'plan');
    assert.ok(!s.launches[2].some(value=>/bypass|dangerously/i.test(value)));
    assert.equal(s.runtime.snapshot(s.session.id).permissionMode,'plan');
    assert.equal(s.sent().some(frame=>frame.type==='control_request'&&frame.request.subtype==='set_permission_mode'),false);
  } finally { await s.cleanup(); }
});

test('protocol failure and model error are surfaced without hanging the pending turn', async () => {
  const s = setup();
  try {
    const result = await s.runtime.send(s.session.id, 'malformed', capabilities);
    assert.equal(result.success, false); assert.match(result.error!, /非 JSON/);
    await until(() => !s.runtime.has(s.session.id));
    const failed = await s.runtime.send(s.session.id, 'crash', capabilities);
    assert.equal(failed.success, false); assert.match(failed.error!, /fixture auth failure/);
    await until(() => !s.runtime.has(s.session.id));
    assert.match(s.runtime.snapshot(s.session.id).error!, /fixture auth failure/);
  } finally { await s.cleanup(); }
});

test('history bounds the UI projection, retains journal events and drops approvals on restart', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-history-'));
  try {
    const id = randomUUID(); const history = new ChatHistory(directory, () => false);
    const snapshot = history.get(id);
    snapshot.taskState = 'waiting_approval'; snapshot.pending = [{ requestId: 'expired', toolName: 'Bash', kind: 'permission', input: {}, createdAt: '' }];
    for (let index = 0; index < 450; index++) {
      const message = { id: String(index), turnId: 'one', role: 'user' as const, text: 'entry ' + index, createdAt: '' };
      snapshot.messages.push(message); history.append(id, { type: 'message', message }); history.changed(id);
    }
    history.flush(); assert.equal(snapshot.messages.length, 400); assert.equal(snapshot.truncated, true);
    assert.equal(fs.readFileSync(history.exportPath(id), 'utf8').trim().split('\n').length, 450);
    const restored = new ChatHistory(directory, () => false).get(id);
    assert.equal(restored.taskState, 'interrupted'); assert.deepEqual(restored.pending, []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('missing final result after background completion fails closed instead of advancing workflow or hanging', async () => {
  const s = setup();
  try {
    const result = await s.runtime.send(s.session.id, 'background-no-final', capabilities);
    assert.equal(result.success, false); assert.match(result.error!, /未返回最终结果/);
    await until(() => !s.runtime.has(s.session.id));
  } finally { await s.cleanup(); }
});

test('interrupt during attachment loading prevents a late process spawn', async () => {
  const s = setup();
  try {
    const file = path.join(s.directory, 'large.png'); fs.writeFileSync(file, Buffer.alloc(1024));
    const pending = s.runtime.send(s.session.id, 'inspect', capabilities, [file]);
    await s.runtime.interrupt(s.session.id);
    await assert.rejects(pending, /取消/); assert.equal(s.starts.length, 0);
  } finally { await s.cleanup(); }
});

test('initialization and authentication failures without a transcript remain retryable with the same fresh ID', async () => {
  const s = setup({ initialFailure: true, noTranscript: true });
  try {
    await assert.rejects(s.runtime.send(s.session.id, 'hello', capabilities), /initialize failed/);
    await until(() => !s.runtime.has(s.session.id));
    assert.equal(s.store.state.sessions[0].started, false);
    assert.equal(s.store.state.sessions[0].claudeId, s.session.claudeId);
    const auth = await s.runtime.send(s.session.id, 'crash', capabilities);
    assert.equal(auth.success, false); await until(() => !s.runtime.has(s.session.id));
    assert.equal(s.store.state.sessions[0].started, false);
    assert.equal((await s.runtime.send(s.session.id, 'hello', capabilities)).success, true);
    assert.equal(s.store.state.sessions[0].started, true);
    s.runtime.stop(s.session.id); await until(() => !s.runtime.has(s.session.id));
    await assert.rejects(s.runtime.send(s.session.id, 'missing established transcript', capabilities), /未找到原会话记录/);
  } finally { await s.cleanup(); }
});

test('child session metadata cannot overwrite root settings and unacknowledged live config stops the process', async () => {
  const s = setup();
  try {
    await s.runtime.send(s.session.id, 'child-init', capabilities);
    assert.equal(s.runtime.snapshot(s.session.id).model, 'fixture-model');
    assert.equal(s.store.state.sessions[0].permissionMode, 'default');
    assert.equal(s.store.state.sessions[0].claudeId, s.observedId);
    await assert.rejects(s.runtime.updateConfig(s.session.id, { model: 'no-ack' }), /超时/);
    await until(() => !s.runtime.has(s.session.id));
    assert.match(s.runtime.snapshot(s.session.id).error!, /配置变更未获 CLI 确认/);
  } finally { await s.cleanup(); }
});

test('journal disk failure during streamed output settles pending turn and terminates the subprocess', async () => {
  const s = setup();
  const history = (s.runtime as unknown as { history: ChatHistory }).history;
  const append = history.append.bind(history);
  try {
    const pending = s.runtime.send(s.session.id, 'approve', capabilities);
    await until(() => s.runtime.snapshot(s.session.id).pending.length === 1);
    const request = s.runtime.snapshot(s.session.id).pending[0];
    s.runtime.respond(s.session.id, request.requestId, { behavior: 'allow' });
    history.append = () => { throw new Error('ENOSPC injected journal write failure'); };
    const result = await pending;
    assert.equal(result.success, false); assert.match(result.error!, /ENOSPC/);
    await until(() => !s.runtime.has(s.session.id));
  } finally { history.append = append; await s.cleanup(); }
});

test('resumed session identity mismatch stops execution and preserves the established UUID', async () => {
  const s = setup();
  try {
    await s.runtime.send(s.session.id, 'hello', capabilities);
    s.runtime.stop(s.session.id); await until(() => !s.runtime.has(s.session.id));
    const result = await s.runtime.send(s.session.id, 'wrong-session', capabilities);
    assert.equal(result.success, false); assert.match(result.error!, /不同的会话 ID/);
    assert.equal(s.store.state.sessions[0].claudeId, s.observedId);
    await until(() => !s.runtime.has(s.session.id));
  } finally { await s.cleanup(); }
});

test('selected images/PDFs are sent as typed blocks while ordinary files remain explicit local references', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-attachments-'));
  try {
    const image = path.join(directory, 'image.png'); const file = path.join(directory, 'source.ts');
    fs.writeFileSync(image, Buffer.from([137, 80, 78, 71])); fs.writeFileSync(file, 'export const a = 1;');
    const content = await userContent('review', [image, file]);
    assert.equal(content[2].type, 'image'); assert.deepEqual(content[2].source, { type: 'base64', media_type: 'image/png', data: Buffer.from([137, 80, 78, 71]).toString('base64') });
    assert.match(String(content[3].text), /source\.ts/);
    await assert.rejects(userContent('x', Array(9).fill(file)), /8 个/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('imported conversation hydrates readonly text/tool history once, with bounded preview and no old approvals', async () => {
  const s = setup(); const originalConfig = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = path.join(s.directory, 'claude-config');
    const transcripts = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'test-project'); fs.mkdirSync(transcripts, { recursive: true });
    const file = path.join(transcripts, s.session.claudeId + '.jsonl');
    const records = [
      { type: 'user', uuid: 'u1', cwd: s.directory, message: { content: '原始提问' }, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'assistant', uuid: 'a1', cwd: s.directory, message: { content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: '原始回复' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/a.ts' } }] } },
      { type: 'user', uuid: 'u2', cwd: s.directory, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'export const a=1;' }] } }
    ].map(record => JSON.stringify(record)).join('\n') + '\n';
    fs.writeFileSync(file, records); s.store.change(state => { state.sessions[0].imported = true; });
    await s.runtime.hydrate(s.session.id); const first = s.runtime.snapshot(s.session.id);
    assert.ok(first.messages.some(message => message.text === '原始回复'));
    assert.ok(first.messages.some(message => message.toolName === 'Read'));
    assert.ok(!JSON.stringify(first).includes('hidden')); assert.deepEqual(first.pending, []);
    await s.runtime.hydrate(s.session.id); assert.equal(s.runtime.snapshot(s.session.id).messages.length, first.messages.length);
    assert.equal(fs.readFileSync(file, 'utf8'), records);
    fs.writeFileSync(file, Array.from({ length: 240 }, (_, i) => JSON.stringify({ type: 'user', uuid: String(i), message: { content: 'entry' + i } })).join('\n'));
    const preview = await readTranscriptPreview(file); assert.equal(preview.messages.length, 200); assert.equal(preview.truncated, true);
  } finally { if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = originalConfig; await s.cleanup(); }
});


test('ordinary missing-id completion and repeated envelope reconcile with the pending stream', async () => {
  const s = setup();
  try {
    await s.runtime.send(s.session.id, 'missing-message-id', capabilities);
    const replies = s.runtime.snapshot(s.session.id).messages.filter(message => message.role === 'assistant');
    assert.equal(replies.length, 1); assert.equal(replies[0].text, 'ordinary reply');
  } finally { await s.cleanup(); }
});

test('multi-block and partial-block complete envelopes reconcile stream indexes and result summaries', async () => {
  const s = setup();
  try {
    for (const prompt of ['multi-block', 'partial-blocks', 'interleaved-blocks', 'envelope-blocks', 'equal-blocks']) {
      await s.runtime.send(s.session.id, prompt, capabilities);
      const snapshot = s.runtime.snapshot(s.session.id);
      const turnId = snapshot.messages.filter(message => message.role === 'user').at(-1)!.turnId;
      assert.deepEqual(snapshot.messages.filter(message => message.role === 'assistant' && message.turnId === turnId).map(message => message.text), prompt === 'equal-blocks' ? ['first block', 'first block'] : prompt.endsWith('blocks') && !prompt.startsWith('partial') ? ['first block', 'second block'] : ['第一段', '第二段']);
    }
  } finally { await s.cleanup(); }
});

test('equal text from distinct message ids, turns and child scopes remains visible', async () => {
  const s = setup();
  try {
    await s.runtime.send(s.session.id, 'repeated-valid', capabilities);
    await s.runtime.send(s.session.id, 'repeated-valid', capabilities);
    await s.runtime.send(s.session.id, 'child-scope', capabilities);
    const replies = s.runtime.snapshot(s.session.id).messages.filter(message => message.role === 'assistant');
    assert.equal(replies.length, 6); assert.ok(replies.every(message => message.text === 'same reply'));
    assert.equal(replies.filter(message => message.parentToolUseId === 'parent').length, 1);
    assert.equal(new Set(replies.map(message => message.id)).size, 6);
  } finally { await s.cleanup(); }
});

test('long streamed completion has one marked bounded reply and retains full journal content', async () => {
  const s = setup();
  try {
    const result = await s.runtime.send(s.session.id, 'long-reply', capabilities);
    assert.equal(result.summary.length, 270000);
    const replies = s.runtime.snapshot(s.session.id).messages.filter(message => message.role === 'assistant');
    assert.equal(replies.length, 1); assert.equal(replies[0].text.length, 256 * 1024); assert.equal(replies[0].truncated, true);
    const journal = fs.readFileSync(s.runtime.exportPath(s.session.id), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(journal.some(event => event.type === 'message' && event.message.text.length === 270000));
    assert.equal(s.runtime.taskState(s.session.id), 'completed');
  } finally { await s.cleanup(); }
});

test('background completion deadline pauses for approval and resumes after the response', async () => {
  const s = setup();
  try {
    for (const prompt of ['background-approve', 'background-question']) {
      const pending = s.runtime.send(s.session.id, prompt, capabilities);
      await until(() => s.runtime.snapshot(s.session.id).pending.length === 1);
      const request = s.runtime.snapshot(s.session.id).pending[0];
      await new Promise(resolve => setTimeout(resolve, 180));
      assert.equal(s.runtime.taskState(s.session.id), prompt === 'background-question' ? 'waiting_input' : 'waiting_approval');
      assert.equal(s.runtime.has(s.session.id), true);
      s.runtime.respond(s.session.id, request.requestId, { behavior: 'allow', answers: { 'Which database?': 'SQLite' } });
      assert.equal((await pending).success, true);
    }
  } finally { await s.cleanup(); }
});

test('continued background output resets inactivity deadline until the final result', async () => {
  const s = setup();
  try {
    const result = await s.runtime.send(s.session.id, 'background-progress', capabilities);
    assert.equal(result.success, true); assert.equal(result.summary, 'xxxxxx');
    assert.equal(s.runtime.snapshot(s.session.id).messages.filter(message => message.role === 'assistant' && message.text === 'parent waiting').length, 1);
    assert.equal(s.runtime.taskState(s.session.id), 'completed');
  } finally { await s.cleanup(); }
});


test('idle transcript refresh appends only new source identities after a shared anchor', async () => {
  const s = setup(); const originalConfig = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = path.join(s.directory, 'claude-config');
    const transcripts = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'test-project'); fs.mkdirSync(transcripts, { recursive: true });
    const file = path.join(transcripts, s.session.claudeId + '.jsonl');
    const record = (type: string, uuid: string, text: string) => JSON.stringify({ type, uuid, cwd: s.directory, message: { content: text } }) + '\n';
    fs.writeFileSync(file, record('user', 'u1', 'original') + record('assistant', 'a1', 'same reply'));
    s.store.change(state => { state.sessions[0].imported = true; });
    await s.runtime.hydrate(s.session.id);
    fs.appendFileSync(file, record('user', 'u2', 'external continuation') + record('assistant', 'a2', 'same reply'));
    await s.runtime.hydrate(s.session.id);
    let snapshot = s.runtime.snapshot(s.session.id);
    assert.deepEqual(snapshot.messages.filter(message => message.role === 'assistant').map(message => message.text), ['same reply', 'same reply']);
    const count = snapshot.messages.length;
    await s.runtime.hydrate(s.session.id); assert.equal(s.runtime.snapshot(s.session.id).messages.length, count);
    // A truncated or replaced transcript without a shared identity cannot safely
    // be merged. Keep the local projection instead of guessing by text equality.
    fs.writeFileSync(file, record('user', 'u1', 'original') + record('assistant', 'unrelated', 'same reply'));
    await s.runtime.hydrate(s.session.id); snapshot = s.runtime.snapshot(s.session.id);
    assert.equal(snapshot.messages.length, count); assert.deepEqual(snapshot.pending, []);
  } finally { if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = originalConfig; await s.cleanup(); }
});


test('transcript records with one shared API id retain distinct partial blocks by record identity', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-import-'));
  try {
    const file = path.join(directory, 'transcript.jsonl');
    const records = ['first', 'second'].map((text, index) => ({ type: 'assistant', uuid: 'record-' + index, message: { id: 'shared-api-message', content: [{ type: 'text', text }] } }));
    fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
    const preview = await readTranscriptPreview(file);
    assert.deepEqual(preview.messages.map(message => message.text), ['first', 'second']);
    assert.equal(new Set(preview.messages.map(message => message.id)).size, 2);
    assert.deepEqual(preview.messages.map(message => message.sourceId), ['record-0', 'record-1']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});


test('shutdown stops every chat subprocess even when saving the first turn fails', async () => {
  const s = setup();
  const history = (s.runtime as unknown as { history: ChatHistory }).history;
  const flush = history.flush.bind(history);
  const second = { ...s.session, id: randomUUID(), claudeId: randomUUID() };
  s.store.change(state => state.sessions.push(second));
  try {
    const firstTurn = s.runtime.send(s.session.id, 'hang', capabilities);
    const secondTurn = s.runtime.send(second.id, 'hang', capabilities);
    await until(() => s.runtime.taskState(s.session.id) === 'thinking' && s.runtime.taskState(second.id) === 'thinking');
    let calls = 0;
    history.flush = () => { if (++calls === 1) throw new Error('injected shutdown disk failure'); flush(); };
    await assert.rejects(s.runtime.shutdown(), /injected shutdown disk failure/);
    assert.equal(s.runtime.has(s.session.id), false); assert.equal(s.runtime.has(second.id), false);
    assert.equal((await firstTurn).success, false); assert.equal((await secondTurn).interrupted, true);
  } finally { history.flush = flush; await s.cleanup(); }
});

test('attention summaries expose only live requests and remove resolved, cancelled and stopped approvals',async()=>{
  const s=setup();try{
    const turn=s.runtime.send(s.session.id,'approve',capabilities);await until(()=>s.runtime.attention().length===1);
    const [pending]=s.runtime.attention();assert.equal(pending.sessionId,s.session.id);assert.equal(pending.kind,'permission');assert.equal('input' in pending,false);
    s.runtime.respond(s.session.id,pending.requestId,{behavior:'deny'});assert.deepEqual(s.runtime.attention(),[]);await turn;
    const question=s.runtime.send(s.session.id,'question',capabilities);await until(()=>s.runtime.attention()[0]?.kind==='question');
    await s.runtime.interrupt(s.session.id);await question;assert.deepEqual(s.runtime.attention(),[]);
    const cancelled=s.runtime.send(s.session.id,'cancel',capabilities);await cancelled;assert.deepEqual(s.runtime.attention(),[]);
    const stopping=s.runtime.send(s.session.id,'approve',capabilities);await until(()=>s.runtime.attention().length===1);s.runtime.stop(s.session.id);
    assert.deepEqual(s.runtime.attention(),[]);await stopping;
  }finally{await s.cleanup();}
});
