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
const output = value => process.stdout.write(JSON.stringify(value)+'\n');
let turn=0;let pending;let current='';
const done = text => { output({type:'assistant',message:{id:'msg-'+turn,content:[{type:'text',text}]}}); output({type:'result',subtype:'success',is_error:false,result:text,session_id:session,usage:{input_tokens:12,output_tokens:3},duration_ms:42,total_cost_usd:0.001,num_turns:1}); };
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(process.argv[3],line+'\n');
 if(m.type==='control_request'){
  const r=m.request;
  if(r.subtype==='initialize'&&process.argv[4]==='fail-init'){output({type:'control_response',response:{subtype:'error',request_id:m.request_id,error:'initialize failed'}});return;}
  if(r.model==='no-ack')return;
  output({type:'control_response',response:r.model==='bad'?{subtype:'error',request_id:m.request_id,error:'unknown model'}:{subtype:'success',request_id:m.request_id,response:{}}});
  if(r.subtype==='interrupt'){if(pending)output({type:'control_cancel_request',request_id:pending.id});pending=undefined;done('interrupted');}
  return;
 }
 if(m.type==='user'){
  ++turn;current=m.message.content[0].text;
  output({type:'system',subtype:'init',session_id:current==='wrong-session'?'11111111-1111-4111-8111-111111111111':session,model:'fixture-model',permissionMode:'default',mcp_servers:[{name:'memory',status:'connected'}]});
  if(current==='child-init')output({type:'system',subtype:'init',session_id:'11111111-1111-4111-8111-111111111111',parent_tool_use_id:'parent',model:'child-model',permissionMode:'acceptEdits'});
  if(current==='malformed'){process.stdout.write('not-json\n');return;}
  if(current==='crash'){output({type:'result',subtype:'error_during_execution',is_error:true,errors:['fixture auth failure'],session_id:session});process.exitCode=1;process.stdin.destroy();return;}
  if(current==='background-no-final'){
   output({type:'system',subtype:'task_started',task_id:'child',description:'background fixture'});
   output({type:'result',subtype:'success',result:'parent waiting',session_id:session});
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
  output({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool-'+turn,content:text,is_error:response.behavior==='deny'}]}});pending=undefined;done(text);
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
  const observedId = randomUUID(); const starts: boolean[] = [];
  const runtime = new ChatRuntime(store, () => {}, () => {}, { initializationTimeoutMs: 1500, controlTimeoutMs: 150, backgroundResultTimeoutMs: 80, transcriptExists: async () => !options.noTranscript && starts.length > 0, invocation: (session, caps, resumed) => { chatArguments(session, caps, resumed); starts.push(resumed); return { file: process.execPath, args: [script, observedId, record, options.initialFailure && starts.length === 1 ? 'fail-init' : ''] }; } });
  const sent = () => fs.readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { directory, store, session, runtime, starts, observedId, sent, cleanup: async () => { await runtime.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('stream framing handles split/coalesced records, blank lines, UTF8 and rejects malformed/oversized frames', () => {
  const values: unknown[] = []; const decoder = new JsonLineDecoder(value => values.push(value), 100);
  decoder.push('{"text":"你'); decoder.push('好🌏"}\n\n{"n":2}\n'); decoder.push('{"tail":true}'); decoder.finish();
  assert.deepEqual(values, [{ text: '你好🌏' }, { n: 2 }, { tail: true }]);
  assert.throws(() => new JsonLineDecoder(() => {}).push('not-json\n'), /非 JSON/);
  assert.throws(() => new JsonLineDecoder(() => {}, 10).push('x'.repeat(11)), /上限/);
});

test('arguments require bidirectional approval support, preserve model strings, and never bypass permissions', () => {
  const s = setup();
  try {
    const args = chatArguments({ ...s.session, model: 'name; $(echo bad)' }, capabilities, false);
    assert.ok(args.includes('--permission-prompt-tool')); assert.ok(args.includes('stdio'));
    assert.ok(args.includes('name; $(echo bad)')); assert.ok(!args.some(value => value.includes('dangerously')));
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
