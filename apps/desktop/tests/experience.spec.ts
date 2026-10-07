import { openNewSessionOptions } from './helpers/session-ui';
import { openSessionSettings, closeSessionSettings } from './helpers/session-settings';
import { desktopRoot, documentationPath } from './helpers/paths';
import { sessionAction, sessionRow, stubChatSubmission, submitNewSession } from './helpers/session-ui';
import { selectProjectFilter } from './helpers/project-filter';
import { electronLaunchArgs } from './helpers/electron-launch';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { LegacyAppState as AppState, LegacySession as Session } from './helpers/legacy-workspace';
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
  const launch=async(env:Record<string,string>={})=>{const app=await electron.launch({args:electronLaunchArgs(),cwd:desktopRoot,
    env:{...process.env,...env,WORKBENCH_TEST_MODE:'1',WORKBENCH_DATA_DIR:data}});await stubChatSubmission(app);return app;};
  return {directory,data,projects,sessions,launch,dispose:()=>fs.rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100})};
}

const select=(page:Page,title:string)=>page.locator('.session-row').filter({hasText:title}).click();
async function openPanel(page:Page,name:string){
  const toggle=page.getByRole('button',{name,exact:true});
  if(await toggle.getAttribute('aria-pressed')!=='true')await toggle.click();
}

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

test('experience: project filter shows truncated paths and supports keyboard, dismissal and project updates',async()=>{
  const f=await workspace(2),file=path.join(f.data,'workspace.json');
  const state=JSON.parse(await fs.readFile(file,'utf8')) as AppState;
  const longPath=path.join(f.projects[0].path,...Array.from({length:5},(_,index)=>`very-long-project-parent-${index}`));
  await fs.mkdir(longPath,{recursive:true});
  state.projects[0].path=longPath;state.projects.forEach(project=>{project.name='同名项目';});
  await fs.writeFile(file,JSON.stringify(state));const app=await f.launch();
  try{
    const page=await app.firstWindow(),filter=page.getByLabel('工作空间筛选',{exact:true});
    const optionA=page.locator(`[data-project-option="${f.projects[0].id}"]`),optionB=page.locator(`[data-project-option="${f.projects[1].id}"]`);
    await expect(filter).toHaveText('全部项目');await filter.click();
    await expect(page.getByRole('listbox',{name:'项目列表'})).toBeVisible();
    await expect(optionA.locator('strong')).toHaveText('同名项目');await expect(optionB.locator('strong')).toHaveText('同名项目');
    await expect(optionA.locator('small')).toHaveText(longPath);await expect(optionB.locator('small')).toHaveText(f.projects[1].path);
    await optionA.hover();await expect(optionA).toHaveAttribute('title',longPath);
    const pathLayout=await optionA.locator('small').evaluate(element=>({ellipsis:getComputedStyle(element).textOverflow,truncated:element.scrollWidth>element.clientWidth}));
    expect(pathLayout).toEqual({ellipsis:'ellipsis',truncated:true});
    const sidebarBounds=(await page.locator('.sidebar').boundingBox())!,optionBounds=(await optionA.boundingBox())!;
    expect(optionBounds.x+optionBounds.width).toBeLessThanOrEqual(sidebarBounds.x+sidebarBounds.width);
    await optionA.click();await expect(filter).toHaveAttribute('title',longPath);await expect(filter).toBeFocused();
    await filter.press('Enter');await filter.press('End');await filter.press('Enter');
    await expect(filter).toHaveAttribute('title',f.projects[1].path);
    await filter.press('Home');await filter.press('Enter');await expect(filter).toHaveText('全部项目');
    await filter.press('ArrowDown');await filter.press('ArrowDown');await filter.press('ArrowUp');await filter.press('ArrowDown');await filter.press('Escape');
    await expect(filter).toHaveText('全部项目');await expect(filter).toHaveAttribute('aria-expanded','false');
    await filter.click();await page.getByLabel('搜索会话').click();await expect(filter).toHaveAttribute('aria-expanded','false');
    await filter.click();await filter.press('Tab');await expect(filter).toHaveAttribute('aria-expanded','false');await expect(filter).not.toBeFocused();
    await filter.click();await optionA.click();await filter.click();
    await page.evaluate(id=>window.desktop.removeProject(id),f.projects[0].id);
    await expect(filter).toHaveText('全部项目');await expect(optionA).toHaveCount(0);await expect(optionB).toBeVisible();
    const added=await page.evaluate(folder=>window.desktop.addProject(folder),f.projects[0].path);
    await expect(page.locator(`[data-project-option="${added.id}"]`)).toBeVisible();
    await filter.press('End');await filter.press('Enter');await expect(filter).toHaveAttribute('title',f.projects[0].path);
    await expect(page.locator('.error-banner')).toHaveCount(0);
  }finally{await app.close();await f.dispose();}
});

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
    await expect(page.getByLabel('工作空间',{exact:true})).toHaveValue(f.projects[0].id);
    await openNewSessionOptions(page);
    await page.getByLabel('会话名称').fill('直接创建的 A 对话');await submitNewSession(page);
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
    await selectProjectFilter(page,f.projects[0].name);await page.getByLabel('搜索会话').fill('隐藏全部');
    await page.getByRole('button',{name:'命令面板',exact:true}).click();await page.getByLabel('查找命令与会话').fill('长对话 B');
    await page.locator('.palette-results button').filter({hasText:'长对话 B'}).click();
    await expect(page.getByLabel('工作空间筛选')).toHaveText('全部项目');await expect(page.getByLabel('搜索会话')).toHaveValue('');
    await expect(groupB.locator('.session-row.active')).toBeVisible();
    const title='用于验证窄窗口中标题省略和操作按钮可用性的长对话名称'.repeat(3);
    await page.evaluate(({id,title})=>window.desktop.updateSession({id,title}),{id:f.sessions[0].id,title});
    for(const size of [[1600,1000],[980,680]]){
      await app.evaluate(({BrowserWindow},[width,height])=>BrowserWindow.getAllWindows()[0].setSize(width,height),size);await settleReading(page);
      await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
      const layout=await page.evaluate(()=>({top:document.querySelector('.chat-scroll')!.getBoundingClientRect().top,header:document.querySelector('.session-header')!.getBoundingClientRect().height,width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth}));
      expect(layout.header).toBeLessThanOrEqual(76);expect(layout.top).toBeLessThanOrEqual(112);expect(layout.overflow).toBe(false);
      for(const name of ['开始输入','命令面板']){
        const button=page.getByRole('button',{name,exact:true});await expect(button).toBeVisible();
        const bounds=(await button.boundingBox())!;expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(layout.width);
      }
      await sessionRow(page,title).scrollIntoViewIfNeeded();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await sessionRow(page,title).click({button:'right'});
      for(const name of ['打开工作目录','导出会话记录']){
        const item=page.getByRole('menuitem',{name,exact:true});await expect(item).toBeVisible();
        const bounds=(await item.boundingBox())!;expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(layout.width);
      }
      await page.keyboard.press('Escape');
    }
    await page.getByRole('button',{name:'开始输入',exact:true}).click();await expect(page.getByLabel('提示词编辑器')).toBeFocused();
    await expect(page.getByLabel('提示词编辑器')).toHaveValue('折叠和跨项目切换后仍保留');expect(errors).toEqual([]);
  }finally{await app.close();await f.dispose();}
});

