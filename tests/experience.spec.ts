import { test, expect, _electron as electron, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { AppState, Session } from '../src/shared/types';
import type { ChatSnapshot } from '../src/shared/chat';

async function workspace() {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-desk-experience-'));
  const data=path.join(directory,'data'),now=new Date().toISOString();
  const projects=['项目 A','项目 B'].map(name=>({id:randomUUID(),name,path:path.join(directory,name),createdAt:now}));
  for(const project of projects){
    await fs.mkdir(project.path);
    project.path=await fs.realpath(project.path);
    const git=(...args:string[])=>execFileSync('git',args,{cwd:project.path,stdio:'pipe'});
    git('init','--quiet');git('config','user.name','Experience Fixture');git('config','user.email','test@example.invalid');
    await fs.writeFile(path.join(project.path,'one.txt'),'original one\n');await fs.writeFile(path.join(project.path,'two.txt'),'original two\n');
    git('add','.');git('commit','--quiet','-m','fixture');
  }
  const sessions:Session[]=[
    {title:'长对话 B',kind:'claude',adapter:'structured'}, {title:'短对话 B',kind:'claude',adapter:'structured'},
    {title:'CLI 终端 B',kind:'claude',adapter:'terminal'}, {title:'Shell B',kind:'shell',adapter:'terminal'},
  ].map(value=>({...value,id:randomUUID(),projectId:projects[1].id,cwd:projects[1].path,claudeId:randomUUID(),started:false,
    model:'',effort:'default',permissionMode:'default',status:'idle',taskState:'idle',archived:false,createdAt:now,updatedAt:now} as Session));
  const state:AppState={version:1,projects,sessions,selectedSessionId:sessions[0].id,
    settings:{claudePath:path.join(directory,'unavailable-claude'),shellPath:'',maxSessions:4,fontSize:14,scrollback:8000}};
  await fs.mkdir(path.join(data,'chat'),{recursive:true});
  await fs.writeFile(path.join(data,'workspace.json'),JSON.stringify(state));
  for(let index=0;index<2;index++){
    const snapshot:ChatSnapshot={sessionId:sessions[index].id,taskState:'idle',pending:[],messages:Array.from({length:index===0?90:2},(_,i)=>({
      id:'message-'+i,turnId:'turn-'+i,role:i%2?'assistant':'user',createdAt:now,
      text:`第 ${i+1} 条消息\n\n用于验证切换会话时的阅读位置。\n\n\`\`\`typescript\nconst value = ${i};\n\`\`\``,
    }))};
    await fs.writeFile(path.join(data,'chat',sessions[index].id+'.json'),JSON.stringify(snapshot));
  }
  const launch=()=>electron.launch({args:['.',...(process.platform==='linux'?['--no-sandbox',`--ozone-platform=${process.env.DISPLAY?'x11':'headless'}`,'--disable-gpu']:[])],
    env:{...process.env,WORKBENCH_TEST_MODE:'1',WORKBENCH_DATA_DIR:data}});
  return {directory,data,projects,sessions,launch,dispose:()=>fs.rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100})};
}

const select=(page:Page,title:string)=>page.locator('.session-row').filter({hasText:title}).click();
const tab=(page:Page,name:string)=>page.getByRole('tab',{name,exact:true}).click();

async function settleReading(page:Page){
  await page.evaluate(()=>document.fonts.ready.then(()=>undefined));
  await page.locator('.chat-scroll').evaluate(async element=>{
    let previous='',stable=0;
    for(let i=0;i<180&&stable<8;i++){
      await new Promise(resolve=>requestAnimationFrame(resolve));
      const current=element.scrollTop+':'+element.scrollHeight+':'+element.clientHeight;
      stable=current===previous?stable+1:0;previous=current;
    }
  });
}

