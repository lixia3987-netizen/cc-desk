import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readHistory, transcriptExists, queryHistory, exportClaudeTranscript, historyCacheStats } from '../src/main/history';

test('history is project-scoped, tolerates incomplete JSONL, preserves original bytes and finds transcripts',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'workbench-history-'));
  const old=process.env.CLAUDE_CONFIG_DIR;process.env.CLAUDE_CONFIG_DIR=root;
  try{
    const dir=path.join(root,'projects','encoded-project');await fs.mkdir(dir,{recursive:true});
    const cwd=path.join(root,'中文 project');const id=randomUUID();const other=randomUUID();
    const original=JSON.stringify({type:'user',cwd,message:{content:[{type:'text',text:'恢复中文项目'}]}})+'\n{partial';
    const file=path.join(dir,id+'.jsonl');await fs.writeFile(file,original);
    await fs.writeFile(path.join(dir,other+'.jsonl'),JSON.stringify({type:'user',cwd:'/another-project',message:{content:'private other project'}}));
    const result=await readHistory(cwd);assert.equal(result.length,1);assert.equal(result[0].id,id);assert.equal(result[0].title,'恢复中文项目');
    assert.equal(result[0].providerId,'claude');
    assert.equal(await fs.readFile(file,'utf8'),original);assert.equal(await transcriptExists(id),true);assert.equal(await transcriptExists(randomUUID()),false);
  }finally{if(old===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=old;await fs.rm(root,{recursive:true,force:true});}
});

test('older project transcripts remain discoverable behind 510 newer unrelated sessions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-history-old-'));
  const old = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = root;
  try {
    const directory = path.join(root, 'projects', 'many-projects'); await fs.mkdir(directory, { recursive: true });
    const cwd = path.join(root, 'older-project'); const id = randomUUID();
    const file = path.join(directory, id + '.jsonl');
    await fs.writeFile(file, JSON.stringify({ type: 'user', cwd, message: { content: 'older session' } }));
    await fs.utimes(file, new Date(1), new Date(1));
    await Promise.all(Array.from({ length: 510 }, () => fs.writeFile(path.join(directory, randomUUID() + '.jsonl'), JSON.stringify({ type: 'user', cwd: '/another-project', message: { content: 'newer' } }))));
    assert.deepEqual((await readHistory(cwd)).map(entry => entry.id), [id]);
  } finally { if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old; await fs.rm(root, { recursive: true, force: true }); }
});

test('full-text query covers late transcript content, paginates within project and invalidates changed index', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-history-query-'));
  const old = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = root;
  try {
    const directory = path.join(root, 'projects', 'project'); await fs.mkdir(directory, { recursive: true });
    const cwd = path.join(root, 'project'); const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, id] of ids.entries()) {
      await fs.writeFile(path.join(directory, id + '.jsonl'), [
        JSON.stringify({ type: 'user', cwd, message: { content: 'title ' + index } }),
        JSON.stringify({ type: 'assistant', message: { content: 'padding'.repeat(20000) } }),
        '{broken',
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '最终 检索标记' }] } })
      ].join('\n'));
      await fs.utimes(path.join(directory, id + '.jsonl'), new Date(index * 1000), new Date(index * 1000));
    }
    const page = await queryHistory(cwd, { query: '检索标记', limit: 2 });
    assert.ok(page.entries.every(entry => entry.providerId === 'claude'));
    assert.deepEqual(page.entries.map(entry => entry.id), [ids[2], ids[1]]);
    assert.equal(page.total, 3); assert.equal(page.nextOffset, 2);
    const last = await queryHistory(cwd, { query: '检索标记', offset: page.nextOffset!, limit: 2 });
    assert.deepEqual(last.entries.map(entry => entry.id), [ids[0]]); assert.equal(last.nextOffset, null);
    await fs.appendFile(path.join(directory, ids[0] + '.jsonl'), '\n' + JSON.stringify({ type: 'custom-title', customTitle: 'changed title' }));
    assert.equal((await queryHistory(cwd, { query: 'changed title' })).entries[0].title, 'changed title');
    assert.equal((await queryHistory(path.join(root, 'unrelated'), { query: '检索标记' })).total, 0);
  } finally { if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old; await fs.rm(root, { recursive: true, force: true }); }
});