test('experience: panel drafts keep session/file identity, open panels and unsaved edits across restart',async()=>{
  const f=await workspace();let app=await f.launch();
  try{
    let page=await app.firstWindow();
    await expect(page.getByRole('heading',{name:'长对话 B',exact:true})).toBeVisible();
    await openPanel(page,'工作流');await page.getByLabel('工作流目标').fill('已提交的工作流目标');
    // The unavailable CLI blocks execution, while a local workflow draft stays editable.
    await expect(page.getByRole('button',{name:'创建工作流',exact:true})).toBeEnabled();
    await page.getByRole('button',{name:'创建工作流',exact:true}).click();await expect(page.locator('.workflow-run')).toHaveCount(1);
    await expect(page.locator('.workflow-run').getByRole('button',{name:'开始',exact:true})).toBeDisabled();
    await expect(page.getByLabel('工作流目标')).toHaveValue('');
    await page.getByLabel('工作流目标').fill('下一项任务的草稿');
    await page.getByLabel('每阶段结束后由我确认继续').uncheck();await page.getByLabel('最大尝试次数').selectOption('3');
    await page.getByRole('button',{name:'编辑阶段指令',exact:true}).first().click();await page.getByLabel('阶段指令').fill('尚未保存的阶段指令');
    await expect(page.getByRole('button',{name:'保存指令',exact:true})).toBeEnabled();
    await fs.writeFile(path.join(f.projects[1].path,'one.txt'),'changed one\n');await fs.writeFile(path.join(f.projects[1].path,'two.txt'),'changed two\n');
    await openPanel(page,'变更');await page.locator('.changed-files button').filter({hasText:'one.txt'}).click();
    await page.getByLabel('代码审阅反馈').fill('one 的审阅意见');
    await page.locator('.changed-files button').filter({hasText:'two.txt'}).click();await expect(page.getByLabel('代码审阅反馈')).toHaveValue('');
    await page.getByLabel('代码审阅反馈').fill('two 的审阅意见');await page.getByRole('button',{name:'已暂存',exact:true}).click();
    await openPanel(page,'工作流');await expect(page.getByLabel('工作流目标')).toHaveValue('下一项任务的草稿');
    await expect(page.getByLabel('阶段指令')).toHaveValue('尚未保存的阶段指令');await expect(page.getByLabel('最大尝试次数')).toHaveValue('3');
    await expect(page.getByLabel('每阶段结束后由我确认继续')).not.toBeChecked();
    await select(page,'短对话 B');await expect(page.getByLabel('工作流目标')).toHaveValue('');
    await expect(page.getByLabel('每阶段结束后由我确认继续')).toBeChecked();await expect(page.getByLabel('最大尝试次数')).toHaveValue('2');
    await page.getByLabel('工作流目标').fill('另一个会话的草稿');await select(page,'长对话 B');
    await openPanel(page,'变更');await expect(page.getByLabel('代码审阅反馈')).toHaveValue('two 的审阅意见');
    await expect(page.getByRole('button',{name:'已暂存',exact:true})).toHaveClass(/chosen/);
    await page.getByLabel('代码审阅反馈').fill('编辑后立即退出也保留');
    await app.close();app=await f.launch();page=await app.firstWindow();
    await expect(page.getByRole('heading',{name:'长对话 B',exact:true})).toBeVisible();await openPanel(page,'变更');
    await expect(page.getByLabel('代码审阅反馈')).toHaveValue('编辑后立即退出也保留');
    await expect(page.locator('.changed-files .selected')).toContainText('two.txt');await expect(page.getByRole('button',{name:'已暂存',exact:true})).toHaveClass(/chosen/);
    await page.locator('.changed-files button').filter({hasText:'one.txt'}).click();await expect(page.getByLabel('代码审阅反馈')).toHaveValue('one 的审阅意见');
    await fs.writeFile(path.join(f.projects[1].path,'one.txt'),'original one\n');
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await expect(page.getByText('该文件已不在变更列表中，审阅草稿已保留。',{exact:true})).toBeVisible();
    await expect(page.getByLabel('代码审阅反馈')).toHaveValue('one 的审阅意见');
    await openPanel(page,'工作流');await expect(page.getByLabel('工作流目标')).toHaveValue('下一项任务的草稿');
    await expect(page.getByLabel('阶段指令')).toHaveValue('尚未保存的阶段指令');
    await expect(page.locator('.workflow-run').getByRole('button',{name:'开始',exact:true})).toBeDisabled();
    await expect(page.getByRole('button',{name:'保存指令',exact:true})).toBeEnabled();
    await page.getByRole('button',{name:'保存指令',exact:true}).click();await expect(page.getByLabel('阶段指令')).toHaveCount(0);
    await expect(page.locator('.workflow-run').getByRole('button',{name:'开始',exact:true})).toBeDisabled();
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
    await page.getByRole('button',{name:'新建会话',exact:false}).click();await expect(page.getByLabel('工作空间',{exact:true})).toHaveValue(f.projects[1].id);await select(page,'长对话 B');
    await selectProjectFilter(page,'项目 A');
    await page.getByRole('button',{name:'新建会话',exact:false}).click();
    // Reopening an unsent page preserves its chosen workspace; changing a sidebar filter creates no record.
    await expect(page.getByLabel('工作空间',{exact:true})).toHaveValue(f.projects[1].id);
    await page.getByLabel('工作空间',{exact:true}).selectOption(f.projects[0].id);
    await selectProjectFilter(page,'全部项目');await select(page,'长对话 B');
    await selectProjectFilter(page,'全部项目');
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
    await page.getByLabel('提示词编辑器').fill('保留现有草稿');await openPanel(page,'工作流');await page.getByRole('button',{name:'添加完整开发提示词',exact:true}).click();
    const text=await page.getByLabel('提示词编辑器').inputValue();expect(text).toMatch(/^保留现有草稿\n\n请完成以下任务/);
    await select(page,'Shell B');await expect(page.locator('.error-banner')).toHaveCount(0);
    await select(page,'CLI 终端 B');await expect(page.getByLabel('提示词编辑器')).toHaveValue(text);await expect(page.locator('.error-banner')).toHaveCount(0);
    await expect.poll(async()=>JSON.parse(await fs.readFile(path.join(f.data,'workspace.json'),'utf8')).sessions.find((s:Session)=>s.id===f.sessions[2].id).draft).toBe(text);
    await app.close();app=await f.launch();page=await app.firstWindow();await expect(page.getByLabel('提示词编辑器')).toHaveValue(text);
    await expect(page.locator('.error-banner')).toHaveCount(0);
  }finally{await app.close();await f.dispose();}
});


