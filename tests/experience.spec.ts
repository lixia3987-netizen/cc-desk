import { electronLaunchArgs } from './helpers/electron-launch';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { AppState, Session } from '../src/shared/types';
import type { ChatSnapshot } from '../src/shared/chat';

async function workspace(historyCount=90) {
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
    {title:'长对话 B',kind:'agent',mode:'structured'}, {title:'短对话 B',kind:'agent',mode:'structured'},
    {title:'CLI 终端 B',kind:'agent',mode:'terminal'}, {title:'Shell B',kind:'shell',mode:'terminal'},
  ].map(({mode,...value})=>({...value,execution: value.kind === 'shell' ? {providerId:'shell',mode:'terminal'} : {providerId:'claude',mode,conversationId:randomUUID()},id:randomUUID(),projectId:projects[1].id,cwd:projects[1].path,started:false,
    model:'',effort:'default',permissionMode:'default',status:'idle',taskState:'idle',archived:false,createdAt:now,updatedAt:now} as Session));
  const state:AppState={version: 2,projects,sessions,selectedSessionId:sessions[0].id,
    settings:{claudePath:path.join(directory,'unavailable-claude'),shellPath:'',maxSessions:4,fontSize:14,scrollback:8000}};
  await fs.mkdir(path.join(data,'chat'),{recursive:true});
  await fs.writeFile(path.join(data,'workspace.json'),JSON.stringify(state));
  for(let index=0;index<2;index++){
    const snapshot:ChatSnapshot={sessionId:sessions[index].id,taskState:'idle',pending:[],messages:Array.from({length:index===0?historyCount:2},(_,i)=>({
      id:'message-'+i,turnId:'turn-'+i,role:i%2?'assistant':'user',createdAt:now,
      text:`第 ${i+1} 条消息\n\n用于验证切换会话时的阅读位置。\n\n\`\`\`typescript\nconst value = ${i};\n\`\`\``,
    }))};
    if(snapshot.messages.length>400){
      snapshot.messages[20]={...snapshot.messages[20],role:'tool',toolName:'Read',input:{file_path:'example.ts'}};
      await fs.writeFile(path.join(data,'chat',sessions[index].id+'.jsonl'),snapshot.messages.map(message=>JSON.stringify({type:'message',message})+'\n').join(''));
      snapshot.messages=snapshot.messages.slice(-400);snapshot.truncated=true;
    }
    if(index===1&&historyCount>400)snapshot.truncated=true;
    await fs.writeFile(path.join(data,'chat',sessions[index].id+'.json'),JSON.stringify(snapshot));
  }
  const launch=(env:Record<string,string>={})=>electron.launch({args:electronLaunchArgs(),
    env:{...process.env,...env,WORKBENCH_TEST_MODE:'1',WORKBENCH_DATA_DIR:data}});
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

