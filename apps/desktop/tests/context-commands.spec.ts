import { desktopRoot } from './helpers/paths';
import { electronLaunchArgs } from './helpers/electron-launch';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AppState, Session } from '../src/shared/types';

async function close(app: ElectronApplication) {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }).catch(() => {});
  await app.close();
}

async function workspace(options: { preserveReportedContext?: boolean; routedModelResponses?: boolean } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cc-context-')));
  const data = path.join(directory, 'data'), projectPath = path.join(directory, 'project');
  const prefix = path.join(directory, 'npm'), pkg = path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code');
  const log = path.join(directory, 'prompts.jsonl');
  await Promise.all([fs.mkdir(data), fs.mkdir(projectPath), fs.mkdir(pkg, { recursive: true }), fs.writeFile(log, '')]);
  const node = path.join(prefix, process.platform === 'win32' ? 'node.exe' : 'node');
  if (process.platform === 'win32') await fs.copyFile(process.execPath, node); else await fs.symlink(process.execPath, node);
  await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', bin: { claude: 'cli.js' } }));
  await fs.writeFile(path.join(pkg, 'cli.js'), `const log = ${JSON.stringify(log)};\nconst preserveReportedContext = ${JSON.stringify(options.preserveReportedContext ?? false)};\nconst routedModelResponses = ${JSON.stringify(options.routedModelResponses ?? false)};\n` + String.raw`
const readline = require('node:readline'), fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('Claude Code fixture 2.1.280'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--session-id --resume --permission-mode --model --effort --print --input-format --output-format --verbose --permission-prompt-tool --include-partial-messages'); process.exit(0); }
if (process.argv.includes('auth')) { console.log(JSON.stringify({loggedIn:true,authMethod:'fixture'})); process.exit(0); }
const flag = name => process.argv[process.argv.indexOf(name) + 1];
let session = process.argv.includes('--resume') ? flag('--resume') : flag('--session-id'), turn = 0;
const transcriptDir = require('node:path').join(process.env.CLAUDE_CONFIG_DIR,'projects','fixture');
fs.mkdirSync(transcriptDir,{recursive:true});
const commands = [{ name:'compact', description:'压缩当前会话上下文', argumentHint:'[保留内容]', builtin:true }, { name:'context', description:'查看上下文分布', builtin:true }, { name:'clear', description:'清空上下文', builtin:true }, { name:'team:review', description:'项目代码检查', argumentHint:'<检查目标>', builtin:false }];
const output = value => process.stdout.write(JSON.stringify(value)+'\n');
const model = preserveReportedContext || routedModelResponses ? 'claude-sonnet-4-6' : 'fixture-model';
const done = (result, modelUsage) => output({ type:'result', subtype:'success', session_id:session, result, ...(routedModelResponses ? {usage:{input_tokens:900000}, ...(modelUsage ? {modelUsage} : {})} : preserveReportedContext ? {} : {usage:{input_tokens:900000},modelUsage:{'fixture-model':{contextWindow:200000}}}), num_turns:1 });
readline.createInterface({input:process.stdin}).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request') { output({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response:{commands}}}); return; }
  if (frame.type !== 'user') return;
  const text = typeof frame.message.content === 'string' ? frame.message.content : frame.message.content[0].text;
  ++turn; fs.appendFileSync(log,JSON.stringify({text,content:frame.message.content,session:frame.session_id})+'\n');
  fs.appendFileSync(require('node:path').join(transcriptDir,session+'.jsonl'),JSON.stringify({type:'user',sessionId:session,cwd:process.cwd(),message:{role:'user',content:text}})+'\n');
  output({type:'system',subtype:'init',session_id:session,model,slash_commands:commands.map(item=>item.name),skills:['team:review']});
  if (text.startsWith('/compact')) {
    output({type:'system',subtype:'status',status:'compacting'});
    setTimeout(()=>{output({type:'system',subtype:'compact_boundary',compact_metadata:{trigger:'manual',pre_tokens:12000}});done('压缩已完成');},150); return;
  }
  if (text==='/clear') { session='33333333-3333-4333-8333-333333333333';output({type:'conversation_reset',new_conversation_id:session,session_id:session});done('上下文已清空');return; }
  if (text.startsWith('/team:review')) { commands.push({name:'new-skill',description:'新加载的 Skill',builtin:false});output({type:'system',subtype:'commands_changed',commands});done('已执行项目 Skill');return; }
  if (text==='/context') { output({type:'assistant',context_usage:{model:preserveReportedContext?'Sonnet 4.6':model,total_tokens:30000,raw_max_tokens:200000},message:{id:'report-'+turn,content:[{type:'text',text:'详细上下文报告'}]}});done('详细上下文报告');return; }
  if (routedModelResponses) {
    const missingUsage = text === '路由响应省略全部用量';
    const usage = missingUsage ? undefined : {input_tokens:2000,cache_read_input_tokens:9000,cache_creation_input_tokens:1000};
    const continuationUsage = missingUsage ? undefined : text === '路由响应省略窗口' ? {input_tokens:6000,cache_read_input_tokens:10000,cache_creation_input_tokens:2000} : {input_tokens:3000,cache_read_input_tokens:10000,cache_creation_input_tokens:1000};
    const toolId = 'read-'+turn;
    output({type:'stream_event',event:{type:'message_start',message:{id:'routed-'+turn,model,usage}}});
    output({type:'assistant',message:{id:'routed-'+turn,model:'routed-main',usage,content:[{type:'tool_use',id:toolId,name:'Read',input:{file_path:'README.md'}}]}});
    output({type:'user',message:{content:[{type:'tool_result',tool_use_id:toolId,content:'fixture project'}]}});
    output({type:'stream_event',event:{type:'message_start',message:{id:'continuation-'+turn,model:'routed-continuation',usage:continuationUsage}}});
    output({type:'assistant',message:{id:'continuation-'+turn,model:'routed-continuation-final',usage:continuationUsage,content:[{type:'text',text:'完成路由请求'}]}});
    output({type:'assistant',parent_tool_use_id:'child-'+turn,message:{model:'child-model',usage:{input_tokens:800000},content:[]}});
    output({type:'result',parent_tool_use_id:'child-'+turn,subtype:'success',result:'子任务已完成',modelUsage:{'child-model':{contextWindow:1000000}}});
    const modelUsage = text === '路由响应携带冲突窗口' ? {[model]:{contextWindow:200000},'routed-main':{contextWindow:64000},'routed-continuation':{contextWindow:64000},'routed-continuation-final':{contextWindow:64000},'child-model':{contextWindow:1000000}} : undefined;
    done('完成路由请求',modelUsage);return;
  }
  const usage = preserveReportedContext && text==='省略用量元数据' ? undefined : {input_tokens:2000,cache_read_input_tokens:9000,cache_creation_input_tokens:1000};
  output({type:'stream_event',event:{type:'message_start',message:{id:'message-'+turn,model,usage}}});
  output({type:'assistant',message:{id:'message-'+turn,model,usage,content:[{type:'text',text:'完成请求'}]}});
  output({type:'assistant',parent_tool_use_id:'child',message:{model:'child-model',usage:{input_tokens:800000},content:[]}});done('完成请求');
});
process.stdin.on('end',()=>process.exit(0));
`);
  const cli = path.join(prefix, 'claude.cmd');
  await fs.writeFile(cli, '@echo off\r\nexit /b 99\r\n', { mode: 0o755 });
  const now = new Date().toISOString(), project = { id: randomUUID(), name: 'Context 测试', path: projectPath, createdAt: now };
  const session: Session = { execution: { providerId: 'claude', mode: 'structured', conversationId: randomUUID() }, id: randomUUID(), projectId: project.id, title: '上下文与命令', kind: 'agent',  cwd: projectPath,  started: false, model: '', effort: 'default', permissionMode: 'default', status: 'idle', archived: false, createdAt: now, updatedAt: now };
  const state: AppState = { version: 2, projects: [project], sessions: [session], selectedSessionId: session.id, settings: { claudePath: cli, shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000, chatFontFamily: 'system', uiFontFamily: 'system' } };
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify(state));
  const launch = () => electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot, env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data, CLAUDE_CONFIG_DIR: path.join(directory, 'claude-config') } });
  return { launch, log, session, dispose: () => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

test('slash menu discovers commands without a model prompt, supports keyboard/IME/arguments and skill updates', async () => {
  const f = await workspace(), app = await f.launch();
  try {
    const page = await app.firstWindow(), input = page.getByLabel('提示词编辑器');
    await input.fill('/');
    try { await expect(page.getByRole('option', { name: /compact/ })).toBeVisible(); }
    catch (error) {
      await test.info().attach('initial-menu-state', { body: await page.locator('body').innerText(), contentType: 'text/plain' });
      await page.screenshot({ path: test.info().outputPath('initial-menu-failure.png') });
      throw error;
    }
    expect(await fs.readFile(f.log, 'utf8')).toBe('');
    await input.fill('/comp'); await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    await expect(input).toHaveValue('/comp');
    await input.press('Tab'); await expect(input).toHaveValue('/compact '); expect(await fs.readFile(f.log, 'utf8')).toBe('');
    await input.fill('/context'); await input.press('Escape'); await expect(page.getByRole('listbox')).toHaveCount(0);
    await input.fill('/team:r 检查测试');
    await input.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(8, 8));
    await input.press('ArrowLeft');
    await page.getByRole('option', { name: /team:review/ }).click(); await expect(input).toHaveValue('/team:review 检查测试');
    await input.press('Enter'); await expect(page.getByText('已执行项目 Skill', { exact: true })).toBeVisible();
    const record = JSON.parse((await fs.readFile(f.log, 'utf8')).trim()); expect(record.content).toBe('/team:review 检查测试');
    await input.fill('/new'); await expect(page.getByRole('option', { name: /new-skill/ })).toBeVisible();
    await input.fill('路径 /tmp/file'); await expect(page.getByRole('listbox')).toHaveCount(0);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 680));
    await input.fill('/'); await expect(page.getByRole('option', { name: /compact/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('slash-menu.png') });
  } finally { await close(app); await f.dispose(); }
});

