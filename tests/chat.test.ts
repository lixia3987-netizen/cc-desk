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
let session = process.argv[2];
const commands=[{name:'compact',builtin:true,description:'压缩上下文',argumentHint:'[保留内容]'}, {name:'context',builtin:true,description:'上下文详情'}, {name:'clear',builtin:true}, {name:'team:review',description:'项目代码检查'}, {name:'resume',builtin:true}];
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
  output({type:'control_response',response:r.model==='bad'?{subtype:'error',request_id:m.request_id,error:'unknown model'}:{subtype:'success',request_id:m.request_id,response:r.subtype==='initialize'?{commands}: {}}});
  if(r.subtype==='interrupt'){if(pending)output({type:'control_cancel_request',request_id:pending.id});pending=undefined;done('interrupted');}
  return;
 }
 if(m.type==='user'){
  ++turn;current=typeof m.message.content==='string'?m.message.content:m.message.content[0].text;
  output({type:'system',subtype:'init',session_id:current==='wrong-session'?'11111111-1111-4111-8111-111111111111':session,model:'fixture-model',permissionMode,mcp_servers:[{name:'memory',status:'connected'}]});
  if(current==='child-init')output({type:'system',subtype:'init',session_id:'11111111-1111-4111-8111-111111111111',parent_tool_use_id:'parent',model:'child-model',permissionMode:'acceptEdits'});
  if(current==='context-fixture'){
   for(const [id,input,cache] of [['first',100,10000],['second',200,40000],['second',200,40000]])output({type:'assistant',message:{id,model:'fixture-model',usage:{input_tokens:input,cache_read_input_tokens:cache,cache_creation_input_tokens:5000},content:[]}});
   output({type:'assistant',parent_tool_use_id:'child',message:{model:'child-model',usage:{input_tokens:900000},content:[]}});
   output({type:'result',subtype:'success',result:'done',session_id:session,usage:{input_tokens:999999},modelUsage:{'fixture-model':{contextWindow:200000,inputTokens:999999},'child-model':{contextWindow:1000000}}});return;
  }
  if(current==='/compact'){
   output({type:'system',subtype:'status',status:'compacting'});
   setTimeout(()=>{output({type:'system',subtype:'compact_boundary',compact_metadata:{trigger:'manual',pre_tokens:45200}});done('compacted');},30);return;
  }
  if(current==='/compact noop'){done('Not enough messages to compact');return;}
  if(current==='/compact fail'){
   output({type:'system',subtype:'status',status:'compacting'});
   output({type:'result',subtype:'error_during_execution',is_error:true,session_id:session,errors:['compaction failed']});return;
  }
  if(current==='auto-compact'){
   output({type:'system',subtype:'status',status:'compacting'});
   output({type:'assistant',message:{model:'fixture-model',usage:{input_tokens:199999},content:[]}});
   output({type:'system',subtype:'compact_boundary',compact_metadata:{trigger:'auto',pre_tokens:45200}});
   output({type:'stream_event',event:{type:'message_start',message:{id:'after-compact',model:'fixture-model',usage:{input_tokens:8000}}}});
   done('continued after automatic compaction');return;
  }
  if(current==='/context'){
   output({type:'assistant',message:{id:'context-report',content:[{type:'text',text:'context report'}]},context_usage:{model:'fixture-model',total_tokens:12000,raw_max_tokens:200000,percentage:6}});done('context report');return;
  }
  if(current.startsWith('/clear')){
   if(current==='/clear fail'){output({type:'result',subtype:'error_during_execution',is_error:true,session_id:session,errors:['clear failed']});return;}
   if(current!=='/clear same-id')session='22222222-2222-4222-8222-222222222222';
   if(current!=='/clear result-only')output({type:'conversation_reset',session_id:session,new_conversation_id:session});done('cleared');return;
  }
  if(current==='/team:review 参数'){
   output({type:'system',subtype:'commands_changed',commands:[{name:'context',builtin:true},{name:'new-skill',description:'新 Skill',builtin:false}]});done('skill done');return;
  }
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
  if(current==='subtasks-parallel'){
   for(const [tool,task] of [['agent-a','task-a'],['agent-b','task-b'],['agent-c','task-c']]){
    output({type:'assistant',message:{id:tool,content:[{type:'tool_use',id:tool,name:'Agent',input:{description:tool,run_in_background:true}}]}});
    output({type:'system',subtype:'task_started',task_id:task,tool_use_id:tool,task_type:'local_agent',description:tool});
   }
   output({type:'system',subtype:'task_progress',task_id:'task-a',tool_use_id:'agent-a',description:'Review implementation',summary:'Reading tests',last_tool_name:'Read',usage:{total_tokens:240,tool_uses:2,duration_ms:25}});
   setTimeout(()=>{
    output({type:'system',subtype:'task_notification',task_id:'task-a',tool_use_id:'agent-a',status:'completed',summary:'Review done'});
    output({type:'system',subtype:'task_updated',task_id:'task-b',patch:{status:'killed',description:'Cancelled analysis'}});
    output({type:'system',subtype:'task_notification',task_id:'task-c',status:'failed',summary:'Fixture failure'});
    output({type:'system',subtype:'task_started',task_id:'task-a',tool_use_id:'agent-a',description:'late duplicate'});
    output({type:'system',subtype:'task_progress',task_id:'task-a',tool_use_id:'agent-a',usage:{total_tokens:999}});
    done('parallel done');
   },100);return;
  }
  if(current==='subtasks-foreground'){
   for(const [tool,input] of [['foreground',{run_in_background:false}],['unconfirmed',{}],['reported',{}]]){
    output({type:'assistant',message:{id:tool,content:[{type:'tool_use',id:tool,name:'Task',input:{description:tool,...input}}]}});
    output({type:'user',tool_use_result:tool==='reported'?{status:'completed',agentId:'agent-reported',totalToolUseCount:4,totalDurationMs:75,content:[{type:'text',text:'Final report'}]}:undefined,message:{content:[{type:'tool_result',tool_use_id:tool,content:tool==='unconfirmed'?'Agent launched':'Agent finished'}]}});
   }
   done('foreground done');return;
  }
  if(current==='subtasks-background-ack'){
   output({type:'system',subtype:'task_started',task_id:'async-task',tool_use_id:'async-tool',task_type:'local_agent',description:'Background agent'});
   output({type:'assistant',message:{id:'async-message',content:[{type:'tool_use',id:'async-tool',name:'Agent',input:{description:'Background agent'}}]}});
   output({type:'user',tool_use_result:{status:'async_launched',agentId:'async-agent',description:'Background agent'},message:{content:[{type:'tool_result',tool_use_id:'async-tool',content:'Launched successfully'}]}});
   output({type:'result',uuid:'async-intermediate',subtype:'success',result:'Agent launched',session_id:session});
   setTimeout(()=>{
    output({type:'system',subtype:'task_notification',task_id:'async-task',status:'completed',summary:'Background work complete'});
    done('background done');
   },100);return;
  }
  if(current==='subtasks-agent-alias'){
   output({type:'assistant',message:{id:'alias-message',content:[{type:'tool_use',id:'alias-tool',name:'Agent',input:{description:'Alias task'}}]}});
   output({type:'user',tool_use_result:{status:'async_launched',agentId:'alias-agent',description:'Alias task'},message:{content:[{type:'tool_result',tool_use_id:'alias-tool',content:'Launched successfully'}]}});
   output({type:'system',subtype:'task_started',task_id:'alias-agent',task_type:'local_agent',description:'Alias task'});
   output({type:'system',subtype:'task_notification',task_id:'alias-agent',status:'completed',summary:'Alias done'});
   done('alias done');return;
  }
  if(current==='subtasks-no-start'||current==='subtasks-remote-no-start'){
   const remote=current==='subtasks-remote-no-start';const taskId=remote?'remote-agent':'ack-only-agent';
   output({type:'assistant',message:{id:'ack-only-message',content:[{type:'tool_use',id:'ack-only-tool',name:'Agent',input:{description:'Acknowledged background task'}}]}});
   output({type:'user',tool_use_result:remote?{status:'remote_launched',taskId,description:'Remote background task'}:{status:'async_launched',agentId:taskId,description:'Acknowledged background task'},message:{content:[{type:'tool_result',tool_use_id:'ack-only-tool',content:'Background launch acknowledged'}]}});
   output({type:'result',uuid:'ack-only-intermediate',subtype:'success',result:'Waiting for acknowledged task',session_id:session});
   setTimeout(()=>{
    output({type:'system',subtype:'task_notification',task_id:taskId,status:'completed',summary:'Acknowledged task finished'});
    done('acknowledged background done');
   },150);return;
  }
  if(current==='subtasks-resumed-agent'){
   for(const tool of ['initial-agent-tool','resumed-agent-tool']){
    output({type:'assistant',message:{id:tool,content:[{type:'tool_use',id:tool,name:'Agent',input:{description:tool}}]}});
    output({type:'user',tool_use_result:{status:'async_launched',agentId:'shared-agent',description:tool},message:{content:[{type:'tool_result',tool_use_id:tool,content:'Launched'}]}});
    if(tool==='initial-agent-tool')output({type:'system',subtype:'task_notification',task_id:'shared-agent',tool_use_id:tool,status:'completed',summary:'Initial task done'});
   }
   output({type:'system',subtype:'task_updated',task_id:'shared-agent',patch:{description:'Resumed task still running'}});
   output({type:'result',uuid:'resumed-intermediate',subtype:'success',result:'Waiting for resumed task',session_id:session});
   const resumeTimer=setInterval(()=>{
    if(!fs.existsSync(require('node:path').join(require('node:path').dirname(process.argv[3]),'release-resumed')))return;
    clearInterval(resumeTimer);
    output({type:'system',subtype:'task_notification',task_id:'shared-agent',tool_use_id:'resumed-agent-tool',status:'completed',summary:'Resumed task done'});
    done('resumed background done');
   },20);return;
  }
  if(current==='subtasks-updated-only'){
   output({type:'system',subtype:'task_updated',task_id:'updated-agent',patch:{status:'pending',description:'Queued task'}});
   output({type:'system',subtype:'task_updated',task_id:'updated-agent',patch:{status:'running',description:'Running task'}});
   output({type:'system',subtype:'task_updated',task_id:'updated-agent',patch:{status:'paused',is_backgrounded:true}});
   output({type:'system',subtype:'task_started',task_id:'shell-task',task_type:'local_bash',description:'Background shell'});
   setTimeout(()=>{
    output({type:'system',subtype:'task_updated',task_id:'updated-agent',patch:{status:'completed'}});
    output({type:'system',subtype:'task_updated',task_id:'shell-task',patch:{status:'stopped'}});
    done('updated done');
   },100);return;
  }
  if(current==='subtasks-interrupt'||current==='subtasks-crash'||current==='subtasks-child'||current==='subtasks-child-approval'){
   output({type:'assistant',message:{id:'child-request',content:[{type:'tool_use',id:'child-agent',name:'Agent',input:{description:'Child task'}}]}});
   output({type:'system',subtype:'init',parent_tool_use_id:'child-agent',session_id:'11111111-1111-4111-8111-111111111111',model:'must-not-replace-parent',permissionMode:'acceptEdits'});
   output({type:'stream_event',parent_tool_use_id:'child-agent',event:{type:'message_start',message:{id:'child-stream'}}});
   if(current==='subtasks-child-approval'){
    pending={id:'permission-'+turn,question:true,input:{questions:[{question:'Which database?',options:[{label:'SQLite'}]}]}};
    output({type:'control_request',parent_tool_use_id:'child-agent',request_id:pending.id,request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',tool_use_id:'child-question',input:pending.input}});
    output({type:'stream_event',parent_tool_use_id:'child-agent',event:{type:'content_block_start',index:0,content_block:{type:'text',text:'Buffered child progress'}}});
    output({type:'system',subtype:'task_progress',task_id:'question-child',tool_use_id:'child-agent',summary:'Waiting for an answer'});return;
   }
   if(current==='subtasks-crash'){setTimeout(()=>process.exit(7),100);return;}
   if(current==='subtasks-interrupt')return;
   output({type:'system',subtype:'task_started',parent_tool_use_id:'child-agent',task_id:'nested-shell',task_type:'local_bash',description:'Nested shell'});
   output({type:'system',subtype:'task_notification',parent_tool_use_id:'child-agent',task_id:'nested-shell',status:'completed',summary:'Nested shell done'});
   output({type:'result',parent_tool_use_id:'child-agent',subtype:'success',result:'Child final report',session_id:'11111111-1111-4111-8111-111111111111'});
   done('parent done');return;
  }
  if(current==='subtasks-unknown'){
   output({type:'assistant',message:{id:'late-request',content:[{type:'tool_use',id:'late-tool',name:'Agent',input:{description:'Late task'}}]}});
   output({type:'user',message:{content:[{type:'tool_result',tool_use_id:'late-tool',content:'Remote task may have launched'}]}});
   done('unconfirmed work');return;
  }
  if(current==='subtasks-late-completion'){
   output({type:'system',subtype:'task_notification',task_id:'late-task',tool_use_id:'late-tool',status:'completed',summary:'Confirmed previous task'});
   for(let i=0;i<420;i++)output({type:'assistant',message:{id:'bounded-'+i,content:[{type:'text',text:'bounded history '+i}]}});
   done('late completion done');return;
  }
  if(current==='subtasks-overflow'){
   for(let i=0;i<201;i++)output({type:'system',subtype:'task_started',task_id:'overflow-'+i,description:'Task '+i});
   for(let i=0;i<200;i++)output({type:'system',subtype:'task_notification',task_id:'overflow-'+i,status:'completed'});
   output({type:'result',uuid:'overflow-intermediate',subtype:'success',result:'Visible tasks done; overflow still active',session_id:session});
   const overflowTimer=setInterval(()=>{
    if(!fs.existsSync(require('node:path').join(require('node:path').dirname(process.argv[3]),'release-overflow')))return;
    clearInterval(overflowTimer);
    output({type:'system',subtype:'task_notification',task_id:'overflow-200',status:'completed'});
    output({type:'system',subtype:'task_started',task_id:'overflow-200',description:'Late duplicate'});
    done('all tasks done');
   },20);return;
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
function setup(options: { initialFailure?: boolean; noTranscript?: boolean; honorIdentity?: boolean } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-'));
  const store = new StateStore(directory);
  const session: Session = { execution: { providerId: 'claude', mode: 'structured', conversationId: randomUUID() }, id: randomUUID(), projectId: randomUUID(), title: 'chat', kind: 'agent',  cwd: directory,  started: false, model: '', effort: 'default', permissionMode: 'default', status: 'idle', archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  store.change(state => state.sessions.push(session));
  const script = path.join(directory, 'fixture.cjs'); fs.writeFileSync(script, fixture);
  const record = path.join(directory, 'stdin.jsonl');
  const observedId = randomUUID(); const starts: boolean[] = [], launches: string[][] = [];
  const runtime = new ChatRuntime(store, () => {}, () => {}, { initializationTimeoutMs: 1500, controlTimeoutMs: 150, backgroundResultTimeoutMs: 80, transcriptExists: async () => !options.noTranscript && starts.length > 0, invocation: (session, caps, resumed) => { launches.push(chatArguments(session, caps, resumed)); starts.push(resumed); return { file: process.execPath, args: [script, options.honorIdentity ? session.execution.conversationId! : observedId, record, options.initialFailure && starts.length === 1 ? 'fail-init' : '', session.permissionMode] }; } });
  const sent = () => fs.readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { directory, store, session, runtime, starts, launches, observedId, sent, cleanup: async () => { await runtime.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('CLI update interrupts a running turn and permits explicit conversation resume after disconnection', async () => {
  const s = setup();
  try {
    const turn = s.runtime.send(s.session.id, 'hang', capabilities);
    await until(() => s.runtime.taskState(s.session.id) === 'thinking' && s.store.state.sessions[0].execution.conversationId === s.observedId);
    s.runtime.setMaintenance(true); await s.runtime.disconnectAll();
    assert.equal((await turn).interrupted, true); assert.equal(s.runtime.activeCount, 0);
    await assert.rejects(s.runtime.send(s.session.id, 'blocked', capabilities), /正在更新/);
    await assert.rejects(s.runtime.prepareCommands(s.session.id, capabilities), /正在更新/);
    s.runtime.setMaintenance(false);
    assert.equal((await s.runtime.send(s.session.id, 'follow up', capabilities)).success, true);
    assert.deepEqual(s.starts, [false, true]);
  } finally { await s.cleanup(); }
});
test('completed reusable processes release idle resources without losing completion or native resume identity', async () => {
  const s=setup();try{
    await s.runtime.send(s.session.id,'first turn',capabilities);
    const nativeId=s.store.state.sessions[0].execution.conversationId;
    assert.equal(s.runtime.isBusy(s.session.id),false);
    assert.equal(s.runtime.has(s.session.id),true);
    assert.equal(s.runtime.snapshot(s.session.id).taskState,'completed');
    const release=s.runtime.stopIdle(s.session.id);
    assert.equal(s.runtime.has(s.session.id),true,'directory ownership is retained during process-group shutdown');
    await release;
    assert.equal(s.runtime.has(s.session.id),false);
    assert.equal(s.store.state.sessions[0].taskState,'completed');
    assert.equal(s.runtime.snapshot(s.session.id).taskState,'completed');
    assert.equal(s.store.state.sessions[0].execution.conversationId,nativeId);
    assert.equal((await s.runtime.send(s.session.id,'follow up',capabilities)).success,true);
    assert.deepEqual(s.starts,[false,true]);
    assert.equal(s.runtime.snapshot(s.session.id).messages.filter(message=>message.role==='user').length,2);
  }finally{await s.cleanup();}
});

test('idle release rejects foreground, approval, and background turns without interrupting them',async()=>{
  const s=setup();try{
    for(const prompt of ['hang','approve','subtasks-interrupt']){
      const turn=s.runtime.send(s.session.id,prompt,capabilities);
      await until(()=>s.runtime.isBusy(s.session.id) && (prompt!=='approve'||s.runtime.taskState(s.session.id)==='waiting_approval') && fs.existsSync(path.join(s.directory,'stdin.jsonl')) && s.sent().some(message=>message.type==='user'&&message.message.content[0].text===prompt));
      assert.equal(s.runtime.isBusy(s.session.id),true);
      await assert.rejects(s.runtime.stopIdle(s.session.id),/正在执行/);
      assert.equal(s.runtime.has(s.session.id),true);
      await s.runtime.interrupt(s.session.id);assert.equal((await turn).interrupted,true);
    }
  }finally{await s.cleanup();}
});

test('accepted first prompts name default conversations once and never replace manual titles',async()=>{
  const s=setup();try{
    s.store.change(state=>{state.sessions[0].titleSource='default';state.sessions[0].title='新会话';});
    await s.runtime.send(s.session.id,'内部工作流模板：完成计划阶段',capabilities,[],'修复会话结束后的按钮状态');
    assert.equal(s.store.state.sessions[0].title,'修复会话结束后的按钮状态');
    assert.equal(s.store.state.sessions[0].titleSource,'auto');
    assert.equal(s.sent().find(message=>message.type==='user').message.content[0].text,'内部工作流模板：完成计划阶段');
    await s.runtime.send(s.session.id,'换一个话题',capabilities);
    assert.equal(s.store.state.sessions[0].title,'修复会话结束后的按钮状态');
    s.store.change(state=>{state.sessions[0].title='自定义标题';state.sessions[0].titleSource='manual';});
    await s.runtime.send(s.session.id,'再修改另一项',capabilities);
    assert.equal(s.store.state.sessions[0].title,'自定义标题');
  }finally{await s.cleanup();}
});

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
    assert.equal(s.store.state.sessions[0].execution.conversationId, s.observedId);
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
    const originalId=s.store.state.sessions[0].execution.conversationId;
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
    assert.equal(s.store.state.sessions[0].execution.conversationId,originalId);
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
    assert.equal(s.store.state.sessions[0].execution.conversationId, s.session.execution.conversationId);
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
    assert.equal(s.store.state.sessions[0].execution.conversationId, s.observedId);
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
    assert.equal(s.store.state.sessions[0].execution.conversationId, s.observedId);
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
    const file = path.join(transcripts, s.session.execution.conversationId + '.jsonl');
    const records = [
      { type: 'user', uuid: 'u1', cwd: s.directory, message: { content: '原始提问' }, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'assistant', uuid: 'a1', cwd: s.directory, message: { content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: '原始回复' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/a.ts' } }] } },
      { type: 'user', uuid: 'u2', cwd: s.directory, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'export const a=1;' }] } }
    ].map(record => JSON.stringify(record)).join('\n') + '\n';
    fs.writeFileSync(file, records); s.store.change(state => { state.sessions[0].execution.imported = true; });
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
    const file = path.join(transcripts, s.session.execution.conversationId + '.jsonl');
    const record = (type: string, uuid: string, text: string) => JSON.stringify({ type, uuid, cwd: s.directory, message: { content: text } }) + '\n';
    fs.writeFileSync(file, record('user', 'u1', 'original') + record('assistant', 'a1', 'same reply'));
    s.store.change(state => { state.sessions[0].execution.imported = true; });
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
  const second = { ...s.session, execution: { ...s.session.execution, conversationId: randomUUID() }, id: randomUUID() };
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

test('parallel subtask cards merge tool and lifecycle identities, preserve progress and resist terminal replays', async () => {
  const s = setup();
  try {
    const result = s.runtime.send(s.session.id, 'subtasks-parallel', capabilities);
    await until(() => s.store.state.sessions[0].subtasks?.tasks.length === 3 && s.store.state.sessions[0].subtasks?.tasks.every(task => task.status === 'running') === true && s.store.state.sessions[0].subtasks?.tasks[0].lastTool === 'Read');
    const running = s.store.state.sessions[0].subtasks!.tasks;
    assert.equal(running.filter(task => task.status === 'running').length, 3);
    assert.equal(running.find(task => task.taskId === 'task-a')?.lastTool, 'Read');
    assert.equal((await result).success, true);
    const tasks = s.store.state.sessions[0].subtasks!.tasks;
    assert.equal(tasks.length, 3);
    assert.deepEqual(tasks.map(task => task.status), ['completed', 'stopped', 'failed']);
    assert.equal(tasks[0].toolUseId, 'agent-a'); assert.equal(tasks[0].totalTokens, 240);
    assert.equal(tasks[0].progress, 'Reading tests'); assert.equal(tasks[0].summary, 'Review done');
    assert.equal(tasks[0].description, 'Review implementation');
    assert.ok(tasks.every(task => task.endedAt && task.kind === 'agent'));
  } finally { await s.cleanup(); }
});

test('foreground completion requires a final report or explicit foreground call; launch text stays unconfirmed', async () => {
  const s = setup();
  try {
    assert.equal((await s.runtime.send(s.session.id, 'subtasks-foreground', capabilities)).success, true);
    const tasks = s.store.state.sessions[0].subtasks!.tasks;
    assert.deepEqual(tasks.map(task => task.status), ['completed', 'unknown', 'completed']);
    assert.equal(tasks[2].agentId, 'agent-reported'); assert.equal(tasks[2].toolUses, 4);
    assert.equal(tasks[2].durationMs, 75); assert.equal(tasks[2].summary, 'Final report');
    assert.equal(s.runtime.isBusy(s.session.id), false);
  } finally { await s.cleanup(); }
});

test('background launch acknowledgement remains running until its lifecycle confirms completion', async () => {
  const s = setup();
  try {
    const result = s.runtime.send(s.session.id, 'subtasks-background-ack', capabilities);
    await until(() => s.runtime.snapshot(s.session.id).messages.some(message => message.text === 'Agent launched'));
    const tasks = s.store.state.sessions[0].subtasks!.tasks;
    assert.equal(tasks.length, 1); assert.equal(tasks[0].status, 'running'); assert.equal(tasks[0].background, true);
    assert.equal(tasks[0].agentId, 'async-agent'); assert.equal(s.runtime.isBusy(s.session.id), true);
    assert.equal((await result).summary, 'background done');
    assert.equal(s.store.state.sessions[0].subtasks!.tasks[0].status, 'completed');
  } finally { await s.cleanup(); }
});

test('Agent agentId and lifecycle task_id link without an optional tool_use_id', async () => {
  const s = setup();
  try {
    assert.equal((await s.runtime.send(s.session.id, 'subtasks-agent-alias', capabilities)).success, true);
    const tasks = s.store.state.sessions[0].subtasks!.tasks;
    assert.equal(tasks.length, 1); assert.equal(tasks[0].toolUseId, 'alias-tool');
    assert.equal(tasks[0].agentId, 'alias-agent'); assert.equal(tasks[0].taskId, 'alias-agent');
    assert.equal(tasks[0].status, 'completed');
  } finally { await s.cleanup(); }
});

test('authoritative async and remote Agent launches wait for completion even without task_started', async () => {
  for (const prompt of ['subtasks-no-start', 'subtasks-remote-no-start']) {
    const s = setup();
    try {
      const result = s.runtime.send(s.session.id, prompt, capabilities);
      await until(() => s.runtime.snapshot(s.session.id).messages.some(message => message.text === 'Waiting for acknowledged task'));
      assert.equal(s.runtime.isBusy(s.session.id), true);
      assert.equal(s.store.state.sessions[0].subtasks!.tasks.length, 1);
      assert.equal(s.store.state.sessions[0].subtasks!.tasks[0].status, 'running');
      assert.equal((await result).summary, 'acknowledged background done');
      const tasks = s.store.state.sessions[0].subtasks!.tasks;
      assert.equal(tasks.length, 1); assert.equal(tasks[0].status, 'completed');
    } finally { await s.cleanup(); }
  }
});

test('description-only updates retain the running status of a resumed agent sharing its previous agent id', async () => {
  const s = setup();
  try {
    const result = s.runtime.send(s.session.id, 'subtasks-resumed-agent', capabilities);
    await until(() => s.runtime.snapshot(s.session.id).messages.some(message => message.text === 'Waiting for resumed task'));
    const tasks = s.store.state.sessions[0].subtasks!.tasks;
    assert.equal(tasks.length, 2); assert.deepEqual(tasks.map(task => task.status), ['completed', 'running']);
    assert.equal(tasks[1].description, 'Resumed task still running'); assert.equal(s.runtime.isBusy(s.session.id), true);
    fs.writeFileSync(path.join(s.directory, 'release-resumed'), 'release');
    assert.equal((await result).summary, 'resumed background done');
    assert.ok(s.store.state.sessions[0].subtasks!.tasks.every(task => task.status === 'completed'));
  } finally { await s.cleanup(); }
});

test('task_updated alone exposes pending, running and paused states and settles completed or stopped tasks', async () => {
  const s = setup();
  try {
    const result = s.runtime.send(s.session.id, 'subtasks-updated-only', capabilities);
    await until(() => s.store.state.sessions[0].subtasks?.tasks.length === 2);
    assert.equal(s.store.state.sessions[0].subtasks!.tasks[0].status, 'paused');
    assert.equal(s.store.state.sessions[0].subtasks!.tasks[1].kind, 'shell');
    assert.equal((await result).success, true);
    assert.deepEqual(s.store.state.sessions[0].subtasks!.tasks.map(task => task.status), ['completed', 'stopped']);
  } finally { await s.cleanup(); }
});

test('child system events and results track nested work without changing parent identity, model or permission', async () => {
  const s = setup();
  try {
    assert.equal((await s.runtime.send(s.session.id, 'subtasks-child', capabilities)).summary, 'parent done');
    const tasks = s.store.state.sessions[0].subtasks!.tasks;
    assert.equal(tasks.length, 2); assert.ok(tasks.every(task => task.status === 'completed'));
    assert.equal(tasks[0].summary, 'Child final report'); assert.equal(tasks[1].parentToolUseId, 'child-agent');
    assert.equal(s.store.state.sessions[0].execution.conversationId, s.observedId);
    assert.equal(s.runtime.snapshot(s.session.id).model, 'fixture-model');
    assert.equal(s.store.state.sessions[0].permissionMode, 'default');
  } finally { await s.cleanup(); }
});

test('child task waiting for an answer stays waiting through buffered stream and progress frames', async () => {
  const s = setup();
  try {
    const result = s.runtime.send(s.session.id, 'subtasks-child-approval', capabilities);
    await until(() => s.store.state.sessions[0].subtasks?.tasks[0]?.progress === 'Waiting for an answer');
    assert.equal(s.store.state.sessions[0].subtasks!.tasks[0].status, 'waiting_input');
    await s.runtime.interrupt(s.session.id); assert.equal((await result).interrupted, true);
    assert.equal(s.store.state.sessions[0].subtasks!.tasks[0].status, 'interrupted');
  } finally { await s.cleanup(); }
});

test('interrupt and unexpected process exit settle active children without inventing successful completion', async () => {
  const s = setup();
  try {
    const interrupted = s.runtime.send(s.session.id, 'subtasks-interrupt', capabilities);
    await until(() => s.store.state.sessions[0].subtasks?.tasks[0]?.status === 'running');
    await s.runtime.interrupt(s.session.id); assert.equal((await interrupted).interrupted, true);
    assert.equal(s.store.state.sessions[0].subtasks!.tasks[0].status, 'interrupted');
    const crashed = await s.runtime.send(s.session.id, 'subtasks-crash', capabilities);
    assert.equal(crashed.success, false);
    assert.deepEqual(s.store.state.sessions[0].subtasks!.tasks.map(task => task.status), ['interrupted', 'failed']);
    await until(() => !s.runtime.has(s.session.id));
  } finally { await s.cleanup(); }
});

test('late completion retains its original turn and survives chat message projection truncation', async () => {
  const s = setup();
  try {
    await s.runtime.send(s.session.id, 'subtasks-unknown', capabilities);
    const firstTurn = s.store.state.sessions[0].subtasks!.turnId;
    assert.equal(s.store.state.sessions[0].subtasks!.tasks[0].status, 'unknown');
    await s.runtime.send(s.session.id, 'subtasks-late-completion', capabilities);
    const activity = s.store.state.sessions[0].subtasks!;
    assert.notEqual(activity.turnId, firstTurn); assert.equal(activity.tasks.length, 1);
    assert.equal(activity.tasks[0].turnId, firstTurn); assert.equal(activity.tasks[0].status, 'completed');
    assert.equal(activity.tasks[0].summary, 'Confirmed previous task');
    assert.equal(s.runtime.snapshot(s.session.id).messages.some(message => message.toolUseId === 'late-tool'), false);
  } finally { await s.cleanup(); }
});

test('background lifecycle remains accurate after the task display reaches its bounded row limit', async () => {
  const s = setup();
  try {
    const result = s.runtime.send(s.session.id, 'subtasks-overflow', capabilities);
    await until(() => s.runtime.snapshot(s.session.id).messages.some(message => message.text === 'Visible tasks done; overflow still active'));
    assert.equal(s.store.state.sessions[0].subtasks!.truncated, true);
    assert.equal(s.store.state.sessions[0].subtasks!.tasks.length, 200);
    assert.equal(s.runtime.isBusy(s.session.id), true);
    fs.writeFileSync(path.join(s.directory, 'release-overflow'), 'release');
    assert.equal((await result).summary, 'all tasks done');
    assert.equal(s.runtime.isBusy(s.session.id), false);
  } finally { await s.cleanup(); }
});

test('command discovery starts no model turn, preserves metadata, and sends slash arguments as a string', async () => {
  const s = setup(); try {
    await assert.rejects(s.runtime.send(s.session.id, '/context', capabilities, ['/nonexistent.png']), /移除附件/);
    assert.equal(s.runtime.has(s.session.id), false);
    await assert.rejects(s.runtime.send(s.session.id, '/resume other', capabilities), /工作台/);
    assert.equal(s.runtime.snapshot(s.session.id).taskState, 'idle');
    const snapshot = await s.runtime.prepareCommands(s.session.id, capabilities);
    assert.equal(snapshot.taskState, 'idle'); assert.equal(snapshot.messages.length, 0);
    assert.equal(snapshot.commands?.find(command => command.name === 'compact')?.kind, 'builtin');
    assert.equal(snapshot.commands?.find(command => command.name === 'compact')?.argumentHint, '[保留内容]');
    assert.equal(s.sent().filter(frame => frame.type === 'user').length, 0);
    await assert.rejects(s.runtime.send(s.session.id, '/resume other', capabilities), /工作台/);
    assert.equal((await s.runtime.send(s.session.id, '/team:review 参数', capabilities)).success, true);
    assert.equal(s.sent().find(frame => frame.type === 'user').message.content, '/team:review 参数');
    assert.deepEqual(s.runtime.snapshot(s.session.id).commands?.map(command => command.name), ['context', 'new-skill']);
    await s.runtime.stopIdle(s.session.id);
    assert.equal(s.runtime.snapshot(s.session.id).commands, undefined);
  } finally { await s.cleanup(); }
});

test('context tracks the latest root request, compaction completion, reports, reset identity and restart recovery', async () => {
  const s = setup(); try {
    await s.runtime.send(s.session.id, 'context-fixture', capabilities);
    const context = s.runtime.snapshot(s.session.id).context;
    assert.equal(context?.inputTokens, 45200); assert.equal(context?.contextWindow, 200000); assert.equal(context?.model, 'fixture-model');
    const compact = s.runtime.send(s.session.id, '/compact', capabilities);
    await until(() => s.runtime.snapshot(s.session.id).context?.status === 'compacting');
    await assert.rejects(s.runtime.send(s.session.id, '/context', capabilities), /上一轮/);
    assert.equal((await compact).success, true);
    assert.equal(s.runtime.snapshot(s.session.id).context?.status, 'compacted');
    assert.equal(s.runtime.snapshot(s.session.id).context?.inputTokens, undefined);
    assert.equal(s.runtime.snapshot(s.session.id).context?.lastCompaction?.preTokens, 45200);
    await s.runtime.send(s.session.id, '/context', capabilities);
    assert.equal(s.runtime.snapshot(s.session.id).context?.inputTokens, 12000);
    assert.equal(s.runtime.snapshot(s.session.id).context?.source, 'context-command');
    const history = new ChatHistory(s.directory, () => false);
    assert.equal(history.get(s.session.id).context?.inputTokens, 12000); history.flush();
    await s.runtime.send(s.session.id, '/clear', capabilities);
    assert.equal(s.store.state.sessions[0].execution.conversationId, '22222222-2222-4222-8222-222222222222');
    assert.equal(s.runtime.snapshot(s.session.id).context?.inputTokens, undefined);
    assert.ok(s.runtime.snapshot(s.session.id).messages.some(message => message.text === 'context-fixture'));
    assert.equal((await s.runtime.send(s.session.id, 'after clear', capabilities)).success, true);
    assert.equal(s.sent().filter(frame => frame.type === 'user').at(-1).session_id, '22222222-2222-4222-8222-222222222222');
  } finally { await s.cleanup(); }
});

test('confirmed clear survives restart before its new transcript exists and later missing history still fails closed', async () => {
  for (const command of ['/clear', '/clear result-only']) {
    const s = setup({ noTranscript: true, honorIdentity: true });
    let restarted: ChatRuntime | undefined;
    try {
      await s.runtime.send(s.session.id, 'before clear', capabilities);
      assert.equal(s.store.state.sessions[0].started, true);
      assert.equal((await s.runtime.send(s.session.id, command, capabilities)).success, true);
      const clearedId = s.store.state.sessions[0].execution.conversationId;
      assert.notEqual(clearedId, s.session.execution.conversationId);
      assert.equal(s.store.state.sessions[0].started, false);
      // Local reports need not create a transcript for this empty identity.
      await s.runtime.send(s.session.id, '/context', capabilities);
      assert.equal(s.store.state.sessions[0].started, false);
      await s.runtime.shutdown();
      const restored = new StateStore(s.directory);
      assert.equal(restored.state.sessions[0].started, false);
      const launches: string[][] = [];
      restarted = new ChatRuntime(restored, () => {}, () => {}, {
        transcriptExists: async () => false,
        invocation: (session, caps, resumed) => {
          launches.push(chatArguments(session, caps, resumed));
          return { file: process.execPath, args: [path.join(s.directory, 'fixture.cjs'), session.execution.conversationId!, path.join(s.directory, 'stdin.jsonl')] };
        },
      });
      // Opening the command menu also starts a process, before the next prompt.
      await restarted.prepareCommands(s.session.id, capabilities);
      assert.equal(launches[0][launches[0].indexOf('--session-id') + 1], clearedId);
      assert.ok(!launches[0].includes('--resume'));
      assert.equal((await restarted.send(s.session.id, 'after restart', capabilities)).success, true);
      assert.equal(restored.state.sessions[0].execution.conversationId, clearedId);
      assert.equal(restored.state.sessions[0].started, true);
      assert.ok(restarted.snapshot(s.session.id).messages.some(message => message.text === 'before clear'));
      await restarted.stopIdle(s.session.id);
      await assert.rejects(restarted.send(s.session.id, 'missing established history', capabilities), /未找到原会话记录/);
    } finally { await restarted?.shutdown(); await s.cleanup(); }
  }
});

test('rejected or same-identity clear cannot authorize a fresh fallback for an established conversation', async () => {
  for (const command of ['/clear fail', '/clear same-id']) {
    const s = setup({ noTranscript: true, honorIdentity: true });
    try {
      await s.runtime.send(s.session.id, 'established', capabilities);
      const original = s.store.state.sessions[0].execution.conversationId;
      await s.runtime.send(s.session.id, command, capabilities);
      assert.equal(s.store.state.sessions[0].started, true);
      assert.equal(s.store.state.sessions[0].execution.conversationId, original);
      await s.runtime.stopIdle(s.session.id);
      await assert.rejects(s.runtime.send(s.session.id, 'must not replace history', capabilities), /未找到原会话记录/);
    } finally { await s.cleanup(); }
  }
});

test('unsuccessful compaction keeps its last measurement and auto-compaction resumes with the next request', async () => {
  const s = setup(); try {
    await s.runtime.send(s.session.id, 'context-fixture', capabilities);
    assert.equal((await s.runtime.send(s.session.id, '/compact noop', capabilities)).success, true);
    assert.equal(s.runtime.snapshot(s.session.id).context?.lastCompaction, undefined);
    assert.equal((await s.runtime.send(s.session.id, '/compact fail', capabilities)).success, false);
    assert.equal(s.runtime.snapshot(s.session.id).context?.status, 'ready');
    assert.equal(s.runtime.snapshot(s.session.id).context?.inputTokens, 45200);
    await s.runtime.send(s.session.id, 'auto-compact', capabilities);
    assert.equal(s.runtime.snapshot(s.session.id).context?.lastCompaction?.trigger, 'auto');
    assert.equal(s.runtime.snapshot(s.session.id).context?.inputTokens, 8000);
    assert.equal(s.runtime.snapshot(s.session.id).context?.status, 'ready');
  } finally { await s.cleanup(); }
});