test('experience: delayed terminal activation cannot steal composer input or lose an appended draft',async()=>{
  const f=await workspace(2),app=await f.launch();
  try{
    const page=await app.firstWindow();
    await expect(page.getByRole('heading',{name:'长对话 B',exact:true})).toBeVisible();
    // Hold animation frames during selection so input can arrive before terminal activation.
    await page.evaluate(()=>{
      const request=window.requestAnimationFrame,cancel=window.cancelAnimationFrame;
      const queued=new Map<number,FrameRequestCallback>();let sequence=0;
      window.requestAnimationFrame=callback=>{const id=--sequence;queued.set(id,callback);return id;};
      window.cancelAnimationFrame=id=>{if(id<0)queued.delete(id);else cancel(id);};
      (window as Window & {releaseFrames?:()=>number}).releaseFrames=()=>{
        window.requestAnimationFrame=request;window.cancelAnimationFrame=cancel;
        const callbacks=[...queued.values()];queued.clear();
        for(const callback of callbacks)callback(performance.now());
        return callbacks.length;
      };
      const row=Array.from(document.querySelectorAll<HTMLElement>('.session-row')).find(row=>row.textContent?.includes('CLI 终端 B'))!;
      row.click();
    });
    const editor=page.getByLabel('提示词编辑器',{exact:true});
    await expect(page.getByRole('heading',{name:'CLI 终端 B',exact:true})).toBeVisible();
    await expect(page.locator('.terminal-host .xterm-helper-textarea')).toHaveCount(1);
    await editor.focus();await expect(editor).toBeFocused();
    expect(await page.evaluate(()=>(window as Window & {releaseFrames?:()=>number}).releaseFrames!())).toBeGreaterThan(0);
    await expect(editor).toBeFocused();
    await page.keyboard.insertText('保留现有草稿');await expect(editor).toHaveValue('保留现有草稿');
    await openPanel(page,'工作流');await page.getByRole('button',{name:'添加完整开发提示词',exact:true}).click();
    await expect(editor).toHaveValue(/^保留现有草稿\n\n请完成以下任务/);
    // Ordinary terminal selection still focuses the active terminal by default.
    await select(page,'Shell B');
    await expect(page.locator('.terminal-slot:visible .xterm-helper-textarea')).toBeFocused();
    await select(page,'CLI 终端 B');
    await expect(page.locator('.terminal-slot:visible .xterm-helper-textarea')).toBeFocused();
    await expect(editor).toHaveValue(/^保留现有草稿\n\n请完成以下任务/);
    expect((await page.evaluate(()=>window.desktop.snapshot())).state.sessions.every(session=>!session.started)).toBe(true);
  }finally{await app.close();await f.dispose();}
});