test('experience: project groups preserve navigation and drafts with a compact header at desktop and narrow widths',async()=>{
  const f=await workspace(12),file=path.join(f.data,'workspace.json');
  const state=JSON.parse(await fs.readFile(file,'utf8')) as AppState;
  const inA=(title:string,updatedAt:string,archived=false):Session=>({ ...f.sessions[1],execution: { ...f.sessions[1].execution, conversationId: randomUUID() },id:randomUUID(),projectId:f.projects[0].id,cwd:f.projects[0].path,title,updatedAt,archived});
  state.sessions.push(inA('较早的 A 对话','2025-01-01T00:00:00.000Z'),inA('最近的 A 对话','2025-02-01T00:00:00.000Z'),inA('已归档的 A 对话','2025-03-01T00:00:00.000Z',true));
  const orphan={...inA('保留的旧项目对话','2025-01-01T00:00:00.000Z'),projectId:randomUUID()};state.sessions.push(orphan);
  await fs.writeFile(file,JSON.stringify(state));const app=await f.launch();
  try{
    const page=await app.firstWindow(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    const groupA=page.locator(`[data-project-id="${f.projects[0].id}"]`),groupB=page.locator(`[data-project-id="${f.projects[1].id}"]`);
    await expect(page.getByRole('heading',{name:'长对话 B',exact:true})).toBeVisible();
    await expect(groupA.locator('.session-row strong')).toHaveText(['最近的 A 对话','较早的 A 对话']);
    await expect(groupB.locator('.session-row')).toHaveCount(4);
    await expect(page.locator(`[data-project-id="${orphan.projectId}"]`)).toContainText('保留的旧项目对话');
    await page.getByLabel('提示词编辑器').fill('折叠和跨项目切换后仍保留');
    await groupB.locator('.project-group-toggle').click();await expect(groupB.locator('.session-row').first()).toBeHidden();
    await expect(page.getByLabel('提示词编辑器')).toHaveValue('折叠和跨项目切换后仍保留');
    await page.getByLabel('搜索会话').fill('短对话');await expect(groupB.locator('.project-group-toggle')).toHaveAttribute('aria-expanded','true');
    await expect(page.locator('.session-group')).toHaveCount(1);await expect(groupB.locator('.session-row:visible')).toHaveCount(1);
    await page.getByLabel('搜索会话').fill('项目 A');await expect(groupA.locator('.session-row:visible')).toHaveCount(2);
    await page.getByLabel('搜索会话').fill('');
    await page.getByRole('button',{name:'在「项目 A」中创建会话',exact:true}).click();
    await expect(page.getByLabel('项目',{exact:true})).toHaveValue(f.projects[0].id);
    await page.getByLabel('会话名称').fill('直接创建的 A 对话');await page.getByRole('button',{name:'创建会话',exact:true}).click();
    await expect(groupA.locator('.session-row.active')).toContainText('直接创建的 A 对话');
    await select(page,'长对话 B');await expect(page.getByLabel('提示词编辑器')).toHaveValue('折叠和跨项目切换后仍保留');
    await page.getByRole('button',{name:'查看归档',exact:true}).click();
    await expect(page.locator('.session-group')).toHaveCount(1);await expect(groupA.locator('.session-row')).toHaveText(/已归档的 A 对话/);
    await app.evaluate(({BrowserWindow},id)=>{BrowserWindow.getAllWindows()[0].webContents.send('session:navigate',id);},f.sessions[0].id);
    await expect(groupB.locator('.session-row.active')).toBeVisible();
    await groupB.locator('.project-group-toggle').click();
    // The selected ID is unchanged: notification navigation must still reveal its project.
    await app.evaluate(({BrowserWindow},id)=>{BrowserWindow.getAllWindows()[0].webContents.send('session:navigate',id);},f.sessions[0].id);
    await expect(groupB.locator('.project-group-toggle')).toHaveAttribute('aria-expanded','true');
    await page.getByLabel('工作空间筛选').selectOption(f.projects[0].id);await page.getByLabel('搜索会话').fill('隐藏全部');
    await page.getByRole('button',{name:'命令面板',exact:true}).click();await page.getByLabel('查找命令与会话').fill('长对话 B');
    await page.locator('.palette-results button').filter({hasText:'长对话 B'}).click();
    await expect(page.getByLabel('工作空间筛选')).toHaveValue('all');await expect(page.getByLabel('搜索会话')).toHaveValue('');
    await expect(groupB.locator('.session-row.active')).toBeVisible();
    const title='用于验证窄窗口中标题省略和操作按钮可用性的长对话名称'.repeat(3);
    await page.evaluate(({id,title})=>window.desktop.updateSession({id,title}),{id:f.sessions[0].id,title});
    for(const size of [[1600,1000],[980,680]]){
      await app.evaluate(({BrowserWindow},[width,height])=>BrowserWindow.getAllWindows()[0].setSize(width,height),size);await settleReading(page);
      await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
      const layout=await page.evaluate(()=>({top:document.querySelector('.chat-scroll')!.getBoundingClientRect().top,header:document.querySelector('.session-header')!.getBoundingClientRect().height,width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth}));
      expect(layout.header).toBeLessThanOrEqual(76);expect(layout.top).toBeLessThanOrEqual(112);expect(layout.overflow).toBe(false);
      for(const name of ['打开工作目录','导出会话记录','开始输入','命令面板']){
        const button=page.getByRole('button',{name,exact:true});await expect(button).toBeVisible();
        const bounds=(await button.boundingBox())!;expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(layout.width);
      }
    }
    await page.getByRole('button',{name:'开始输入',exact:true}).click();await expect(page.getByLabel('提示词编辑器')).toBeFocused();
    await expect(page.getByLabel('提示词编辑器')).toHaveValue('折叠和跨项目切换后仍保留');expect(errors).toEqual([]);
  }finally{await app.close();await f.dispose();}
});

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
    await page.getByLabel('工作空间筛选').selectOption({label:'项目 A'});
    await page.getByRole('button',{name:'新建会话',exact:false}).click();await expect(page.getByLabel('项目',{exact:true})).toHaveValue(f.projects[0].id);await page.keyboard.press('Escape');
    await page.getByLabel('工作空间筛选').selectOption({label:'全部项目'});
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


test('experience: permission defaults persist while sessions, forks and import overrides keep their own modes',async()=>{
  const f=await workspace(2),probe=await cliProbe(f.directory,'permission-fixture');
  const file=path.join(f.data,'workspace.json'),initial=JSON.parse(await fs.readFile(file,'utf8')) as AppState;
  initial.settings.claudePath=probe.cli;initial.sessions[0].started=true;await fs.writeFile(file,JSON.stringify(initial));
  let app=await f.launch();
  try{
    let page=await app.firstWindow();
    await expect(page.getByRole('heading',{name:'长对话 B',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'设置与连接',exact:false}).click();
    await page.getByRole('tab',{name:'会话与权限',exact:true}).click();
    await expect(page.getByLabel('默认权限模式',{exact:true})).toHaveValue('default');
    await page.getByLabel('默认权限模式',{exact:true}).selectOption('bypassPermissions');
    await page.keyboard.press('Escape');
    expect((await page.evaluate(()=>window.desktop.snapshot())).state.settings.defaultPermissionMode).toBe('default');
    await page.getByRole('button',{name:'设置与连接',exact:false}).click();
    await page.getByRole('tab',{name:'会话与权限',exact:true}).click();
    await page.getByLabel('默认权限模式',{exact:true}).selectOption('bypassPermissions');
    await page.getByRole('button',{name:'保存设置',exact:true}).click();
    await expect.poll(async()=>(await page.evaluate(()=>window.desktop.snapshot())).state.settings.defaultPermissionMode).toBe('bypassPermissions');
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('会话权限模式',{exact:true})).toHaveValue('default');
    await app.close();app=await f.launch();page=await app.firstWindow();
    await page.getByRole('button',{name:'新建会话',exact:false}).click();
    await expect(page.getByLabel('权限模式',{exact:true})).toHaveValue('bypassPermissions');
    await page.getByLabel('权限模式',{exact:true}).selectOption('plan');
    await page.getByRole('button',{name:'创建会话',exact:true}).click();
    await expect(page.getByLabel('会话权限模式',{exact:true})).toHaveValue('plan');
    expect((await page.evaluate(()=>window.desktop.snapshot())).state.settings.defaultPermissionMode).toBe('bypassPermissions');
    await page.getByLabel('会话权限模式',{exact:true}).selectOption('bypassPermissions');
    await page.getByRole('button',{name:'保存配置',exact:true}).click();
    await expect.poll(async()=>{const {state}=await page.evaluate(()=>window.desktop.snapshot());return state.sessions.find(s=>s.id===state.selectedSessionId)?.permissionMode;}).toBe('bypassPermissions');
    await select(page,'长对话 B');
    // The source is manual even though the global default is bypass.
    await page.evaluate(id=>window.desktop.updateSession({id,permissionMode:'default'}),f.sessions[0].id);
    await page.getByRole('button',{name:'从此会话创建分支',exact:true}).click();
    await expect(page.getByLabel('权限模式',{exact:true})).toHaveValue('default');
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'导入 CLI 历史',exact:false}).click();
    await expect(page.getByLabel('导入会话权限模式',{exact:true})).toHaveValue('bypassPermissions');
    await page.getByLabel('导入会话权限模式',{exact:true}).selectOption('acceptEdits');
    await page.getByLabel('历史会话 UUID').fill(randomUUID());
    await page.getByRole('button',{name:'导入会话',exact:true}).click();
    await expect(page.getByLabel('会话权限模式',{exact:true})).toHaveValue('acceptEdits');
    const modes=await page.evaluate(async({projectId,sourceId})=>{
      const input={projectId,title:'IPC permission test',kind:'agent' as const,model:'',effort:'default' as const,isolated:false};
      const implicit=await window.desktop.createSession(input);
      const terminal=await window.desktop.createSession({...input,mode:'terminal'});
      const explicit=await window.desktop.createSession({...input,permissionMode:'plan'});
      const fork=await window.desktop.createSession({...input,conversationId:sourceId,fork:true});
      const shell=await window.desktop.createSession({...input,kind:'shell'});
      const duplicate=await window.desktop.createSession({...input,conversationId:sourceId,permissionMode:'bypassPermissions'});
      return [implicit,terminal,explicit,fork,shell,duplicate].map(s=>s.permissionMode);
    },{projectId:f.projects[1].id,sourceId:f.sessions[0].execution.conversationId});
    expect(modes).toEqual(['bypassPermissions','bypassPermissions','plan','default','default','default']);
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
  state.settings.claudePath=a.cli;state.sessions[0].started=true;await fs.writeFile(file,JSON.stringify(state));
  // Count only save-and-detect probes; the updater legitimately performs its own version check.
  const app=await f.launch({DISABLE_UPDATES:'1'});
  try{
    const page=await app.firstWindow();await page.getByRole('button',{name:'设置与连接',exact:false}).click();await page.getByRole('tab',{name:'连接与终端',exact:true}).click();
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
    await page.getByLabel('工作空间筛选').selectOption({label:'项目 A'});
    await page.getByRole('button',{name:'从此会话创建分支',exact:true}).click();
    await expect(page.getByLabel('项目',{exact:true})).toHaveValue(f.projects[1].id);await page.keyboard.press('Escape');
    await page.evaluate(id=>window.desktop.removeProject(id),f.projects[0].id);
    await page.getByRole('button',{name:'新建会话',exact:false}).click();
    await expect(page.getByLabel('项目',{exact:true})).toHaveValue(f.projects[1].id);await page.keyboard.press('Escape');
    await expect(page.locator('.error-banner')).toHaveCount(0);
  }finally{await app.close();await f.dispose();}
});


