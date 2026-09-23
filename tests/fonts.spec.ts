import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppState, Session } from '../src/shared/types';
import type { ChatSnapshot } from '../src/shared/chat';
import { importedFamily } from '../src/shared/fonts';

async function workspace() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-desk-fonts-ui-'));
  const data = path.join(directory,'data'), projectPath = path.join(directory,'project'), now = new Date().toISOString();
  await fs.mkdir(path.join(data,'chat'), {recursive:true}); await fs.mkdir(projectPath);
  const project = {id:randomUUID(),name:'字体与阅读体验',path:await fs.realpath(projectPath),createdAt:now};
  const session: Session = {id:randomUUID(),projectId:project.id,cwd:project.path,claudeId:randomUUID(),title:'清晰阅读，自由设置',kind:'claude',adapter:'structured',started:false,model:'',effort:'default',permissionMode:'default',status:'idle',taskState:'completed',archived:false,createdAt:now,updatedAt:now};
  const state: AppState = {version:1,projects:[project],sessions:[session],selectedSessionId:session.id,settings:{claudePath:path.join(directory,'unavailable-claude'),shellPath:'',maxSessions:4,fontSize:14,scrollback:8000}};
  const chat: ChatSnapshot = {sessionId:session.id,taskState:'completed',pending:[],messages:[
    {id:'user',turnId:'turn',role:'user',createdAt:now,text:'让聊天和菜单使用不同的字体，并立即看到效果。'},
    {id:'assistant',turnId:'turn',role:'assistant',createdAt:now,text:'### 让每一行都清晰易读\n\n聊天正文、输入框与菜单可以分别设置。选择适合你的字号，不需要重启工作台。\n\n```typescript\nconst typography = { chat: 18, menu: 15 };\n```\n\n保存后，下次打开仍会保留。'},
  ]};
  await fs.writeFile(path.join(data,'workspace.json'),JSON.stringify(state));
  await fs.writeFile(path.join(data,'chat',session.id+'.json'),JSON.stringify(chat));
  const source = path.join(directory,'My imported font.woff2');
  await fs.copyFile(path.resolve('node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2'),source);
  const launch = () => electron.launch({args:['.',...(process.platform==='linux'?['--no-sandbox',`--ozone-platform=${process.env.DISPLAY?'x11':'headless'}`,'--disable-gpu']:[])],env:{...process.env,WORKBENCH_TEST_MODE:'1',WORKBENCH_DATA_DIR:data}});
  return {directory,data,source,launch,dispose:()=>fs.rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100})};
}
async function openSettings(page: Page) {
  await page.getByRole('button',{name:'设置与连接',exact:true}).click();
  return page.getByRole('dialog',{name:'设置与连接',exact:true});
}
async function picker(app: ElectronApplication, source: string | null) {
  await app.evaluate(({dialog},value) => {
    dialog.showOpenDialog = (async () => ({canceled:value===null,filePaths:value===null?[]:[value]})) as typeof dialog.showOpenDialog;
  },source);
}
async function fontLoaded(page: Page, family: string, sample = '中文 Aa 123') {
  return page.evaluate(async ({family,sample}) => {
    const faces = await document.fonts.load('16px "'+family+'"',sample);
    return faces.length>0 && faces.every(face=>face.status==='loaded');
  },{family,sample});
}