test('experience: right-click actions target an unselected session and confirm rename, archive and deletion',async()=>{
  const f=await workspace(2),app=await f.launch();
  try{
    const page=await app.firstWindow(),target={...f.sessions[1]},active=f.sessions[0];
    await expect(page.getByRole('heading',{name:active.title,exact:true})).toBeVisible();
    const persisted=async()=>(await page.evaluate(()=>window.desktop.snapshot())).state.sessions.find(session=>session.id===target.id);
    const expectActiveUnchanged=async()=>{
      expect((await page.evaluate(()=>window.desktop.snapshot())).state.selectedSessionId).toBe(active.id);
      await expect(page.locator('.session-header')).toContainText(active.title);
    };
    await sessionRow(page,target.title).focus();await sessionRow(page,target.title).press('Shift+F10');
    await expect(page.getByRole('menu',{name:target.title+'的会话操作',exact:true})).toBeVisible();await expectActiveUnchanged();
    await page.keyboard.press('Escape');await expect(page.getByRole('menu')).toHaveCount(0);
    await sessionAction(page,target.title,'重命名会话');
    const rename=page.getByRole('dialog',{name:'重命名会话',exact:true});
    await expect(rename).toContainText(target.title);await expectActiveUnchanged();
    await rename.getByLabel('新的会话名称').fill('从列表重命名的会话');
    await rename.getByRole('button',{name:'保存',exact:true}).click();await expect(rename).toHaveCount(0);
    target.title='从列表重命名的会话';await expect(sessionRow(page,target.title)).toBeVisible();await expectActiveUnchanged();
    for(const dismissal of ['取消','Escape','backdrop'] as const){
      await sessionAction(page,target.title,'删除会话');
      const dialog=page.getByRole('dialog',{name:'删除会话',exact:true});
      await expect(dialog).toBeVisible();await expect(dialog).toHaveAttribute('aria-modal','true');
      await expect(dialog).toContainText(target.title);await expectActiveUnchanged();
      await expect(page.getByRole('dialog')).toHaveCount(1);await expect(page.locator('#root')).toHaveJSProperty('inert',true);
      expect(await persisted()).toMatchObject({id:target.id,archived:false});
      if(dismissal==='取消')await dialog.getByRole('button',{name:'取消',exact:true}).click();
      else if(dismissal==='Escape')await page.keyboard.press('Escape');
      else await page.locator('.modal-backdrop').click({position:{x:2,y:2}});
      await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('#root')).toHaveJSProperty('inert',false);
      expect(await persisted()).toMatchObject({id:target.id,archived:false});await expectActiveUnchanged();
    }
    await sessionAction(page,target.title,'归档会话');
    const archive=page.getByRole('dialog',{name:'归档会话',exact:true});
    await expect(archive).toBeVisible();expect((await persisted())?.archived).toBe(false);
    await archive.getByRole('button',{name:'取消',exact:true}).click();
    expect((await persisted())?.archived).toBe(false);
    await sessionAction(page,target.title,'归档会话');
    await archive.getByRole('button',{name:'确认归档',exact:true}).click();
    await expect(archive).toHaveCount(0);await expect.poll(async()=>(await persisted())?.archived).toBe(true);await expectActiveUnchanged();
    await page.getByRole('button',{name:'查看归档',exact:true}).click();
    await sessionAction(page,target.title,'取消归档');
    const restore=page.getByRole('dialog',{name:'取消归档',exact:true});
    await expect(restore).toBeVisible();expect((await persisted())?.archived).toBe(true);
    await page.keyboard.press('Escape');await expect(restore).toHaveCount(0);expect((await persisted())?.archived).toBe(true);
    await sessionAction(page,target.title,'取消归档');
    await restore.getByRole('button',{name:'确认取消归档',exact:true}).click();
    await expect(restore).toHaveCount(0);await expect.poll(async()=>(await persisted())?.archived).toBe(false);await expectActiveUnchanged();
    await page.getByRole('button',{name:'查看活跃会话',exact:true}).click();
    await sessionAction(page,target.title,'删除会话');
    await page.getByRole('dialog',{name:'删除会话',exact:true}).getByRole('button',{name:'确认删除会话',exact:true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);await expect.poll(persisted).toBeUndefined();await expectActiveUnchanged();
    expect((await page.evaluate(()=>window.desktop.snapshot())).state.sessions.map(session=>session.id)).toEqual(f.sessions.filter(session=>session.id!==target.id).map(session=>session.id));
    await expect(page.locator('.error-banner')).toHaveCount(0);
  }finally{await app.close();await f.dispose();}
});