test('experience: panel drafts keep session/file identity, tab state and unsaved edits across restart',async()=>{
  const f=await workspace();let app=await f.launch();
  try{
    let page=await app.firstWindow();
    await expect(page.getByRole('heading',{name:'长对话 B',exact:true})).toBeVisible();
    await tab(page,'工作流');await page.getByLabel('工作流目标').fill('已提交的工作流目标');
    await page.getByRole('button',{name:'创建工作流',exact:true}).click();await expect(page.locator('.workflow-run')).toHaveCount(1);
    await expect(page.getByLabel('工作流目标')).toHaveValue('');
    await page.getByLabel('工作流目标').fill('下一项任务的草稿');
    await page.getByLabel('每阶段结束后由我确认继续').uncheck();await page.getByLabel('最大尝试次数').selectOption('3');
    await page.getByRole('button',{name:'编辑阶段指令',exact:true}).first().click();await page.getByLabel('阶段指令').fill('尚未保存的阶段指令');
    await fs.writeFile(path.join(f.projects[1].path,'one.txt'),'changed one\n');await fs.writeFile(path.join(f.projects[1].path,'two.txt'),'changed two\n');
    await tab(page,'变更');await page.locator('.changed-files button').filter({hasText:'one.txt'}).click();
    await page.getByLabel('代码审阅反馈').fill('one 的审阅意见');
    await page.locator('.changed-files button').filter({hasText:'two.txt'}).click();await expect(page.getByLabel('代码审阅反馈')).toHaveValue('');
    await page.getByLabel('代码审阅反馈').fill('two 的审阅意见');await page.getByRole('button',{name:'已暂存',exact:true}).click();
    await tab(page,'工作流');await expect(page.getByLabel('工作流目标')).toHaveValue('下一项任务的草稿');
    await expect(page.getByLabel('阶段指令')).toHaveValue('尚未保存的阶段指令');await expect(page.getByLabel('最大尝试次数')).toHaveValue('3');
    await expect(page.getByLabel('每阶段结束后由我确认继续')).not.toBeChecked();
    await select(page,'短对话 B');await expect(page.getByLabel('工作流目标')).toHaveValue('');
    await expect(page.getByLabel('每阶段结束后由我确认继续')).toBeChecked();await expect(page.getByLabel('最大尝试次数')).toHaveValue('2');
    await page.getByLabel('工作流目标').fill('另一个会话的草稿');await select(page,'长对话 B');
    await tab(page,'变更');await expect(page.getByLabel('代码审阅反馈')).toHaveValue('two 的审阅意见');
    await expect(page.getByRole('button',{name:'已暂存',exact:true})).toHaveClass(/chosen/);
    await page.getByLabel('代码审阅反馈').fill('编辑后立即退出也保留');
    await app.close();app=await f.launch();page=await app.firstWindow();
    await expect(page.getByRole('heading',{name:'长对话 B',exact:true})).toBeVisible();await tab(page,'变更');
    await expect(page.getByLabel('代码审阅反馈')).toHaveValue('编辑后立即退出也保留');
    await expect(page.locator('.changed-files .selected')).toContainText('two.txt');await expect(page.getByRole('button',{name:'已暂存',exact:true})).toHaveClass(/chosen/);
    await page.locator('.changed-files button').filter({hasText:'one.txt'}).click();await expect(page.getByLabel('代码审阅反馈')).toHaveValue('one 的审阅意见');
    await fs.writeFile(path.join(f.projects[1].path,'one.txt'),'original one\n');
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await expect(page.getByText('该文件已不在变更列表中，审阅草稿已保留。',{exact:true})).toBeVisible();
    await expect(page.getByLabel('代码审阅反馈')).toHaveValue('one 的审阅意见');
    await tab(page,'工作流');await expect(page.getByLabel('工作流目标')).toHaveValue('下一项任务的草稿');
    await expect(page.getByLabel('阶段指令')).toHaveValue('尚未保存的阶段指令');
    await page.getByRole('button',{name:'保存指令',exact:true}).click();await expect(page.getByLabel('阶段指令')).toHaveCount(0);
    const saved=await page.evaluate(async id=>(await window.desktop.workflows(id))[0].stages[0].instruction,f.sessions[0].id);
    expect(saved).toBe('尚未保存的阶段指令');await expect(page.getByLabel('工作流目标')).toHaveValue('下一项任务的草稿');
    await select(page,'短对话 B');await expect(page.getByLabel('工作流目标')).toHaveValue('另一个会话的草稿');
    await expect(page.locator('.error-banner')).toHaveCount(0);
  }finally{await app.close();await f.dispose();}
});