test('context meter uses root request usage, invalidates after compact and clear, and persists reports', async () => {
  const f = await workspace(); let app = await f.launch();
  try {
    let page = await app.firstWindow(), input = page.getByLabel('提示词编辑器');
    await expect(page.locator('.context-meter')).toContainText('等待用量数据');
    await input.fill('查看项目'); await input.press('Enter');
    await expect(page.getByRole('progressbar', { name: '上下文占用' })).toHaveAttribute('aria-valuenow', '6');
    await expect(page.locator('.context-meter')).toContainText('12,000 / 200,000');
    await page.locator('.context-meter summary').click();
    await page.screenshot({ path: test.info().outputPath('context-meter.png') });
    await page.locator('.context-meter summary').click();
    await input.fill('/compact'); await input.press('Escape'); await input.press('Enter');
    await expect(page.locator('.context-meter')).toContainText('已压缩 · 等待更新用量');
    await expect(page.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    await input.fill('/context'); await input.press('Escape'); await input.press('Enter');
    await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '15');
    await close(app); app = await f.launch(); page = await app.firstWindow(); input = page.getByLabel('提示词编辑器');
    await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '15');
    await input.fill('/clear'); await input.press('Escape'); await input.press('Enter');
    await expect(page.locator('.context-meter')).toContainText('等待用量数据');
    await expect(page.getByText('查看项目', { exact: true })).toBeVisible();
    expect((await page.evaluate(() => window.desktop.snapshot())).state.sessions[0].execution.conversationId).toBe('33333333-3333-4333-8333-333333333333');
    await expect.poll(() => page.evaluate(async id => (await window.desktop.chatSnapshot(id)).taskState, f.session.id)).toBe('completed');
    expect((await page.evaluate(() => window.desktop.snapshot())).state.sessions[0].started).toBe(false);
    // The CLI has not written the new transcript yet. Relaunching immediately
    // after /clear must start that fresh identity rather than require --resume.
    await close(app); app = await f.launch(); page = await app.firstWindow(); input = page.getByLabel('提示词编辑器');
    await expect(page.getByText('查看项目', { exact: true })).toBeVisible();
    await input.fill('继续'); await input.press('Enter'); await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '6');
    await expect.poll(() => page.evaluate(async id => (await window.desktop.chatSnapshot(id)).taskState, f.session.id)).toBe('completed');
    expect((await page.evaluate(() => window.desktop.snapshot())).state.sessions[0].started).toBe(true);
    await close(app); app = await f.launch(); page = await app.firstWindow(); input = page.getByLabel('提示词编辑器');
    await input.fill('恢复清空后的新记录'); await input.press('Enter');
    await expect.poll(async () => (await fs.readFile(f.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).at(-1)?.text).toBe('恢复清空后的新记录');
    expect((await page.evaluate(() => window.desktop.snapshot())).state.sessions[0].execution.conversationId).toBe('33333333-3333-4333-8333-333333333333');
  } finally { await close(app); await f.dispose(); }
});