test('experience: the new-session form creates structured agents, including forks of existing native sessions',async()=>{
  const f=await workspace(2),probe=await cliProbe(f.directory,'structured-form-fixture');
  const file=path.join(f.data,'workspace.json'),state=JSON.parse(await fs.readFile(file,'utf8')) as AppState;
  state.settings.claudePath=probe.cli;state.sessions[2].started=true;state.sessions[2].permissionMode='plan';
  await fs.writeFile(file,JSON.stringify(state));const app=await f.launch();
  try{
    const page=await app.firstWindow();
    await page.getByRole('button',{name:/新建会话/}).click();
    const form=page.getByRole('region',{name:'新建会话',exact:true});
    const expectStructuredForm=async()=>{
      await expect(form.getByRole('button',{name:'Shell 终端',exact:true})).toHaveCount(0);
      await expect(form.getByRole('button',{name:'Claude Code',exact:true})).toBeVisible();
      await expect(form.getByLabel('交互方式',{exact:true})).toHaveCount(0);
      await expect(form.getByLabel('模型',{exact:true})).toHaveCount(0);
      await expect(form.getByLabel('推理强度',{exact:true})).toHaveCount(0);
      await expect(form.getByLabel('权限模式',{exact:true})).toHaveCount(0);
      await expect(form.getByRole('button',{name:'新会话设置',exact:true})).toBeVisible();
    };
    await expectStructuredForm();await openNewSessionOptions(page);await form.getByLabel('会话名称',{exact:true}).fill('始终使用结构化对话');
    await submitNewSession(page);await expect(form).toHaveCount(0);
    const fresh=(await page.evaluate(()=>window.desktop.snapshot())).state.sessions.find(session=>session.title==='始终使用结构化对话')!;
    expect(fresh.kind).toBe('agent');expect(fresh.execution).toMatchObject({providerId:'claude',mode:'structured'});
    await select(page,'CLI 终端 B');
    await sessionAction(page,'CLI 终端 B','从此会话创建分支');
    await expectStructuredForm();
    await openNewSessionOptions(page);
    await form.getByLabel('会话名称',{exact:true}).fill('原生会话的结构化分支');
    await submitNewSession(page);await expect(form).toHaveCount(0);
    await expect(page.getByRole('heading',{name:'原生会话的结构化分支',exact:true})).toBeVisible();
    const sessions=(await page.evaluate(()=>window.desktop.snapshot())).state.sessions;
    const fork=sessions.find(session=>session.title==='原生会话的结构化分支')!;
    expect(fork.kind).toBe('agent');expect(fork.execution).toMatchObject({providerId:'claude',mode:'structured',forkFrom:f.sessions[2].execution.conversationId});
    expect(fork.engineConfig.options.permissionMode).toBe('plan');expect(fork.execution.conversationId).not.toBe(f.sessions[2].execution.conversationId);
    expect(sessions.find(session=>session.id===f.sessions[2].id)?.execution).toEqual(f.sessions[2].execution);
    expect(sessions.find(session=>session.id===f.sessions[3].id)?.execution).toEqual(f.sessions[3].execution);
    await expect(page.locator('.error-banner')).toHaveCount(0);
  }finally{await app.close();await f.dispose();}
});

