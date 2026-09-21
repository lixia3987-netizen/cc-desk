import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
