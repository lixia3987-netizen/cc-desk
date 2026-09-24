import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageText } from '../src/renderer/MessageText';
import { SessionSelection } from '../src/renderer/selection';
import { ApprovalDrafts } from '../src/renderer/approval-drafts';
import type { ChatApproval } from '../src/shared/chat';

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