test('fonts: independent live previews, category drafts, cancellation and persistence without restarting sessions', async ({},testInfo) => {
  const f = await workspace(); let app = await f.launch();
  try {
    let page = await app.firstWindow();
    await expect(page.locator('.message-markdown').first()).toBeVisible();
    const chatSize = () => page.locator('.message-markdown').first().evaluate(el=>getComputedStyle(el).fontSize);
    const menuSize = () => page.locator('html').evaluate(el=>getComputedStyle(el).fontSize);
    await expect.poll(chatSize).toBe('12px'); await expect.poll(menuSize).toBe('13px');
    let settings = await openSettings(page);
    await settings.getByLabel('聊天字号',{exact:true}).fill('18');
    await expect.poll(chatSize).toBe('18px'); await expect.poll(menuSize).toBe('13px');
    await expect(page.locator('.composer textarea')).toHaveCSS('font-size','18px');
    await settings.getByLabel('菜单字号',{exact:true}).fill('16');
    await expect.poll(menuSize).toBe('16px'); await expect.poll(chatSize).toBe('18px');
    await settings.getByLabel('聊天字体',{exact:true}).selectOption('noto-sans-sc');
    await settings.getByLabel('菜单字体',{exact:true}).selectOption('jetbrains-mono');
    expect(await fontLoaded(page,'Noto Sans SC Variable')).toBe(true);
    expect(await fontLoaded(page,'JetBrains Mono Variable','Aa 123')).toBe(true);
    await expect(page.locator('.message-markdown').first()).toHaveCSS('font-family',/Noto Sans SC Variable/);
    await settings.getByRole('tab',{name:'连接与终端',exact:true}).click();
    await settings.getByLabel('终端字号',{exact:true}).fill('17');
    await settings.getByRole('tab',{name:'外观与字体',exact:true}).click();
    await expect(settings.getByLabel('聊天字号',{exact:true})).toHaveValue('18');
    expect((await page.evaluate(()=>window.desktop.snapshot())).state.settings.chatFontSize).toBe(12);
    await settings.getByRole('button',{name:'取消',exact:true}).click();
    await expect.poll(chatSize).toBe('12px'); await expect.poll(menuSize).toBe('13px');

    settings = await openSettings(page);
    await settings.getByLabel('聊天字号',{exact:true}).fill('18');
    await settings.getByLabel('菜单字号',{exact:true}).fill('15');
    await settings.getByLabel('聊天字体',{exact:true}).selectOption('noto-sans-sc');
    await settings.getByLabel('菜单字体',{exact:true}).selectOption('jetbrains-mono');
    await settings.getByRole('button',{name:'保存设置',exact:true}).click();
    await expect.poll(async()=>(await page.evaluate(()=>window.desktop.snapshot())).state.settings.chatFontSize).toBe(18);
    await expect(settings.getByRole('button',{name:'保存设置',exact:true})).toBeEnabled();
    await settings.getByRole('tab',{name:'外观与字体',exact:true}).click();
    await page.screenshot({path:testInfo.outputPath('font-settings.png')});
    await settings.getByRole('button',{name:'关闭弹窗',exact:true}).click();
    await page.screenshot({path:testInfo.outputPath('font-chat.png')});
    await app.close(); app=await f.launch(); page=await app.firstWindow();
    await expect.poll(chatSize).toBe('18px'); await expect.poll(menuSize).toBe('15px');
    expect(await fontLoaded(page,'Noto Sans SC Variable')).toBe(true);
    const saved = (await page.evaluate(()=>window.desktop.snapshot())).state.settings;
    expect(saved.chatFontFamily).toBe('noto-sans-sc'); expect(saved.uiFontFamily).toBe('jetbrains-mono');
    expect(saved.fontSize).toBe(14);
  } finally {await app.close();await f.dispose();}
});

test('fonts: a workspace using the retired built-in opens with system fonts and keeps its sessions and sizes', async () => {
  const f = await workspace();
  const file = path.join(f.data,'workspace.json'), original = JSON.parse(await fs.readFile(file,'utf8'));
  Object.assign(original.settings,{chatFontFamily:'noto-serif-sc',uiFontFamily:'noto-serif-sc',chatFontSize:19,uiFontSize:16});
  await fs.writeFile(file,JSON.stringify(original));
  const app = await f.launch();
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('heading',{name:'清晰阅读，自由设置',exact:true})).toBeVisible();
    await expect(page.locator('.message-markdown').first()).toHaveCSS('font-size','19px');
    await expect(page.locator('html')).toHaveCSS('font-size','16px');
    const settings = await openSettings(page);
    for (const label of ['聊天字体','菜单字体']) {
      const selector = settings.getByLabel(label,{exact:true});
      await expect(selector).toHaveValue('system');
      await expect(selector.locator('option[value="noto-serif-sc"]')).toHaveCount(0);
    }
    const snapshot = (await page.evaluate(()=>window.desktop.snapshot())).state;
    expect(snapshot.sessions.map(session=>session.id)).toEqual(original.sessions.map((session:Session)=>session.id));
    expect(snapshot.settings.fontSize).toBe(original.settings.fontSize);
    await settings.getByRole('button',{name:'保存设置',exact:true}).click();
    await expect.poll(async()=>JSON.parse(await fs.readFile(file,'utf8')).settings.chatFontFamily).toBe('system');
    expect(JSON.parse(await fs.readFile(file,'utf8')).settings.uiFontFamily).toBe('system');
  } finally {await app.close();await f.dispose();}
});

