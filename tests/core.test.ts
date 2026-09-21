import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StateStore } from '../src/main/store';
import { claudeArguments, parseCapabilities } from '../src/main/commands';
import { sessionInputSchema, settingsSchema } from '../src/shared/schema';
import { TerminalBuffer } from '../src/main/runtime';
import type { Session } from '../src/shared/types';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(),'workbench-unit-'));
const session = (): Session => ({id:randomUUID(),projectId:randomUUID(),title:'测试',kind:'claude',cwd:'/tmp/项目 space',claudeId:randomUUID(),started:false,model:'',effort:'default',permissionMode:'default',status:'idle',archived:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
const cap = parseCapabilities('--session-id UUID\n--resume ID\n--fork-session\n--model ID\n--permission-mode default\n--effort <level> low medium high xhigh max ultracode','claude','v-test');

test('state persists atomically, creates a backup, and marks interrupted runs stopped', () => {
  const dir=temp();try {
    const store=new StateStore(dir);const s=session();
    store.change(state=>state.sessions.push(s));
    store.change(state=>{state.sessions[0].status='running';});
    assert.equal(new StateStore(dir).state.sessions[0].status,'stopped');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'workspace.json.bak'),'utf8')).sessions[0].status,'idle');
    assert.throws(()=>store.change(state=>{state.settings.maxSessions=0;}));
    assert.equal(store.state.settings.maxSessions,4);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('corrupt state is preserved instead of overwritten',()=>{
  const dir=temp();try{const file=path.join(dir,'workspace.json');fs.writeFileSync(file,'{broken');assert.throws(()=>new StateStore(dir),/原文件已保留/);assert.equal(fs.readFileSync(file,'utf8'),'{broken');}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('new session, resume, imported UUID, and first fork use distinct CLI arguments',()=>{
  const s=session();assert.deepEqual(claudeArguments(s,cap,false),['--session-id',s.claudeId,'--permission-mode','default']);
  assert.deepEqual(claudeArguments(s,cap,true),['--resume',s.claudeId,'--permission-mode','default']);
  s.imported=true;assert.equal(claudeArguments(s,cap,false)[0],'--resume');
  s.imported=false;s.resumeFrom=randomUUID();
  assert.deepEqual(claudeArguments(s,cap,false).slice(0,5),['--resume',s.resumeFrom,'--fork-session','--session-id',s.claudeId]);
  assert.equal(claudeArguments(s,cap,true).includes('--fork-session'),false);
});
test('arguments retain shell metacharacters as a single argument without interpolation',()=>{
  const s=session();s.model='test $(touch /tmp/should-not-exist); & "x"';
  const args=claudeArguments(s,cap,false);assert.equal(args.at(-1),s.model);assert.equal(args.length,6);
});
test('unsupported effort and flags fail explicitly; ultracode is never rewritten',()=>{
  const s=session();s.effort='ultracode';assert.equal(claudeArguments(s,cap,false).at(-1),'ultracode');
  assert.throws(()=>claudeArguments(s,{...cap,efforts:['default','high']},false),/未声明支持/);
  assert.throws(()=>claudeArguments(session(),{...cap,flags:[]},false),/不支持/);
  assert.deepEqual(parseCapabilities('--effort <level> low medium high','cli','1').efforts,['default','low','medium','high']);
  assert.deepEqual(parseCapabilities('--effort <level> Effort level for the current session\n    (low, medium, high, xhigh, max)\n  --model <id>','cli','2.1.278').efforts,['default','low','medium','high','xhigh','max']);
});
test('IPC validators reject path injection, invalid IDs, unsupported permission bypass and oversized limits',()=>{
  assert.equal(settingsSchema.safeParse({claudePath:'claude\nwhoami',shellPath:'',maxSessions:1,fontSize:14,scrollback:1000}).success,false);
  assert.equal(sessionInputSchema.safeParse({projectId:'../evil',title:'test',kind:'claude',model:'',effort:'max',permissionMode:'bypassPermissions',isolated:false}).success,false);
});
test('terminal buffer bounds retained output and assigns monotonically increasing sequence IDs',()=>{
  const buffer=new TerminalBuffer();for(let i=0;i<1500;i++)buffer.push('id','x'.repeat(1024));
  assert.ok(buffer.chunks.length<=1024);assert.equal(buffer.chunks.at(-1)!.seq,1500);assert.ok(buffer.chunks[0].seq>1);
  buffer.push('id','z'.repeat(2*1024*1024));assert.equal(buffer.chunks.length,1);assert.equal(buffer.chunks[0].data.length,1024*1024);
});