test('raw transcript export preserves every byte, isolates malformed lines and cannot overwrite its source', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-history-export-'));
  const old = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = root;
  try {
    const directory = path.join(root, 'projects', 'project'); await fs.mkdir(directory, { recursive: true });
    const cwd = path.join(root, 'project'); const id = randomUUID(); const source = path.join(directory, id + '.jsonl');
    const original = [JSON.stringify({ type: 'user', cwd, message: { content: '中文' } }), '{bad', 'null', JSON.stringify({ type: 'assistant', message: { content: 'z'.repeat(200000) } }), '{partial'].join('\n');
    await fs.writeFile(source, original);
    const destination = path.join(root, 'export.jsonl');
    const summary = await exportClaudeTranscript(cwd, id, destination);
    assert.equal(summary.bytes, Buffer.byteLength(original)); assert.equal(summary.validRecords, 2); assert.equal(summary.malformedLines, 3);
    assert.equal(await fs.readFile(destination, 'utf8'), original); assert.equal(await fs.readFile(source, 'utf8'), original);
    await assert.rejects(exportClaudeTranscript(cwd, id, source), /不能覆盖/);
    const alias = path.join(root, 'alias.jsonl'); await fs.link(source, alias);
    await assert.rejects(exportClaudeTranscript(cwd, id, alias), /不能覆盖/);
    await assert.rejects(exportClaudeTranscript('/wrong-project', id, destination), /未找到/);
    assert.equal(await transcriptExists('../bad'), false);
  } finally { if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old; await fs.rm(root, { recursive: true, force: true }); }
});

test('history beyond metadata capacity reuses pages and preserves cached metadata across sequential scans',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'history-cache-capacity-'));
  const old=process.env.CLAUDE_CONFIG_DIR;process.env.CLAUDE_CONFIG_DIR=root;
  try {
    const folder=path.join(root,'projects','large');await fs.mkdir(folder,{recursive:true});
    const cwd=path.join(root,'project');
    const ids=Array.from({length:5000},()=>randomUUID());
    for(let start=0;start<ids.length;start+=100)await Promise.all(ids.slice(start,start+100).map(id=>fs.writeFile(path.join(folder,id+'.jsonl'),JSON.stringify({type:'user',cwd,message:{content:'unchanged transcript'}}))));
    const first=await queryHistory(cwd,{limit:50});assert.equal(first.total,5000);
    const reads=historyCacheStats().parsedFiles;
    const next=await queryHistory(cwd,{offset:50,limit:50});assert.equal(next.entries.length,50);
    assert.equal(historyCacheStats().parsedFiles,reads,'unchanged pagination must not parse transcripts again');
    first.entries[0].title='caller mutation';
    assert.notEqual((await queryHistory(cwd)).entries[0].title,'caller mutation');
    await fs.appendFile(path.join(folder,ids[0]+'.jsonl'),'\n'+JSON.stringify({type:'custom-title',customTitle:'new title'}));
    const changed=await queryHistory(cwd,{query:'new title'});
    assert.equal(changed.entries[0].id,ids[0]);
    assert.ok(historyCacheStats().parsedFiles-reads<=5000-2048+1,'cache hits must survive new misses within the scan');
    assert.ok(historyCacheStats().metadataEntries<=2048);assert.ok(historyCacheStats().queryEntries<=20000);
    // A second population just over the boundary catches the original all-miss cycle.
    for(let start=2049;start<ids.length;start+=100)await Promise.all(ids.slice(start,start+100).map(id=>fs.rm(path.join(folder,id+'.jsonl'))));
    assert.equal((await queryHistory(cwd)).total,2049);
    const after=historyCacheStats().parsedFiles;
    await queryHistory(cwd,{offset:50});assert.equal(historyCacheStats().parsedFiles,after);
  }finally{if(old===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=old;await fs.rm(root,{recursive:true,force:true});}
});