test('fonts: native import, duplicate detection, source-independent restart and removal fallback', async () => {
  const f = await workspace(); let app = await f.launch();
  try {
    let page = await app.firstWindow(), settings = await openSettings(page);
    await picker(app,null); await settings.getByRole('button',{name:'导入字体',exact:true}).click();
    await expect(settings.getByRole('button',{name:'导入字体',exact:true})).toBeEnabled();
    expect(await page.evaluate(()=>window.desktop.listFonts())).toEqual([]);
    await picker(app,f.source); await settings.getByRole('button',{name:'导入字体',exact:true}).click();
    await expect(settings.locator('.imported-fonts li')).toHaveCount(1);
    await expect(settings.getByRole('button',{name:'导入字体',exact:true})).toBeEnabled();
    await settings.getByRole('button',{name:'导入字体',exact:true}).click();
    await expect(settings.getByRole('button',{name:'导入字体',exact:true})).toBeEnabled();
    expect(await page.evaluate(()=>window.desktop.listFonts())).toHaveLength(1);
    const [font] = await page.evaluate(()=>window.desktop.listFonts());
    await settings.getByLabel('聊天字体',{exact:true}).selectOption(font.id);
    await settings.getByLabel('菜单字体',{exact:true}).selectOption(font.id);
    expect(await fontLoaded(page,importedFamily(font.id),'Aa 123')).toBe(true);
    await settings.getByRole('button',{name:'保存设置',exact:true}).click();
    await expect.poll(async()=>(await page.evaluate(()=>window.desktop.snapshot())).state.settings.uiFontFamily).toBe(font.id);
    await app.close(); await fs.unlink(f.source);
    app=await f.launch(); page=await app.firstWindow();
    await expect(page.locator('.message-markdown').first()).toHaveCSS('font-family',new RegExp(importedFamily(font.id)));
    await expect.poll(()=>fontLoaded(page,importedFamily(font.id),'Aa 123')).toBe(true);
    settings=await openSettings(page);
    await settings.getByRole('button',{name:'移除字体 My imported font',exact:true}).click();
    await expect(settings.locator('.imported-fonts li')).toHaveCount(0);
    await expect(settings.getByLabel('聊天字体',{exact:true})).toHaveValue('system');
    await expect(settings.getByLabel('菜单字体',{exact:true})).toHaveValue('system');
    const saved = (await page.evaluate(()=>window.desktop.snapshot())).state.settings;
    expect(saved.chatFontFamily).toBe('system'); expect(saved.uiFontFamily).toBe('system');
    await expect(page.evaluate(id=>window.desktop.readFont(id),font.id)).rejects.toThrow();
    await expect(page.evaluate(()=>window.desktop.readFont('/etc/passwd'))).rejects.toThrow();
  } finally {await app.close();await f.dispose();}
});

test('fonts: corrupted glyph data is rolled back, and invalid sizes return to their category', async () => {
  const f = await workspace(), app=await f.launch();
  try {
    const page=await app.firstWindow(), settings=await openSettings(page);
    // A bounded sfnt container passes the main-process header check but OTS rejects its absent glyph tables.
    const invalid=Buffer.alloc(28); invalid.writeUInt32BE(0x00010000); invalid.writeUInt16BE(1,4);
    const source=path.join(f.directory,'broken.ttf'); await fs.writeFile(source,invalid);
    await picker(app,source); await settings.getByRole('button',{name:'导入字体',exact:true}).click();
    await expect(settings.getByRole('alert')).toContainText('已撤销导入');
    expect(await page.evaluate(()=>window.desktop.listFonts())).toEqual([]);
    expect(await fs.readFile(source)).toEqual(invalid);
    await settings.getByLabel('聊天字号',{exact:true}).fill('99');
    await settings.getByRole('tab',{name:'通知与后台',exact:true}).click();
    await settings.getByRole('button',{name:'保存设置',exact:true}).click();
    await expect(settings.getByRole('tab',{name:'外观与字体',exact:true})).toHaveAttribute('aria-selected','true');
    await expect(settings.getByRole('alert')).toContainText('11–28');
    expect((await page.evaluate(()=>window.desktop.snapshot())).state.settings.chatFontSize).toBe(12);
    await expect(page.evaluate(async()=>{const {state}=await window.desktop.snapshot();await window.desktop.saveSettings({...state.settings,uiFontFamily:('imported:'+'a'.repeat(64)) as never});})).rejects.toThrow();
  } finally {await app.close();await f.dispose();}
});

test('fonts: large sizes and category keyboard navigation remain usable in a small window', async ({},testInfo) => {
  const f = await workspace(), app=await f.launch();
  try {
    const page=await app.firstWindow(), settings=await openSettings(page);
    await settings.getByLabel('聊天字号',{exact:true}).fill('28');
    await settings.getByLabel('菜单字号',{exact:true}).fill('20');
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(980,680));
    for(const name of ['外观与字体','连接与终端','会话与权限','工作区与 IDE','通知与后台']) {
      await settings.getByRole('tab',{name,exact:true}).click();
      await expect(settings.getByRole('button',{name:'保存设置',exact:true})).toBeInViewport({ratio:1});
      expect(await settings.locator('.settings-content').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
    }
    const last=settings.getByRole('tab',{name:'通知与后台',exact:true}); await last.focus();
    await page.keyboard.press('Home');
    await expect(settings.getByRole('tab',{name:'外观与字体',exact:true})).toBeFocused();
    await expect(settings.getByLabel('聊天字号',{exact:true})).toHaveValue('28');
    await page.keyboard.press('ArrowDown');
    await expect(settings.getByRole('tab',{name:'连接与终端',exact:true})).toBeFocused();
    await page.screenshot({path:testInfo.outputPath('settings-small-large-font.png')});
    await settings.getByRole('button',{name:'取消',exact:true}).click();
    await expect(page.locator('html')).toHaveCSS('font-size','13px');
  } finally {await app.close();await f.dispose();}
});
