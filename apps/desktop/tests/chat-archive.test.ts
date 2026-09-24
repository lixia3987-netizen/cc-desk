import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatArchive } from '../src/main/chat-archive';
import type { ChatMessage, ChatSnapshot } from '../src/shared/chat';

const message=(id:string,text=id,role:ChatMessage['role']='assistant'):ChatMessage=>({id,text,role,turnId:'turn',createdAt:'2026-09-22T00:00:00Z'});
async function fixture(){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-archive-')),id=randomUUID();
  const file=path.join(directory,id+'.jsonl'),archive=new ChatArchive(directory);
  const snapshot:ChatSnapshot={sessionId:id,taskState:'idle',messages:[],pending:[]};
  const append=(...events:Record<string,unknown>[])=>fs.appendFile(file,events.map(event=>JSON.stringify(event)+'\n').join(''));
  const seed=async(count:number)=>{await append(...Array.from({length:count},(_,i)=>({type:'message',message:message('m'+i)})));};
  return {directory,id,file,archive,snapshot,append,seed,dispose:()=>fs.rm(directory,{recursive:true,force:true})};
}
test('archive pages cover more than the 400-message live projection and cursors remain stable during appends',async()=>{
  const f=await fixture();try{
    await f.seed(525);f.snapshot.messages=Array.from({length:400},(_,i)=>message('m'+(i+125)));f.snapshot.truncated=true;
    let page=await f.archive.page(f.id,f.snapshot,{before:'m125'});
    assert.equal(page.messages.length,50);assert.equal(page.messages[0].id,'m75');assert.equal(page.messages.at(-1)!.id,'m124');assert.equal(page.incomplete,false);
    await f.append({type:'message',message:message('m525')});
    page=await f.archive.page(f.id,f.snapshot,{before:page.before!});assert.equal(page.messages[0].id,'m25');assert.equal(page.messages.at(-1)!.id,'m74');
    page=await f.archive.page(f.id,f.snapshot,{after:page.after!});assert.equal(page.messages[0].id,'m75');
    page=await f.archive.page(f.id,f.snapshot,{around:'m10'});assert.equal(page.before,null);assert(page.messages.some(m=>m.id==='m10'));
    await assert.rejects(f.archive.page(f.id,f.snapshot,{around:'missing'}),/找不到/);
  }finally{await f.dispose();}
});
test('search assembles interleaved deltas, respects replacements and preserves identical independent messages',async()=>{
  const f=await fixture();try{
    await f.append({type:'message',message:message('one','hello')},{type:'message',message:message('two','hello world')},{type:'text_delta',id:'one',text:' world'},
      {type:'message',message:message('replace','obsolete')},{type:'message',message:message('replace','revised')},
      {type:'message',message:{...message('tool','', 'tool'),toolName:'Read',input:{file_path:'needle.ts'}}});
    assert.deepEqual((await f.archive.search(f.id,f.snapshot,'HELLO WORLD')).hits.map(hit=>hit.id),['two','one']);
    assert.equal((await f.archive.search(f.id,f.snapshot,'obsolete')).hits.length,0);
    assert.equal((await f.archive.search(f.id,f.snapshot,'needle.ts')).hits[0].id,'tool');
    await f.append({type:'text_delta',id:'one',text:' again'});
    assert.equal((await f.archive.search(f.id,f.snapshot,'world again')).hits[0].id,'one');
    assert.deepEqual((await f.archive.page(f.id,f.snapshot)).messages.map(m=>m.id),['one','two','replace','tool']);
  }finally{await f.dispose();}
});
test('older proven result echoes stay removed in search and pages, including legacy snapshot fallbacks',async()=>{
  const f=await fixture();try{
    const original={...message('turn:main:reply:0','duplicate'),turnId:'turn'},echo=message(randomUUID(),'duplicate');
    await f.append({type:'message',message:original},{type:'result',success:true,summary:'duplicate'},{type:'message',message:echo},{type:'message',message:message('legitimate','duplicate')});
    f.snapshot.messages=[message('snapshot-only','legacy'),echo];
    assert.deepEqual((await f.archive.search(f.id,f.snapshot,'duplicate')).hits.map(m=>m.id),['legitimate',original.id]);
    assert.deepEqual((await f.archive.page(f.id,f.snapshot)).messages.map(m=>m.id),['snapshot-only',original.id,'legitimate']);
  }finally{await f.dispose();}
});
test('search continuation scans sparse segments and never mistakes a partial segment for no older matches',async()=>{
  const f=await fixture();try{
    await f.seed(1100);
    const first=await f.archive.search(f.id,f.snapshot,'m0');assert.equal(first.hits.length,0);assert.equal(first.nextBefore,'m100');
    const second=await f.archive.search(f.id,f.snapshot,'m0',first.nextBefore!);assert.equal(second.hits[0].id,'m0');assert.equal(second.nextBefore,null);
    const many=await f.archive.search(f.id,f.snapshot,'m');assert.equal(many.hits.length,50);
    const next=await f.archive.search(f.id,f.snapshot,'m',many.nextBefore!);assert.equal(next.hits[0].id,'m1049');
  }finally{await f.dispose();}
});
test('partial tails, broken records and transcript replacement have explicit and recoverable behavior',async()=>{
  const f=await fixture();try{
    await f.seed(2);await fs.appendFile(f.file,'broken\n{"type":"message",');
    assert.equal((await f.archive.page(f.id,f.snapshot)).incomplete,true);
    await fs.appendFile(f.file,'"message":'+JSON.stringify(message('tail','now complete'))+'}\n');
    assert.equal((await f.archive.search(f.id,f.snapshot,'now complete')).hits[0].id,'tail');
    await fs.rename(f.file,f.file+'.old');await f.append({type:'message',message:message('replacement')});
    const page=await f.archive.page(f.id,f.snapshot);assert.deepEqual(page.messages.map(m=>m.id),['replacement']);assert.equal(page.incomplete,false);
    f.snapshot.sourceIncomplete=true;assert.equal((await f.archive.page(f.id,f.snapshot)).incomplete,true);
  }finally{await f.dispose();}
});
test('pages stay within the IPC byte budget and include a distant long search match',async()=>{
  const f=await fixture();try{
    await f.append(...Array.from({length:60},(_,i)=>({type:'message',message:message('m'+i,'中'.repeat(20000)+'needle'+'文'.repeat(20000))})));
    const page=await f.archive.page(f.id,f.snapshot,{around:'m30',query:'needle'});
    assert(Buffer.byteLength(JSON.stringify(page))<1024*1024+10000);assert(page.messages.some(m=>m.id==='m30'&&m.text.includes('needle')));
    assert(page.messages.every(m=>m.truncated));
    const older=await f.archive.page(f.id,f.snapshot,{before:'m40'});assert.equal(older.messages.at(-1)?.id,'m39');
    const search=await f.archive.search(f.id,f.snapshot,'needle');assert(search.hits.every(m=>m.excerpt.includes('needle')));
  }finally{await f.dispose();}
});
test('snapshot-only legacy sessions are searchable and concurrent queries keep independent windows',async()=>{
  const f=await fixture();try{
    f.snapshot.messages=[message('legacy','legacy text')];f.snapshot.truncated=true;
    assert.equal((await f.archive.search(f.id,f.snapshot,'legacy')).hits[0].id,'legacy');
    assert.equal((await f.archive.page(f.id,f.snapshot)).incomplete,true);
    await f.seed(200);
    const [older,newer]=await Promise.all([f.archive.page(f.id,f.snapshot,{before:'m100'}),f.archive.page(f.id,f.snapshot,{after:'m100'})]);
    assert.equal(older.messages.at(-1)?.id,'m99');assert.equal(newer.messages[0]?.id,'m101');
  }finally{await f.dispose();}
});