test('experience: new-session project, template append, terminal selection and reading anchors',async()=>{
  const f=await workspace();let app=await f.launch();
  try{
    let page=await app.firstWindow();
    await expect(page.getByRole('heading',{name:'长对话 B',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'新建会话',exact:false}).click();await expect(page.getByLabel('项目',{exact:true})).toHaveValue(f.projects[1].id);await page.keyboard.press('Escape');
    await page.locator('.project-row').filter({hasText:'项目 A'}).click();
    await page.getByRole('button',{name:'新建会话',exact:false}).click();await expect(page.getByLabel('项目',{exact:true})).toHaveValue(f.projects[0].id);await page.keyboard.press('Escape');
    await page.locator('.project-row').filter({hasText:'全部项目'}).click();
    await page.getByRole('button',{name:'开始输入',exact:true}).click();await expect(page.getByLabel('提示词编辑器')).toBeFocused();
    expect((await page.evaluate(()=>window.desktop.snapshot())).state.sessions.some(session=>session.started)).toBe(false);
    await expect(page.locator('.chat-message')).toHaveCount(90);await settleReading(page);
    await page.locator('.chat-scroll').evaluate(element=>{element.scrollTop=300;});
    await expect(page.getByRole('button',{name:'跳到最新消息',exact:true})).toBeVisible();await settleReading(page);
    const anchor=await page.locator('.chat-scroll').evaluate(element=>{
      const top=element.getBoundingClientRect().top;
      const row=Array.from(element.querySelectorAll<HTMLElement>('[data-message-id]')).find(row=>row.getBoundingClientRect().bottom>top)!;
      return {id:row.dataset.messageId!,offset:row.getBoundingClientRect().top-top};
    });
    await select(page,'短对话 B');await select(page,'长对话 B');await expect(page.locator('.chat-message')).toHaveCount(90);await settleReading(page);
    await expect.poll(()=>page.locator('.chat-scroll').evaluate(element=>element.scrollTop)).toBe(300);
    // Width changes reflow messages; the same message stays at the same visible offset.
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1100,800));await settleReading(page);
    const offset=await page.locator('.chat-scroll').evaluate((element,id)=>{
      const row=Array.from(element.querySelectorAll<HTMLElement>('[data-message-id]')).find(row=>row.dataset.messageId===id)!;
      return row.getBoundingClientRect().top-element.getBoundingClientRect().top;
    },anchor.id);
    expect(Math.abs(offset-anchor.offset)).toBeLessThan(2);
    await page.getByRole('button',{name:'跳到最新消息',exact:true}).click();await settleReading(page);
    await select(page,'短对话 B');await select(page,'长对话 B');await settleReading(page);
    expect(await page.locator('.chat-scroll').evaluate(element=>element.scrollHeight-element.scrollTop-element.clientHeight)).toBeLessThan(2);
    await select(page,'CLI 终端 B');await expect(page.locator('.error-banner')).toHaveCount(0);
    await page.getByLabel('提示词编辑器').fill('保留现有草稿');await tab(page,'工作流');await page.getByRole('button',{name:'添加完整开发提示词',exact:true}).click();
    const text=await page.getByLabel('提示词编辑器').inputValue();expect(text).toMatch(/^保留现有草稿\n\n请完成以下任务/);
    await select(page,'Shell B');await expect(page.locator('.error-banner')).toHaveCount(0);
    await select(page,'CLI 终端 B');await expect(page.getByLabel('提示词编辑器')).toHaveValue(text);await expect(page.locator('.error-banner')).toHaveCount(0);
    await expect.poll(async()=>JSON.parse(await fs.readFile(path.join(f.data,'workspace.json'),'utf8')).sessions.find((s:Session)=>s.id===f.sessions[2].id).draft).toBe(text);
    await app.close();app=await f.launch();page=await app.firstWindow();await expect(page.getByLabel('提示词编辑器')).toHaveValue(text);
    await expect(page.locator('.error-banner')).toHaveCount(0);
  }finally{await app.close();await f.dispose();}
});

