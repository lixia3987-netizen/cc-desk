import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readHistory, transcriptExists } from '../src/main/history';

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
    assert.equal(await fs.readFile(file,'utf8'),original);assert.equal(await transcriptExists(id),true);assert.equal(await transcriptExists(randomUUID()),false);
  }finally{if(old===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=old;await fs.rm(root,{recursive:true,force:true});}
});