test('experience: native model and terminal settings retain shared drafts and preserve CLI-managed Claude defaults',async()=>{
  const f=await workspace(2);
  let app=await f.launch();
  try{
    let page=await app.firstWindow();
    await page.evaluate(async()=>{
      const {state}=await window.desktop.snapshot();
      await window.desktop.saveSettings({...state.settings,engineDefaults:{...state.settings.engineDefaults,
        claude:{...state.settings.engineDefaults.claude,options:{...state.settings.engineDefaults.claude.options,model:'claude-cli-existing',effort:'high'}}
      }});
    });
    // Reopen the renderer from the persisted fixture before beginning a preferences draft.
    await page.reload();
    const open=async()=>{
      await page.getByRole('button',{name:'设置与连接',exact:true}).click();
      return page.getByRole('dialog',{name:'设置与连接',exact:true});
    };
    let settings=await open();
    await settings.getByRole('tab',{name:'模型与上下文',exact:true}).click();
    await expect(settings.getByRole('region',{name:'Native 模型连接',exact:true})).toBeVisible();
    await expect(settings.getByLabel('Claude Code 路径',{exact:true})).toHaveCount(0);
    await expect(settings.getByLabel('默认权限模式',{exact:true})).toHaveCount(0);
    await expect(settings.getByLabel('默认模型',{exact:true})).toHaveCount(0);
    await expect(settings.getByLabel('默认推理强度',{exact:true})).toHaveCount(0);
    await expect(settings.getByRole('region',{name:'Native MCP 连接',exact:true})).toHaveCount(0);
    await expect(settings.getByLabel('默认模型覆盖',{exact:true})).toBeHidden();
    await expect(settings.getByLabel('默认模型连接',{exact:true})).toBeHidden();
    await settings.getByText('新会话默认模型',{exact:true}).click();
    await settings.getByLabel('默认模型覆盖',{exact:true}).fill('native-ui-choice');

    await settings.getByRole('tab',{name:'运行与权限',exact:true}).click();
    await expect(settings.getByLabel('默认模型',{exact:true})).toHaveCount(0);
    await expect(settings.getByLabel('默认推理强度',{exact:true})).toHaveCount(0);
    await expect(settings.getByLabel('默认模型连接',{exact:true})).toHaveCount(0);
    await settings.getByRole('tab',{name:'权限与审批',exact:true}).click();
    await settings.getByLabel('默认权限模式',{exact:true}).selectOption('plan');
    await settings.getByRole('tab',{name:'运行限制',exact:true}).click();
    await settings.getByLabel('默认每回合工具调用上限',{exact:true}).fill('25');
    await settings.getByLabel('最大并发会话',{exact:true}).fill('6');
    await settings.getByRole('tab',{name:'模型与上下文',exact:true}).click();
    await expect(settings.getByLabel('默认模型',{exact:true})).toHaveCount(0);
    await expect(settings.getByLabel('默认模型覆盖',{exact:true})).toBeHidden();
    await settings.getByText('新会话默认模型',{exact:true}).click();
    await expect(settings.getByLabel('默认模型覆盖',{exact:true})).toHaveValue('native-ui-choice');

    await settings.getByRole('tab',{name:'终端与CLI',exact:true}).click();
    await expect(settings.getByLabel('Claude Code 路径',{exact:true})).toBeVisible();
    await expect(settings.getByRole('button',{name:'保存并检测',exact:true})).toBeVisible();
    await expect(settings.getByLabel('默认模型',{exact:true})).toHaveCount(0);
    await expect(settings.getByLabel('默认推理强度',{exact:true})).toHaveCount(0);
    await expect(settings.getByRole('region',{name:'Native 模型连接',exact:true})).toHaveCount(0);
    await settings.getByRole('tab',{name:'Shell 与终端',exact:true}).click();
    await settings.getByLabel('终端字号',{exact:true}).fill('18');
    await settings.getByRole('tab',{name:'运行与权限',exact:true}).click();
    await settings.getByRole('tab',{name:'权限与审批',exact:true}).click();
    await expect(settings.getByLabel('默认权限模式',{exact:true})).toHaveValue('plan');
    await settings.getByRole('tab',{name:'运行限制',exact:true}).click();
    await expect(settings.getByLabel('默认每回合工具调用上限',{exact:true})).toHaveValue('25');
    await expect(settings.getByRole('button',{name:'保存并检测',exact:true})).toHaveCount(0);
    await settings.getByRole('button',{name:'保存设置',exact:true}).click();
    await expect(settings.getByText('全局设置已同步',{exact:true})).toBeVisible();
    const saved=(await page.evaluate(()=>window.desktop.snapshot())).state;
    expect(saved.settings.engineDefaults.claude.options).toMatchObject({model:'claude-cli-existing',effort:'high',permissionMode:'plan'});
    expect(saved.settings.engineDefaults.native.options).toMatchObject({model:'native-ui-choice',maxToolCalls:25});
    expect(saved.settings).toMatchObject({fontSize:18,maxSessions:6});
    expect(saved.sessions[0].engineConfig.options.model).toBe('');
    expect(saved.sessions[0].engineConfig.options.permissionMode).toBe('default');
    await page.keyboard.press('Escape');
    settings=await open();
    await settings.getByRole('tab',{name:'模型与上下文',exact:true}).click();
    await settings.getByText('新会话默认模型',{exact:true}).click();
    await settings.getByLabel('默认模型覆盖',{exact:true}).fill('cancelled-choice');
    await settings.getByRole('tab',{name:'终端与CLI',exact:true}).click();
    await settings.getByRole('tab',{name:'Shell 与终端',exact:true}).click();
    await settings.getByLabel('终端字号',{exact:true}).fill('20');
    await settings.getByRole('button',{name:'关闭',exact:true}).click();
    expect((await page.evaluate(()=>window.desktop.snapshot())).state.settings).toEqual(saved.settings);

    await app.close();app=await f.launch();page=await app.firstWindow();settings=await open();
    await settings.getByRole('tab',{name:'模型与上下文',exact:true}).click();
    await expect(settings.getByLabel('默认模型',{exact:true})).toHaveCount(0);
    await expect(settings.getByLabel('默认模型覆盖',{exact:true})).toBeHidden();
    await settings.getByText('新会话默认模型',{exact:true}).click();
    await expect(settings.getByLabel('默认模型覆盖',{exact:true})).toHaveValue('native-ui-choice');
    await settings.getByRole('tab',{name:'运行与权限',exact:true}).click();
    await settings.getByRole('tab',{name:'权限与审批',exact:true}).click();
    await expect(settings.getByLabel('默认权限模式',{exact:true})).toHaveValue('plan');
    await settings.getByRole('tab',{name:'运行限制',exact:true}).click();
    await expect(settings.getByLabel('默认每回合工具调用上限',{exact:true})).toHaveValue('25');
    await settings.getByRole('tab',{name:'终端与CLI',exact:true}).click();
    await settings.getByRole('tab',{name:'Shell 与终端',exact:true}).click();
    await expect(settings.getByLabel('终端字号',{exact:true})).toHaveValue('18');
    expect((await page.evaluate(()=>window.desktop.snapshot())).state.settings.engineDefaults.claude.options).toMatchObject({model:'claude-cli-existing',effort:'high'});
    await settings.getByRole('tab',{name:'Shell 与终端',exact:true}).click();
    await settings.getByLabel('终端字号',{exact:true}).fill('99');
    await settings.getByRole('tab',{name:'模型与上下文',exact:true}).click();
    await settings.getByRole('button',{name:'保存设置',exact:true}).click();
    await expect(settings.getByRole('tab',{name:'终端与CLI',exact:true})).toHaveAttribute('aria-selected','true');
    await expect(settings.getByRole('alert')).toContainText('11–24');
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
    await page.getByRole('tab',{name:'运行与权限',exact:true}).click();
    await page.getByRole('tab',{name:'权限与审批',exact:true}).click();
    await expect(page.getByLabel('默认权限模式',{exact:true})).toHaveValue('default');
    await page.getByLabel('默认权限模式',{exact:true}).selectOption('bypassPermissions');
    await page.keyboard.press('Escape');
    expect((await page.evaluate(()=>window.desktop.snapshot())).state.settings.engineDefaults.claude.options.permissionMode).toBe('default');
    await page.getByRole('button',{name:'设置与连接',exact:false}).click();
    await page.getByRole('tab',{name:'运行与权限',exact:true}).click();
    await page.getByRole('tab',{name:'权限与审批',exact:true}).click();
    await page.getByLabel('默认权限模式',{exact:true}).selectOption('bypassPermissions');
    await page.getByRole('button',{name:'保存设置',exact:true}).click();
    await expect.poll(async()=>(await page.evaluate(()=>window.desktop.snapshot())).state.settings.engineDefaults.claude.options.permissionMode).toBe('bypassPermissions');
    await page.keyboard.press('Escape');
    await openSessionSettings(page,'permissions');
    await expect(page.getByLabel('会话权限模式',{exact:true})).toHaveValue('default');
    await closeSessionSettings(page);
    await app.close();app=await f.launch();page=await app.firstWindow();
    await page.getByRole('button',{name:'新建会话',exact:false}).click();
    await expect(page.getByLabel('权限模式',{exact:true})).toHaveCount(0);
    await submitNewSession(page);
    await openSessionSettings(page,'permissions');
    await expect(page.getByLabel('会话权限模式',{exact:true})).toHaveValue('bypassPermissions');
    await page.getByLabel('会话权限模式',{exact:true}).selectOption('plan');
    await page.getByRole('button',{name:'保存配置',exact:true}).click();
    await expect.poll(async()=>{const {state}=await page.evaluate(()=>window.desktop.snapshot());return state.sessions.find(s=>s.id===state.selectedSessionId)?.engineConfig.options.permissionMode;}).toBe('plan');
    expect((await page.evaluate(()=>window.desktop.snapshot())).state.settings.engineDefaults.claude.options.permissionMode).toBe('bypassPermissions');
    await closeSessionSettings(page);
    await openSessionSettings(page,'permissions');
    await page.getByLabel('会话权限模式',{exact:true}).selectOption('bypassPermissions');
    await page.getByRole('button',{name:'保存配置',exact:true}).click();
    await expect.poll(async()=>{const {state}=await page.evaluate(()=>window.desktop.snapshot());return state.sessions.find(s=>s.id===state.selectedSessionId)?.engineConfig.options.permissionMode;}).toBe('bypassPermissions');
    await closeSessionSettings(page);
    await select(page,'长对话 B');
    // The source is manual even though the global default is bypass.
    await page.evaluate(id=>window.desktop.updateSession({id,engineConfig:{schemaVersion:1,options:{model:'',effort:'default',permissionMode:'default'}}}),f.sessions[0].id);
    await sessionAction(page,'长对话 B','从此会话创建分支');
    await expect(page.getByLabel('权限模式',{exact:true})).toHaveCount(0);
    await select(page,'长对话 B');
    await page.getByRole('button',{name:'导入 CLI 历史',exact:false}).click();
    await expect(page.getByLabel('导入会话权限模式',{exact:true})).toHaveValue('bypassPermissions');
    await page.getByLabel('导入会话权限模式',{exact:true}).selectOption('acceptEdits');
    await page.getByLabel('历史会话 UUID').fill(randomUUID());
    await page.getByRole('button',{name:'导入会话',exact:true}).click();
    await openSessionSettings(page,'permissions');
    await expect(page.getByLabel('会话权限模式',{exact:true})).toHaveValue('acceptEdits');
    await closeSessionSettings(page);
    const modes=await page.evaluate(async({projectId,sourceId})=>{
      const input={projectId,title:'IPC permission test',kind:'agent' as const,isolated:false};
      const implicit=await window.desktop.createSession(input);
      const terminal=await window.desktop.createSession({...input,mode:'terminal'});
      const explicit=await window.desktop.createSession({...input,engineConfig:{schemaVersion:1,options:{model:'',effort:'default',permissionMode:'plan'}}});
      const fork=await window.desktop.createSession({...input,conversationId:sourceId,fork:true});
      const shell=await window.desktop.createSession({...input,kind:'shell'});
      const duplicate=await window.desktop.createSession({...input,conversationId:sourceId,engineConfig:{schemaVersion:1,options:{model:'',effort:'default',permissionMode:'bypassPermissions'}}});
      return {agents:[implicit,terminal,explicit,fork,duplicate].map(s=>s.engineConfig.options.permissionMode),shell:shell.engineConfig};
    },{projectId:f.projects[1].id,sourceId:f.sessions[0].execution.conversationId});
    expect(modes).toEqual({agents:['bypassPermissions','bypassPermissions','plan','default','default'],shell:{schemaVersion:1,options:{}}});
    await expect(page.locator('.error-banner')).toHaveCount(0);
  }finally{
    await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});
    await app.close();await f.dispose();
  }
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
    const page=await app.firstWindow();await page.getByRole('button',{name:'设置与连接',exact:false}).click();await page.getByRole('tab',{name:'终端与CLI',exact:true}).click();
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
    await selectProjectFilter(page,'项目 A');
    await selectProjectFilter(page,'全部项目');
    await sessionAction(page,'长对话 B','从此会话创建分支');
    await expect(page.getByLabel('工作空间',{exact:true})).toHaveValue(f.projects[1].id);await select(page,'长对话 B');
    await page.evaluate(id=>window.desktop.removeProject(id),f.projects[0].id);
    await page.getByRole('button',{name:'新建会话',exact:false}).click();
    await expect(page.getByLabel('工作空间',{exact:true})).toHaveValue(f.projects[1].id);await select(page,'长对话 B');
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
    await page.screenshot({path:documentationPath('screenshots', 'conversation-search.png')});
    await page.locator('.chat-search-results button').click();await expect(page.getByRole('dialog',{name:'会话内查找'})).toHaveCount(0);
    await expect(page.locator('.search-target')).toHaveAttribute('data-message-id','message-20');await expect(page.locator('.search-target')).toHaveJSProperty('open',true);await settleReading(page);
    const offset=()=>page.locator('[data-message-id="message-20"]').evaluate(element=>element.getBoundingClientRect().top-element.closest('.chat-scroll')!.getBoundingClientRect().top);
    await expect.poll(offset).toBeGreaterThanOrEqual(0);await expect.poll(offset).toBeLessThan(20);
    await expect(page.getByLabel('提示词编辑器')).toHaveValue('查找时保留的草稿');
    await page.screenshot({path:documentationPath('screenshots', 'conversation-history.png')});
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