test('context reports retain capacity through alias changes, metadata gaps and stop/restart until clear', async () => {
  const f = await workspace({ preserveReportedContext: true }); let app = await f.launch();
  try {
    let page = await app.firstWindow();
    const send = async (text: string) => {
      const input = page.getByLabel('提示词编辑器');
      await input.fill(text);
      if (text.startsWith('/')) await input.press('Escape');
      await input.press('Enter');
      // Wait for the accepted turn to finish even when the displayed percentage is unchanged.
      await expect(input).toHaveValue('');
      await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeVisible();
    };
    const expectUsage = async (tokens: string, percentage: string) => {
      const meter = page.locator('.context-meter');
      await expect(meter.getByRole('progressbar', { name: '上下文占用' })).toHaveAttribute('aria-valuenow', percentage);
      await expect(meter).toContainText(`${tokens} / 200,000`);
      await expect(meter.locator('strong')).toHaveText(`${Number(percentage).toFixed(1)}%`);
    };

    // Only /context supplies a window; its display alias differs from the actual API model ID.
    await send('/context');
    await expectUsage('30,000', '15');
    await send('报告后的普通对话');
    await expectUsage('12,000', '6');
    await send('省略用量元数据');
    await expectUsage('12,000', '6');

    await page.evaluate(id => window.desktop.stopSession(id), f.session.id);
    await expectUsage('12,000', '6');
    await close(app); app = await f.launch(); page = await app.firstWindow();
    await expectUsage('12,000', '6');

    // Refreshing the report must not make the following normal request lose its capacity again.
    await send('/context');
    await expectUsage('30,000', '15');
    await send('再次报告后的普通对话');
    await expectUsage('12,000', '6');
    await send('/clear');
    await expect(page.locator('.context-meter')).toContainText('等待用量数据');
    await expect(page.locator('.context-meter')).not.toContainText('200,000');
    await expect(page.getByRole('progressbar', { name: '上下文占用' })).not.toHaveAttribute('aria-valuenow');

    await send('清空后的普通对话');
    await expect(page.locator('.context-meter')).toContainText('12,000 / 未知容量');
    await expect(page.getByRole('progressbar', { name: '上下文占用' })).not.toHaveAttribute('aria-valuenow');
  } finally { await close(app); await f.dispose(); }
});

