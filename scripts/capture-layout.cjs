const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {randomUUID}=require('node:crypto'),{execFileSync}=require('node:child_process');
const {_electron:electron,expect}=require('@playwright/test');
(async()=>{
 if(process.platform==='linux'&&!process.env.DISPLAY?.trim())throw new Error('Linux 界面截图需要 X11 DISPLAY，请安装 xvfb/xauth 后运行 xvfb-run -a node scripts/capture-layout.cjs。');
 const repository=path.resolve(__dirname,'..'),root=path.join(repository,'docs/screenshots'),workspace=await fs.mkdtemp(path.join(os.tmpdir(),'cc-desk-layout-'));
 await fs.mkdir(root,{recursive:true});
 const project=path.join(workspace,'cc-desk'),data=path.join(workspace,'data');
 await fs.mkdir(path.join(project,'src'),{recursive:true});await fs.mkdir(path.join(data,'chat'),{recursive:true});
 const git=(...args)=>execFileSync('git',args,{cwd:project,stdio:'pipe'});
 git('init','--quiet','-b','main');git('config','user.name','UI Preview');git('config','user.email','preview@example.invalid');
 await fs.writeFile(path.join(project,'src/chat-history.ts'),'export const PAGE_SIZE = 400;\n\nexport function historyOptions() {\n  return { pageSize: PAGE_SIZE, preservePosition: false };\n}\n');
 await fs.writeFile(path.join(project,'src/appearance.ts'),'export const theme = "forest";\nexport const followLatest = true;\n');
 git('add','.');git('commit','--quiet','-m','Preview fixture');
 await fs.writeFile(path.join(project,'src/chat-history.ts'),'export const PAGE_SIZE = 50;\n\nexport function historyOptions() {\n  return { pageSize: PAGE_SIZE, preservePosition: true };\n}\n');
 await fs.writeFile(path.join(project,'src/appearance.ts'),'export const theme = "forest";\nexport const followLatest = false;\n');
 const now='2026-09-22T12:00:00.000Z',projectId=randomUUID(),selectedId=randomUUID(),otherId=randomUUID(),otherPath=path.join(workspace,'automation');
 await fs.mkdir(otherPath);
 const base={projectId,cwd:project,started:false,model:'',effort:'default',permissionMode:'default',status:'idle',archived:false,createdAt:now,updatedAt:now};
 const sessions=[
 {...base,id:selectedId,claudeId:randomUUID(),title:'对话体验与界面打磨',kind:'claude',adapter:'structured',taskState:'completed',draft:'请继续检查消息区的阅读体验，保留现有草稿和滚动位置。'},
 {...base,id:randomUUID(),claudeId:randomUUID(),title:'历史检索与审批入口',kind:'claude',adapter:'structured',taskState:'completed'},
 {...base,id:randomUUID(),claudeId:randomUUID(),projectId:otherId,cwd:otherPath,title:'本地脚本整理',kind:'claude',adapter:'structured',taskState:'idle'},
 {...base,id:randomUUID(),claudeId:randomUUID(),projectId:otherId,cwd:otherPath,title:'项目终端',kind:'shell',adapter:'terminal'}];
 await fs.writeFile(path.join(data,'workspace.json'),JSON.stringify({version:1,projects:[{id:projectId,name:'cc-desk 桌面客户端',path:project,createdAt:now},{id:otherId,name:'工具与自动化',path:otherPath,createdAt:now}],sessions,selectedSessionId:selectedId,settings:{claudePath:path.join(workspace,'not-installed-claude'),shellPath:'',maxSessions:4,fontSize:14,scrollback:8000,theme:'forest',notifications:false}}));
 await fs.writeFile(path.join(data,'chat',selectedId+'.json'),JSON.stringify({sessionId:selectedId,taskState:'completed',pending:[],model:'示例对话',messages:[
 {id:'preview-user',turnId:'preview',role:'user',createdAt:now,text:'继续打磨桌面端体验：补齐会话内搜索、旧消息分页和统一待审批入口，同时保持五套主题的阅读清晰度。'},
 {id:'preview-assistant',turnId:'preview',role:'assistant',createdAt:now,text:['### 对话检索与待处理入口','通过上方的 **查找消息** 定位历史内容；读取旧消息时保留当前位置，点击 **跳到最新消息** 恢复跟随。','- **会话内查找**：支持消息正文和工具内容，点击结果直达原消息。\n- **历史记录分页**：每页最多 50 条，切换会话后继续阅读。\n- **统一待处理**：顶栏集中显示各项目的审批与提问。','```typescript\nconst readingOptions = {\n  pageSize: 50,\n  preservePosition: true,\n  followLatest: false,\n};\n```','右侧可以查看文件差异并填写审阅意见，意见会加入当前会话草稿。'].join('\n\n')}]}));
 let app;
 try{
  app=await electron.launch({args:['.',...(process.platform==='linux'?['--no-sandbox','--ozone-platform=x11','--disable-gpu']:[])],cwd:repository,env:{...process.env,WORKBENCH_TEST_MODE:'1',WORKBENCH_DATA_DIR:data}});
  const page=await app.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1600,1000));
  await expect(page.getByRole('heading',{name:'对话体验与界面打磨',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'变更',exact:true}).click();await page.locator('.changed-files button').filter({hasText:'src/chat-history.ts'}).click();
  await expect(page.getByLabel('代码差异')).toContainText('+export const PAGE_SIZE = 50;');
  await page.getByLabel('代码审阅反馈').fill('分页后继续保持阅读位置；切换会话时不要丢失未发送草稿。');
  await page.evaluate(()=>document.fonts.ready.then(()=>undefined));
  await page.locator('.chat-scroll').evaluate(async element=>{element.scrollTop=0;for(let i=0;i<12;i++)await new Promise(resolve=>requestAnimationFrame(resolve));});
  await page.mouse.move(1550,970);if(errors.length)throw new Error(errors.join('\n'));
  console.log('LAYOUT '+JSON.stringify(await page.evaluate(()=>({messagesTop:document.querySelector('.chat-scroll').getBoundingClientRect().top,headerHeight:document.querySelector('.session-header').getBoundingClientRect().height}))));
  await page.screenshot({path:path.join(root,'project-layout.png'),fullPage:false,animations:'disabled'});
  console.log(JSON.stringify({screenshot:path.join(root,'project-layout.png'),size:await page.evaluate(()=>({width:innerWidth,height:innerHeight})),theme:'forest',source:'current-working-tree',sampleData:true}));
 }finally{if(app)await app.close();await fs.rm(workspace,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