test('experience: archive pagination, conversation search and historic reading position survive session switches',async()=>{
  const f=await workspace(525),app=await f.launch();
  try{
    const page=await app.firstWindow();const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await expect(page.getByRole('heading',{name:'长对话 B',exact:true})).toBeVisible();
    await expect(page.locator('[data-message-id]')).toHaveCount(400);
    await page.getByLabel('提示词编辑器').fill('查找时保留的草稿');
    await page.getByRole('button',{name:'查看更早消息',exact:true}).click();
    await expect(page.locator('[data-message-id]')).toHaveCount(50);await expect(page.locator('[data-message-id]').first()).toHaveAttribute('data-message-id','message-75');
    await page.getByRole('button',{name:'查看更早消息',exact:true}).click();await expect(page.locator('[data-message-id]').first()).toHaveAttribute('data-message-id','message-25');
    await page.getByRole('button',{name:'查看较新消息',exact:true}).click();await expect(page.locator('[data-message-id]').first()).toHaveAttribute('data-message-id','message-75');
    await page.keyboard.press(process.platform==='darwin'?'Meta+f':'Control+f');
    await expect(page.getByLabel('查找消息内容')).toBeFocused();
    await page.getByLabel('查找消息内容').fill('不存在的旧查询');await page.getByLabel('查找消息内容').fill('第 21 条消息');
    await expect(page.locator('.chat-search-results button')).toHaveCount(1);await expect(page.locator('.chat-search-results mark')).toHaveText('第 21 条消息');
    await page.screenshot({path:'docs/screenshots/conversation-search.png'});
    await page.locator('.chat-search-results button').click();await expect(page.getByRole('dialog',{name:'会话内查找'})).toHaveCount(0);
    await expect(page.locator('.search-target')).toHaveAttribute('data-message-id','message-20');await expect(page.locator('.search-target')).toHaveJSProperty('open',true);await settleReading(page);
    const offset=()=>page.locator('[data-message-id="message-20"]').evaluate(element=>element.getBoundingClientRect().top-element.closest('.chat-scroll')!.getBoundingClientRect().top);
    await expect.poll(offset).toBeGreaterThanOrEqual(0);await expect.poll(offset).toBeLessThan(20);
    await expect(page.getByLabel('提示词编辑器')).toHaveValue('查找时保留的草稿');
    await page.screenshot({path:'docs/screenshots/conversation-history.png'});
    await select(page,'短对话 B');await page.getByRole('button',{name:'查看更早消息',exact:true}).click();
    await expect(page.getByText('没有更早的本地记录；部分原始内容需导出查看。',{exact:true})).toBeVisible();
    await expect(page.locator('[data-message-id]')).toHaveCount(2);await expect(page.locator('.chat-empty')).toHaveCount(0);
    await expect(page.getByRole('button',{name:'查看更早消息',exact:true})).toBeDisabled();
    await select(page,'长对话 B');await expect(page.locator('[data-message-id]')).toHaveCount(50);await settleReading(page);
    await expect.poll(offset).toBeGreaterThanOrEqual(0);await expect.poll(offset).toBeLessThan(20);
    await page.getByRole('button',{name:'返回最新对话',exact:true}).click();await expect(page.locator('[data-message-id]')).toHaveCount(400);await settleReading(page);
    expect(await page.locator('.chat-scroll').evaluate(element=>element.scrollHeight-element.scrollTop-element.clientHeight)).toBeLessThan(5);
    await page.getByRole('button',{name:'查找消息',exact:true}).click();await page.getByLabel('查找消息内容').fill('不存在');await expect(page.getByText('没有匹配的消息。',{exact:true})).toBeVisible();
    await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'查找消息',exact:true})).toBeFocused();
    expect(errors).toEqual([]);
  }finally{await app.close();await f.dispose();}
});
