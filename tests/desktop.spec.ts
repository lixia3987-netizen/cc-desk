import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('desktop: real terminal, session switching, rename/archive, persistence and settings',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'workbench-desktop-'));
  const project=path.join(directory,'项目 with spaces');await fs.mkdir(project);
  const launch=()=>electron.launch({args:['.',...(process.platform==='linux'?['--no-sandbox',`--ozone-platform=${process.env.DISPLAY?'x11':'headless'}`,'--disable-gpu']:[])],env:{...process.env,WORKBENCH_TEST_MODE:'1',WORKBENCH_DATA_DIR:path.join(directory,'data')}});
  let app=await launch();
  try{
    let page=await app.firstWindow();
    const rendererErrors:string[]=[];page.on('pageerror',error=>rendererErrors.push(error.message));
    await expect(page.getByRole('heading',{name:/让每个想法/})).toBeVisible();
    await page.screenshot({path:'docs/screenshots/workspace.png'});
    await page.evaluate(p=>window.desktop.addProject(p),project);
    await page.getByRole('button',{name:/新建会话/}).click();
    await page.getByLabel('会话名称',{exact:true}).fill('终端验证');
    await page.getByRole('button',{name:'Shell 终端',exact:true}).click();
    await page.getByRole('button',{name:'创建会话',exact:true}).click();
    await page.getByRole('button',{name:'启动会话',exact:true}).click();
    await expect(page.locator('.status-tag')).toContainText('运行中');
    await page.locator('.terminal-host').click();
    await page.keyboard.type(process.platform==='win32'?"Write-Output 'DESKTOP_PTY_OK'":"printf '\\nDESKTOP_PTY_OK\\n'");await page.keyboard.press('Enter');
    await expect.poll(()=>page.evaluate(async()=>{const s=await window.desktop.snapshot();return (await window.desktop.terminalSnapshot(s.state.sessions[0].id)).chunks.map(x=>x.data).join('');})).toContain('DESKTOP_PTY_OK');
    await page.getByRole('button',{name:'重命名',exact:true}).click();
    await page.getByLabel('新的会话名称').fill('已验证的项目终端');await page.getByRole('button',{name:'保存',exact:true}).click();
    await expect(page.getByRole('heading',{name:'已验证的项目终端'})).toBeVisible();
    await page.getByRole('button',{name:/新建会话/}).click();await page.getByLabel('会话名称',{exact:true}).fill('功能开发');await page.getByRole('button',{name:'创建会话',exact:true}).click();
    await page.getByRole('button',{name:/已验证的项目终端.*运行中/}).click();
    await expect(page.locator('.status-tag')).toContainText('运行中');
    await page.screenshot({path:'docs/screenshots/terminal.png'});
    await page.getByRole('button',{name:'停止',exact:true}).click();
    await expect(page.locator('.status-tag')).toContainText('已停止');
    await page.getByRole('button',{name:'归档会话',exact:true}).click();
    await page.getByRole('button',{name:'查看归档',exact:true}).click();
    await page.getByRole('button',{name:/已验证的项目终端.*已停止/}).click();
    await page.getByRole('button',{name:'取消归档',exact:true}).click();
    await page.getByRole('button',{name:'设置与连接',exact:false}).click();
    await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('button',{name:'关闭弹窗'}).click();
    expect(rendererErrors).toEqual([]);
    await app.close();app=await launch();page=await app.firstWindow();
    await expect(page.getByRole('button',{name:/已验证的项目终端.*已停止/})).toBeVisible();
    const state=await page.evaluate(async()=>(await window.desktop.snapshot()).state);
    expect(state.projects[0].path).toBe(project);expect(state.sessions).toHaveLength(2);
    await expect(page.evaluate(()=>window.desktop.createSession({projectId:'invalid',title:'x',kind:'shell',model:'',effort:'default',permissionMode:'default',isolated:false}))).rejects.toThrow();
  }finally{
    const page=await app.firstWindow().catch(()=>null);
    if(page)await page.evaluate(async()=>{const s=await window.desktop.snapshot();for(const session of s.state.sessions)await window.desktop.stopSession(session.id);}).catch(()=>{});
    await app.close();await fs.rm(directory,{recursive:true,force:true});
  }
});