test('context capacity follows the starting model across routed responses, tool continuations and later turns', async () => {
  const f = await workspace({ routedModelResponses: true }), app = await f.launch();
  try {
    const page = await app.firstWindow(), input = page.getByLabel('提示词编辑器');
    const send = async (text: string) => {
      await input.fill(text);
      if (text.startsWith('/')) await input.press('Escape');
      await input.press('Enter');
      await expect(input).toHaveValue('');
      // An unchanged percentage or the previous turn's completed state cannot
      // establish that this prompt has run; include its journal and queue state.
      await expect.poll(() => page.evaluate(async ({ id, text }) => {
        const snapshot = await window.desktop.chatSnapshot(id);
        return {
          received: snapshot.messages.some(message => message.role === 'user' && message.text === text),
          state: snapshot.taskState,
          queued: snapshot.queue?.items.length ?? 0,
        };
      }, { id: f.session.id, text })).toEqual({ received: true, state: 'completed', queued: 0 });
    };
    const expectUsage = async (tokens: string, percentage: string) => {
      const meter = page.locator('.context-meter');
      await expect(meter.getByRole('progressbar', { name: '上下文占用' })).toHaveAttribute('aria-valuenow', percentage);
      await expect(meter).toContainText(`${tokens} / 200,000`);
      const context = await page.evaluate(async id => (await window.desktop.chatSnapshot(id)).context, f.session.id);
      expect(context).toMatchObject({ requestModel: 'claude-sonnet-4-6', selectionModel: 'claude-sonnet-4-6', contextWindow: 200000 });
    };

    await send('/context');
    await expectUsage('30,000', '15');

    // The last root request uses 14k tokens. Neither the 900k result aggregate,
    // 800k child input nor routed/child window entries belong to this baseline.
    await send('路由响应携带冲突窗口');
    await expectUsage('14,000', '7');

    // The process remains selected on Claude even though its previous response
    // names another model; absent modelUsage must retain the reported 200k.
    await send('路由响应省略窗口');
    await expectUsage('18,000', '9');
    await send('路由响应省略全部用量');
    await expectUsage('18,000', '9');

    expect((await fs.readFile(f.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line).text)).toEqual([
      '/context', '路由响应携带冲突窗口', '路由响应省略窗口', '路由响应省略全部用量',
    ]);
  } finally { await close(app); await f.dispose(); }
});