async function cliProbe(directory:string,version:string){
  const prefix=path.join(directory,'npm '+version),pkg=path.join(prefix,'node_modules','@anthropic-ai','claude-code');
  await fs.mkdir(pkg,{recursive:true});
  const node=path.join(prefix,process.platform==='win32'?'node.exe':'node');
  if(process.platform==='win32')await fs.copyFile(process.execPath,node);else await fs.symlink(process.execPath,node);
  await fs.writeFile(path.join(pkg,'package.json'),JSON.stringify({name:'@anthropic-ai/claude-code',bin:{claude:'cli.js'}}));
  const record=path.join(prefix,'probes.jsonl');
  await fs.writeFile(path.join(pkg,'cli.js'),`const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(record)},JSON.stringify(process.argv.slice(2))+'\\n');
if(process.argv.includes('--version'))console.log(${JSON.stringify(version)});
else if(process.argv.includes('--help'))console.log('--session-id --resume --fork-session --permission-mode --model');
else process.exitCode=1;`);
  const cli=path.join(prefix,'claude.cmd');await fs.writeFile(cli,'@echo off\r\nexit /b 99\r\n',{mode:0o755});
  return {cli,record};
}

test('experience: save-and-detect probes the edited npm CLI path, including an unchanged-path retry',async()=>{
  const f=await workspace();const a=await cliProbe(f.directory,'fixture-A'),b=await cliProbe(f.directory,'fixture-B');
  const file=path.join(f.data,'workspace.json');const state=JSON.parse(await fs.readFile(file,'utf8')) as AppState;
  state.settings.claudePath=a.cli;state.sessions[0].started=true;await fs.writeFile(file,JSON.stringify(state));const app=await f.launch();
  try{
    const page=await app.firstWindow();await page.getByRole('button',{name:'设置与连接',exact:false}).click();
    await expect(page.locator('.connection-box')).toContainText('fixture-A');
    await page.getByLabel('Claude Code 路径').fill(b.cli);await expect(page.getByText(/路径尚未保存/)).toBeVisible();
    await page.getByRole('button',{name:'保存并检测',exact:true}).click();await expect(page.locator('.connection-box')).toContainText('fixture-B');
    await expect(page.getByRole('button',{name:'保存并检测',exact:true})).toBeEnabled();
    expect((await page.evaluate(()=>window.desktop.snapshot())).state.settings.claudePath).toBe(b.cli);
    const count=async()=>((await fs.readFile(b.record,'utf8')).match(/--version/g)??[]).length;
    const before=await count();expect(before).toBe(1);
    await page.getByRole('button',{name:'保存并检测',exact:true}).click();await expect.poll(count).toBe(before+1);
    await expect(page.getByRole('button',{name:'保存并检测',exact:true})).toBeEnabled();
    await page.getByLabel('Claude Code 路径').fill(a.cli);await page.keyboard.press('Escape');
    expect((await page.evaluate(()=>window.desktop.snapshot())).state.settings.claudePath).toBe(b.cli);
    await page.locator('.project-row').filter({hasText:'项目 A'}).click();
    await page.getByRole('button',{name:'从此会话创建分支',exact:true}).click();
    await expect(page.getByLabel('项目',{exact:true})).toHaveValue(f.projects[1].id);await page.keyboard.press('Escape');
    await page.evaluate(id=>window.desktop.removeProject(id),f.projects[0].id);
    await page.getByRole('button',{name:'新建会话',exact:false}).click();
    await expect(page.getByLabel('项目',{exact:true})).toHaveValue(f.projects[1].id);await page.keyboard.press('Escape');
    await expect(page.locator('.error-banner')).toHaveCount(0);
  }finally{await app.close();await f.dispose();}
});
