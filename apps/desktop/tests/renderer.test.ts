import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageText } from '../src/renderer/MessageText';
import { SessionSelection } from '../src/renderer/selection';
import { ApprovalDrafts } from '../src/renderer/approval-drafts';
import type { ChatApproval } from '../src/shared/chat';
import { EngineConfigFields, configurationSupported, engineDefaults, executionUnavailable } from '../src/renderer/EngineConfiguration';
import type { EngineConfig, ExecutionDescriptor } from '../src/shared/execution';
import type { Session, Settings } from '../src/shared/types';

const render=(text:string)=>renderToStaticMarkup(createElement(MessageText,{text}));
test('Markdown fences close only at valid boundaries and support longer enclosing fences',()=>{
  const embedded=render('```js\nconst marker = "```";\nconst after = 42;\n```\n\nOutside');
  assert.equal((embedded.match(/class="message-code"/g)??[]).length,1);
  assert.match(embedded,/marker/);assert.match(embedded,/after/);assert.match(embedded,/<\/pre>.*<p>Outside<\/p>/s);
  const enclosing=render('````markdown\n```js\ninside\n```\n````\n\nOutside');
  assert.equal((enclosing.match(/class="message-code"/g)??[]).length,1);assert.match(enclosing,/```js/);assert.match(enclosing,/<\/pre>.*<p>Outside<\/p>/s);
  const inline=render('A ```literal ` code``` marker.');assert.doesNotMatch(inline,/class="message-code"/);assert.match(inline,/<code>literal ` code<\/code>/);
});
test('Markdown renders GFM tables, safe links, highlighted code and never raw HTML',()=>{
  const html=render('| Name | Value |\n| --- | --- |\n| A | B |\n\n[Docs](https://example.com)\n\n[Bad](javascript:alert%281%29)\n\n<img src=x onerror="alert(1)">\n\n```js\nconst value = 42;\n```');
  assert.match(html,/<table>/);assert.match(html,/href="https:\/\/example.com"/);assert.doesNotMatch(html,/href="javascript:/);assert.doesNotMatch(html,/<img|<script/);assert.match(html,/&lt;img src=x onerror=/);assert.match(html,/hljs-keyword/);assert.match(html,/aria-label="复制代码"/);
});
test('optimistic selection ignores stale local acknowledgements and handles external navigation',()=>{
  const selection=new SessionSelection();assert.equal(selection.receive('A'),'A');
  selection.request('B');selection.request('C');assert.equal(selection.receive('B'),undefined);assert.equal(selection.receive('C'),undefined);
  assert.equal(selection.receive('archived-other-project'),'archived-other-project');
  selection.request('B');assert.equal(selection.receive('notification'),'notification');assert.equal(selection.receive('B'),undefined);
  assert.equal(selection.receive(''), '');
  selection.request('old-local');selection.navigate('notification');assert.equal(selection.receive('old-local'),undefined);assert.equal(selection.receive('notification'),'notification');
});
test('approval drafts isolate session and request keys and clean only resolved or removed entries',()=>{
  const drafts=new ApprovalDrafts(),question={requestId:'request',kind:'question',toolName:'AskUserQuestion',input:{},createdAt:''} as ChatApproval;
  drafts.set('A','request',{answers:{database:'SQLite'},reason:'keep this note'});drafts.set('B','request',{answers:{database:'Postgres'},reason:''});drafts.set('A','old',{answers:{},reason:'expired'});
  drafts.reconcile('A',[question]);assert.deepEqual(drafts.get('A','request'),{answers:{database:'SQLite'},reason:'keep this note'});assert.equal(drafts.get('A','old').reason,'');assert.equal(drafts.get('B','request').answers.database,'Postgres');
  drafts.delete('A','request');assert.equal(drafts.has('A'),false);drafts.retainSessions(['A']);assert.equal(drafts.has('B'),false);
});

test('provider defaults materialize independent configs while unknown selected values remain visible',()=>{
  const descriptor:ExecutionDescriptor={providerId:'test.native',mode:'structured',displayName:'测试引擎',
    capabilities:{available:true,structured:true,terminal:false,approvals:false,resume:true,fork:false,commands:false,contextUsage:false,liveConfig:true,attachments:false},
    configuration:{schemaVersion:7,defaults:{schemaVersion:7,options:{style:'terse',route:'factory'}},fields:[{key:'style',label:'回复风格',type:'select',options:[{value:'terse',label:'简短'}]}]}};
  const settings:Settings={claudePath:'',shellPath:'',maxSessions:4,fontSize:14,scrollback:8000,engineDefaults:{
    claude:{schemaVersion:1,options:{permissionMode:'plan'}},'test.native':{schemaVersion:7,options:{style:'future-choice',route:'saved'}}}};
  const config=engineDefaults(descriptor,settings);
  assert.deepEqual(config,{schemaVersion:7,options:{style:'future-choice',route:'saved'}});
  config.options.route='session-only';assert.equal(settings.engineDefaults['test.native'].options.route,'saved');
  assert.equal(Object.hasOwn(config.options,'permissionMode'),false);
  const html=renderToStaticMarkup(createElement(EngineConfigFields,{value:config,fields:descriptor.configuration!.fields,onChange:()=>{throw new Error('Rendering must not coerce config');}}));
  assert.match(html,/<option value="future-choice" selected="">future-choice · 当前保存值<\/option>/);
  const nested:EngineConfig={schemaVersion:7,options:{style:{future:['preserve',7]}}};
  const preserved=renderToStaticMarkup(createElement(EngineConfigFields,{value:nested,fields:descriptor.configuration!.fields,onChange:()=>{throw new Error('Unsupported values must stay intact');}}));
  assert.match(preserved,/<select[^>]+disabled=""/);assert.match(preserved,/原始配置已保留/);
  assert.deepEqual(nested.options.style,{future:['preserve',7]});
});

test('engine presentation distinguishes missing adapter, unsupported config, maintenance and discovery',()=>{
  const session={execution:{providerId:'test.native',mode:'structured'},engineConfig:{schemaVersion:7,options:{}}} as Session;
  const descriptor:ExecutionDescriptor={providerId:'test.native',mode:'structured',displayName:'测试引擎',
    capabilities:{available:false,error:'该引擎离线',structured:true,terminal:false,approvals:true,resume:true,fork:false,commands:false,contextUsage:false,liveConfig:true,attachments:false},
    configuration:{schemaVersion:7,defaults:session.engineConfig,fields:[]}};
  assert.match(executionUnavailable(undefined,session)!,/未安装.*test.native/);
  assert.equal(configurationSupported(descriptor,session.engineConfig),true);
  assert.equal(executionUnavailable(descriptor,session),'该引擎离线');
  assert.match(executionUnavailable({...descriptor,maintenance:true},session)!,/正在维护/);
  assert.match(executionUnavailable(descriptor,{...session,engineConfig:{schemaVersion:99,options:{}}})!,/配置版本 99/);
  assert.equal(configurationSupported({...descriptor,configuration:undefined},{schemaVersion:0,options:{}}),false);
});
