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
test('IPC validators reject path injection, invalid IDs and unsupported permission modes',()=>{
  assert.equal(settingsSchema.safeParse({claudePath:'claude\nwhoami',shellPath:'',maxSessions:1,fontSize:14,scrollback:1000}).success,false);
  assert.equal(sessionInputSchema.safeParse({projectId:'../evil',title:'test',kind:'claude',model:'',effort:'max',permissionMode:'bypassPermissions',isolated:false}).success,false);
  const input={projectId:randomUUID(),title:'test',kind:'claude',model:'',effort:'default',isolated:false};
  assert.equal(sessionInputSchema.safeParse({...input,permissionMode:'bypassPermissions'}).success,true);
  assert.equal(sessionInputSchema.safeParse(input).success,true);
  for(const permissionMode of ['auto','unknown','bypassPermissions --model injected']) {
    assert.equal(sessionInputSchema.safeParse({...input,permissionMode}).success,false);
    assert.equal(settingsSchema.safeParse({claudePath:'',shellPath:'',maxSessions:1,fontSize:14,scrollback:1000,defaultPermissionMode:permissionMode}).success,false);
  }
});
test('old settings retain manual approval and explicit bypass defaults and sessions survive restart',()=>{
  const dir=temp();try{
    const oldSettings={claudePath:'',shellPath:'',maxSessions:4,fontSize:14,scrollback:8000};
    fs.writeFileSync(path.join(dir,'workspace.json'),JSON.stringify({version:1,projects:[],sessions:[session()],settings:oldSettings}));
    const store=new StateStore(dir);
    assert.equal(store.state.settings.defaultPermissionMode,'default');
    store.change(state=>{state.settings.defaultPermissionMode='bypassPermissions';});
    let restored=new StateStore(dir);
    assert.equal(restored.state.settings.defaultPermissionMode,'bypassPermissions');
    assert.equal(restored.state.sessions[0].permissionMode,'default');
    restored.change(state=>{state.sessions[0].permissionMode='bypassPermissions';state.settings.defaultPermissionMode='plan';});
    restored=new StateStore(dir);
    assert.equal(restored.state.settings.defaultPermissionMode,'plan');
    assert.equal(restored.state.sessions[0].permissionMode,'bypassPermissions');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('launch and resume pass only the explicitly selected permission mode to the CLI',()=>{
  for(const permissionMode of ['default','plan','acceptEdits','bypassPermissions'] as const){
    const s={...session(),permissionMode};
    assert.deepEqual(claudeArguments(s,cap,false),['--session-id',s.claudeId,'--permission-mode',permissionMode]);
    assert.deepEqual(claudeArguments(s,cap,true),['--resume',s.claudeId,'--permission-mode',permissionMode]);
  }
});
test('IDE preference migrates old settings, persists a custom application and can be cleared',()=>{
  const dir=temp();try{
    const oldSettings={claudePath:'',shellPath:'',maxSessions:4,fontSize:14,scrollback:8000};
    fs.writeFileSync(path.join(dir,'workspace.json'),JSON.stringify({version:1,projects:[],sessions:[session()],settings:oldSettings}));
    const store=new StateStore(dir);
    assert.equal(store.state.settings.idePath,'');
    const idePath='C:\\Apps\\定制 VS Code\\Code.exe';
    store.change(state=>{state.settings.idePath=idePath;});
    const restored=new StateStore(dir);
    assert.equal(restored.state.settings.idePath,idePath);
    assert.equal(restored.state.sessions.length,1);
    // A missing application can be repaired in settings later; it must not block loading the workspace.
    for(const invalid of ['app\0.exe','app\n.exe','app\t.exe','x'.repeat(4097)]){
      assert.throws(()=>restored.change(state=>{state.settings.idePath=invalid;}));
      assert.equal(new StateStore(dir).state.settings.idePath,idePath);
    }
    restored.change(state=>{state.settings.idePath='';});
    assert.equal(new StateStore(dir).state.settings.idePath,'');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('terminal buffer bounds retained output and assigns monotonically increasing sequence IDs',()=>{
  const buffer=new TerminalBuffer();for(let i=0;i<1500;i++)buffer.push('id','x'.repeat(1024));
  assert.ok(buffer.chunks.length<=1024);assert.equal(buffer.chunks.at(-1)!.seq,1500);assert.ok(buffer.chunks[0].seq>1);
  buffer.push('id','z'.repeat(2*1024*1024));assert.equal(buffer.chunks.length,1);assert.equal(buffer.chunks[0].data.length,1024*1024);
});

test('unchanged state does not rewrite files or rotate the backup', () => {
  const dir = temp();
  try {
    const store = new StateStore(dir); const initial = session();
    store.change(state => state.sessions.push(initial));
    store.change(state => { state.sessions[0].title = 'changed'; });
    const before = fs.statSync(store.file); const backup = fs.readFileSync(store.file + '.bak', 'utf8');
    const current = store.state;
    assert.equal(store.change(state => { state.sessions[0].title = 'changed'; }), false);
    assert.equal(store.state, current);
    assert.equal(fs.statSync(store.file).mtimeMs, before.mtimeMs);
    assert.equal(fs.readFileSync(store.file + '.bak', 'utf8'), backup);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('deferred observations batch into one snapshot and critical changes durably include them', () => {
  const dir = temp(); const store = new StateStore(dir, { writeDelayMs: 10000 });
  try {
    store.change(state => state.sessions.push(session()));
    for (let i = 0; i < 25; i++) store.change(state => { state.sessions[0].draft = `draft-${i}`; }, { defer: true });
    assert.equal(store.state.sessions[0].draft, 'draft-24');
    assert.equal(JSON.parse(fs.readFileSync(store.file, 'utf8')).sessions[0].draft, undefined);
    assert.equal(fs.existsSync(store.file + '.bak'), false);
    store.flush();
    assert.equal(JSON.parse(fs.readFileSync(store.file, 'utf8')).sessions[0].draft, 'draft-24');
    assert.equal(JSON.parse(fs.readFileSync(store.file + '.bak', 'utf8')).sessions[0].draft, undefined);
    store.change(state => { state.sessions[0].draft = 'newest'; }, { defer: true });
    store.change(state => { state.sessions[0].permissionMode = 'plan'; });
    const persisted = JSON.parse(fs.readFileSync(store.file, 'utf8'));
    assert.equal(persisted.sessions[0].draft, 'newest');
    assert.equal(persisted.sessions[0].permissionMode, 'plan');
    const backup = fs.readFileSync(store.file + '.bak', 'utf8');
    store.flush();
    assert.equal(fs.readFileSync(store.file + '.bak', 'utf8'), backup);
  } finally { store.flush(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed deferred persistence reports the error and retains validated state for explicit retry', { timeout: 5000 }, async () => {
  const dir = temp(); let failed!: (error: Error) => void;
  let deadline!: NodeJS.Timeout;
  // Production flush timers intentionally do not keep an exiting app alive.
  // Keep this test's wait alive, while still failing if error reporting never occurs.
  const failure = new Promise<Error>((resolve, reject) => {
    failed = resolve;
    deadline = setTimeout(() => reject(new Error('Deferred persistence did not report its failure.')), 4000);
  });
  const store = new StateStore(dir, { writeDelayMs: 10, onError: failed });
  try {
    store.change(state => state.sessions.push(session()));
    fs.mkdirSync(store.file + '.tmp');
    store.change(state => { state.sessions[0].draft = 'recoverable'; }, { defer: true });
    const error = await failure;
    assert.equal(store.persistenceError, error);
    assert.equal(store.state.sessions[0].draft, 'recoverable');
    assert.equal(JSON.parse(fs.readFileSync(store.file, 'utf8')).sessions[0].draft, undefined);
    assert.throws(() => store.change(state => { state.sessions[0].permissionMode = 'plan'; }));
    assert.equal(store.state.sessions[0].permissionMode, 'default', 'critical failure does not commit in-memory state');
    fs.rmdirSync(store.file + '.tmp');
    store.flush();
    assert.equal(store.persistenceError, undefined);
    assert.equal(JSON.parse(fs.readFileSync(store.file, 'utf8')).sessions[0].draft, 'recoverable');
  } finally { clearTimeout(deadline); fs.rmSync(store.file + '.tmp', { recursive: true, force: true }); store.flush(); fs.rmSync(dir, { recursive: true, force: true }); }
});