test('desktop: structured IPC, approvals, questions, draft isolation, diff feedback and restart',async()=>{
  test.setTimeout(90000);
  test.skip(process.platform==='win32','The protocol fixture is a POSIX executable; Windows uses the real Shell desktop test.');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'workbench-chat-desktop-'));
  const project=path.join(directory,'项目 with spaces');await fs.mkdir(project);
  execFileSync('git',['init'],{cwd:project});execFileSync('git',['config','user.email','test@example.invalid'],{cwd:project});execFileSync('git',['config','user.name','Desktop Test'],{cwd:project});
  await fs.writeFile(path.join(project,'example.ts'),'export const value = 1;\n');execFileSync('git',['add','.'],{cwd:project});execFileSync('git',['commit','-m','fixture'],{cwd:project});await fs.writeFile(path.join(project,'example.ts'),'export const value = 2;\n');
  const fixture=path.join(directory,'claude-fixture');
  await fs.writeFile(fixture,`#!${process.execPath}\n`+String.raw`
const readline=require('node:readline');
if(process.argv.includes('--version')){console.log('Claude Code fixture 2.1.0');process.exit(0);}
if(process.argv.includes('--help')){console.log('--session-id --resume --fork-session --permission-mode --model --effort --print --input-format --output-format --verbose --permission-prompt-tool --include-partial-messages\n--effort <level> low medium high max');process.exit(0);}
if(process.argv.includes('auth')){console.log(JSON.stringify({loggedIn:true,authMethod:'fixture'}));process.exit(0);}
const flag=name=>process.argv[process.argv.indexOf(name)+1];
const session=process.argv.includes('--session-id')?flag('--session-id'):flag('--resume');
const output=value=>process.stdout.write(JSON.stringify(value)+'\n');let turn=0,pending;
const done=text=>{output({type:'assistant',message:{id:'msg-'+turn,content:[{type:'text',text}]}});output({type:'result',subtype:'success',is_error:false,result:text,session_id:session,usage:{input_tokens:10,output_tokens:5},duration_ms:30,total_cost_usd:0.001,num_turns:1});};
readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);
  if(m.type==='control_request'){output({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}});if(m.request.subtype==='interrupt'){pending=undefined;done('已中断');}return;}
  if(m.type==='user'){
    ++turn;const text=m.message.content[0].text;
    output({type:'system',subtype:'init',session_id:session,model:'fixture-model',permissionMode:'default',mcp_servers:[{name:'memory',status:'connected'}]});
    if(text==='approve'||text==='deny'||text==='question'){
      const question=text==='question';const input=question?{questions:[{question:'使用哪个数据库？',options:[{label:'SQLite',description:'本地数据库'},{label:'Postgres'}],multiSelect:false}]}:{command:'echo fixture',description:'协议测试，不执行命令'};
      const name=question?'AskUserQuestion':'Bash';pending={id:'approval-'+turn,question};
      output({type:'assistant',message:{id:'tools-'+turn,content:[{type:'tool_use',id:'tool-'+turn,name,input}]}});
      output({type:'control_request',request_id:pending.id,request:{subtype:'can_use_tool',tool_name:name,input,tool_use_id:'tool-'+turn}});return;
    }
    done(text==='html'?'<img src=x onerror="alert(1)">':'执行结果');return;
  }
  if(m.type==='control_response'&&pending&&m.response.request_id===pending.id){const response=m.response.response;const text=response.behavior==='deny'?'已拒绝':pending.question?'选择：'+response.updatedInput.answers['使用哪个数据库？']:'已批准';pending=undefined;done(text);}
});
`,{mode:0o755});
  const launch=()=>electron.launch({args:['.',...(process.platform==='linux'?['--no-sandbox',`--ozone-platform=${process.env.DISPLAY?'x11':'headless'}`,'--disable-gpu']:[])],env:{...process.env,WORKBENCH_TEST_MODE:'1',WORKBENCH_DATA_DIR:path.join(directory,'data')}});
  let app=await launch();
  try{
    let page=await app.firstWindow();const rendererErrors:string[]=[];page.on('pageerror',error=>rendererErrors.push(error.message));
    await expect(page.getByRole('heading',{name:/让每个想法/})).toBeVisible();
    await page.evaluate(p=>window.desktop.addProject(p),project);
    await page.getByRole('button',{name:'设置与连接',exact:false}).click();await page.getByLabel('Claude Code 路径').fill(fixture);await page.getByRole('button',{name:'保存设置',exact:true}).click();await expect(page.getByText('设置已保存并重新检测')).toBeVisible();await page.getByRole('button',{name:'关闭弹窗'}).click();
    const create=async(title:string)=>{await page.getByRole('button',{name:/新建会话/}).click();await page.getByLabel('会话名称',{exact:true}).fill(title);await page.getByRole('button',{name:'创建会话',exact:true}).click();await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();};
    await create('会话 A');await page.getByLabel('提示词编辑器').fill('A 的独立草稿');
    await create('会话 B');await expect(page.getByLabel('提示词编辑器')).toHaveValue('');await page.getByLabel('提示词编辑器').fill('B 的独立草稿');
    await page.locator('.session-row').filter({hasText:'会话 A'}).click();await expect(page.getByLabel('提示词编辑器')).toHaveValue('A 的独立草稿');
    await page.locator('.session-row').filter({hasText:'会话 B'}).click();
    await expect.poll(()=>page.evaluate(async()=>{const s=(await window.desktop.snapshot()).state;return s.sessions.find(x=>x.id===s.selectedSessionId)?.draft;})).toBe('B 的独立草稿');
    await app.close();app=await launch();page=await app.firstWindow();page.on('pageerror',error=>rendererErrors.push(error.message));
    await expect(page.getByRole('heading',{name:'会话 B',exact:true})).toBeVisible();await expect(page.getByLabel('提示词编辑器')).toHaveValue('B 的独立草稿');
    await page.locator('.session-row').filter({hasText:'会话 A'}).click();await page.getByLabel('提示词编辑器').fill('approve');await page.getByRole('button',{name:'发送任务',exact:true}).click();
    await expect(page.getByRole('region',{name:'工具审批'})).toBeVisible();await expect(page.locator('.status-tag').first()).toContainText('等待审批');
    await page.locator('.session-row').filter({hasText:'会话 B'}).click();await expect(page.getByRole('region',{name:'工具审批'})).toHaveCount(0);await expect(page.getByLabel('提示词编辑器')).toHaveValue('B 的独立草稿');
    await page.locator('.session-row').filter({hasText:'会话 A'}).click();await page.getByLabel('提示词编辑器').fill('审批期间写的新草稿');await page.screenshot({path:'docs/screenshots/approval.png'});await page.getByRole('button',{name:'允许本次',exact:true}).click();await expect(page.locator('.chat-message.assistant')).toContainText('已批准');await expect(page.getByLabel('提示词编辑器')).toHaveValue('审批期间写的新草稿');
    await page.getByLabel('提示词编辑器').fill('question');await page.getByRole('button',{name:'发送任务',exact:true}).click();await page.getByRole('button',{name:/SQLite/}).click();await page.getByRole('button',{name:'提交回答',exact:true}).click();await expect(page.locator('.chat-message.assistant').last()).toContainText('选择：SQLite');
    await expect(page.getByRole('button',{name:'发送任务',exact:true})).toBeVisible();await page.getByLabel('提示词编辑器').fill('deny');await page.getByRole('button',{name:'发送任务',exact:true}).click();await page.getByRole('button',{name:'拒绝',exact:true}).click();await expect(page.locator('.chat-message.assistant').last()).toContainText('已拒绝');
    await expect(page.getByRole('button',{name:'发送任务',exact:true})).toBeVisible();await page.getByLabel('提示词编辑器').fill('html');await page.getByRole('button',{name:'发送任务',exact:true}).click();await expect(page.locator('.chat-message.assistant').last()).toContainText('<img');await expect(page.locator('.chat-message img')).toHaveCount(0);
    await page.getByRole('tab',{name:'变更',exact:true}).click();await page.locator('.changed-files button').filter({hasText:'example.ts'}).click();await expect(page.getByLabel('代码差异')).toContainText('+export const value = 2;');await page.getByLabel('代码审阅反馈').fill('改成命名常量');await page.getByRole('button',{name:'将审阅意见加入草稿'}).click();await expect(page.getByLabel('提示词编辑器')).toHaveValue(/example\.ts/);await expect(page.getByLabel('提示词编辑器')).toHaveValue(/改成命名常量/);
    await page.getByRole('button',{name:'引用项目文件',exact:true}).click();await page.getByLabel('选择 example.ts',{exact:true}).check();await page.getByRole('button',{name:'添加到上下文',exact:true}).click();await expect(page.getByLabel('提示词编辑器')).toHaveValue(/@"example\.ts"/);
    await page.screenshot({path:'docs/screenshots/structured-chat.png'});
    await page.getByRole('tab',{name:'工作流',exact:true}).click();await page.getByLabel('工作流目标').fill('验证阶段执行与人工继续');await page.getByRole('button',{name:'创建工作流',exact:true}).click();await page.getByRole('button',{name:'开始',exact:true}).click();
    await expect(page.locator('.workflow-run>header .status-tag')).toHaveText('等待继续');await expect(page.locator('.workflow-stage.completed')).toHaveCount(1);await page.getByRole('button',{name:'继续',exact:true}).click();
    await expect(page.locator('.workflow-stage.completed')).toHaveCount(2);await page.getByRole('button',{name:'继续',exact:true}).click();await expect(page.locator('.workflow-run>header .status-tag')).toHaveText('已完成');await expect(page.locator('.workflow-stage.completed')).toHaveCount(3);
    await page.screenshot({path:'docs/screenshots/workflow.png'});
    await page.keyboard.press(process.platform==='darwin'?'Meta+k':'Control+k');await expect(page.getByRole('dialog',{name:'命令面板'})).toBeVisible();await page.getByLabel('查找命令与会话').fill('会话 B');await page.locator('.palette-results button').filter({hasText:'会话 B'}).click();await expect(page.getByRole('heading',{name:'会话 B',exact:true})).toBeVisible();
    expect(rendererErrors).toEqual([]);
  }finally{
    const page=await app.firstWindow().catch(()=>null);if(page)await page.evaluate(async()=>{for(const session of (await window.desktop.snapshot()).state.sessions)await window.desktop.stopSession(session.id);}).catch(()=>{});
    await app.close();await fs.rm(directory,{recursive:true,force:true});
  }
});
