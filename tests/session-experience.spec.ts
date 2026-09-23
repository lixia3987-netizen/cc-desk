import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { AppState } from '../src/shared/types';

interface FixtureRecord { event: 'start' | 'prompt'; mode: 'structured' | 'terminal'; session: string; pid: number; resume?: boolean; text?: string }

/** Both adapters use real processes; only the account-dependent Claude executable is replaced. */
async function workspace(nativeHooks = true) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cc-desk-session-experience-')));
  const data = path.join(directory, 'data'), projectPath = path.join(directory, '项目 with spaces');
  const prefix = path.join(directory, 'npm CLI'), pkg = path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code');
  const log = path.join(directory, 'protocol.jsonl'), commands = path.join(directory, 'commands.json'), ack = path.join(directory, 'ack.txt');
  const claudeConfig = path.join(directory, 'claude-config');
  await Promise.all([fs.mkdir(data), fs.mkdir(projectPath), fs.mkdir(pkg, { recursive: true })]);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: projectPath, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Session Test'); git('config', 'user.email', 'tests@example.invalid');
  await fs.writeFile(path.join(projectPath, 'README.md'), 'Session experience fixture\n');
  git('add', '.'); git('commit', '-m', 'Fixture');
  await fs.writeFile(commands, '[]'); await fs.writeFile(log, '');
  const node = path.join(prefix, process.platform === 'win32' ? 'node.exe' : 'node');
  if (process.platform === 'win32') await fs.copyFile(process.execPath, node); else await fs.symlink(process.execPath, node);
  await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', bin: { claude: 'cli.js' } }));
  await fs.writeFile(path.join(pkg, 'cli.js'), `const logFile = ${JSON.stringify(log)}, commandsFile = ${JSON.stringify(commands)}, ackFile = ${JSON.stringify(ack)}, nativeHooks = ${nativeHooks};\n` + String.raw`
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
if (process.argv.includes('--version')) { console.log('Claude Code fixture ' + (nativeHooks ? '2.1.251' : '2.1.0')); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--session-id --resume --fork-session --permission-mode --model --effort --print --input-format --output-format --verbose --permission-prompt-tool --include-partial-messages --settings\n--effort <level> low medium high max'); process.exit(0); }
if (process.argv.includes('auth')) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'fixture' })); process.exit(0); }
const flag = name => process.argv[process.argv.indexOf(name) + 1];
const session = process.argv.includes('--session-id') ? flag('--session-id') : flag('--resume');
const mode = process.argv.includes('--print') ? 'structured' : 'terminal';
const record = extra => fs.appendFileSync(logFile, JSON.stringify({ mode, session, pid: process.pid, ...extra }) + '\n');
record({ event: 'start', resume: process.argv.includes('--resume') });
const transcriptDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'fixture');
fs.mkdirSync(transcriptDir, { recursive: true });
let turn = 0, waiting = false, cursor = JSON.parse(fs.readFileSync(commandsFile, 'utf8')).length;
const remember = text => {
  record({ event: 'prompt', text });
  fs.appendFileSync(path.join(transcriptDir, session + '.jsonl'), JSON.stringify({ type: 'user', sessionId: session, cwd: process.cwd(), message: { role: 'user', content: text } }) + '\n');
};
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
const done = () => {
  waiting = false;
  output({ type: 'assistant', message: { id: 'answer-' + process.pid + '-' + turn, content: [{ type: 'text', text: '本轮任务已完成。' }] } });
  output({ type: 'result', subtype: 'success', session_id: session, result: '本轮任务已完成。', is_error: false, num_turns: 1 });
};
if (mode === 'structured') {
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const frame = JSON.parse(line);
    if (frame.type === 'control_request') {
      output({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
      if (frame.request.subtype === 'interrupt' && waiting) done();
    } else if (frame.type === 'user') {
      const text = frame.message.content.filter(value => value.type === 'text').map(value => value.text).join('\n');
      ++turn; remember(text);
      output({ type: 'system', subtype: 'init', session_id: session, model: 'fixture-model', permissionMode: 'default' });
      if (text.startsWith('保持运行')) waiting = true; else done();
    }
  });
  const timer = setInterval(() => {
    let commands; try { commands = JSON.parse(fs.readFileSync(commandsFile, 'utf8')); } catch { return; }
    for (; cursor < commands.length; cursor++) {
      if (commands[cursor] === 'complete' && waiting) done();
      fs.writeFileSync(ackFile, String(cursor + 1));
    }
  }, 20);
  process.stdin.on('end', () => { clearInterval(timer); process.exit(0); });
} else {
  const settings = process.argv.includes('--settings') ? JSON.parse(flag('--settings')) : undefined;
  const hook = async (name, extra = {}) => {
    if (!settings) return;
    const handler = settings.hooks[name][0].hooks[0];
    const response = await fetch(handler.url, { method: 'POST', headers: { ...handler.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ hook_event_name: name, session_id: session, cwd: process.cwd(), ...extra }) });
    if (!response.ok) throw new Error('Fixture hook failed: ' + response.status);
    await response.text();
  };
  let buffer = '', input = '', pasting = false, work = Promise.resolve();
  process.stdin.setRawMode(true); process.stdin.setEncoding('utf8'); process.stdin.resume();
  process.stdin.on('data', chunk => {
    buffer += chunk;
    while (buffer.length) {
      if (buffer[0] === '\x1b') {
        if (buffer.length < 6) break;
        if (buffer.startsWith('\x1b[200~')) { pasting = true; buffer = buffer.slice(6); continue; }
        if (buffer.startsWith('\x1b[201~')) { pasting = false; buffer = buffer.slice(6); continue; }
      }
      const char = buffer[0]; buffer = buffer.slice(1);
      if (char === '\x03') { input = ''; continue; }
      if ((char === '\r' || char === '\n') && !pasting) {
        if (!input) continue;
        const text = input.replace(/\r\n?/g, '\n'); input = ''; const promptId = 'native-' + (++turn);
        work = work.then(async () => {
          remember(text); await hook('UserPromptSubmit', { prompt_id: promptId, prompt: text });
          process.stdout.write('\r\n本轮任务已完成。\r\n');
          await hook('Stop', { prompt_id: promptId });
        });
      } else input += char;
    }
  });
  hook('Stop').then(() => process.stdout.write('\x1b[?2004hNATIVE_READY\r\n')).catch(error => { console.error(error); process.exit(1); });
}
`);
  const cli = path.join(prefix, 'claude.cmd');
  await fs.writeFile(cli, '@echo off\r\nexit /b 99\r\n', { mode: 0o755 });
  const project = { id: randomUUID(), name: '会话体验项目', path: projectPath, createdAt: new Date().toISOString() };
  const state: AppState = { version: 1, projects: [project], sessions: [], settings: { claudePath: cli, shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000 } };
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify(state));
  const launch = () => electron.launch({
    args: ['.', ...(process.platform === 'linux' ? ['--no-sandbox', `--ozone-platform=${process.env.DISPLAY ? 'x11' : 'headless'}`, '--disable-gpu'] : [])],
    env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data, CLAUDE_CONFIG_DIR: claudeConfig },
  });
  const sent: string[] = [];
  return { directory, project, git, launch,
    records: async (): Promise<FixtureRecord[]> => (await fs.readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)),
    signal: async (command: string) => { sent.push(command); await fs.writeFile(commands, JSON.stringify(sent)); await expect.poll(() => fs.readFile(ack, 'utf8').then(Number, () => 0)).toBe(sent.length); },
    dispose: () => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}

async function close(app: ElectronApplication) {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }).catch(() => {});
  await app.close();
}

async function create(page: Page, title = '', adapter: 'structured' | 'terminal' = 'structured') {
  await page.getByRole('button', { name: /新建会话/ }).click();
  const form = page.getByRole('dialog', { name: '新建会话', exact: true });
  await form.getByLabel('会话名称', { exact: true }).fill(title);
  await form.getByLabel('交互方式', { exact: true }).selectOption(adapter);
  await form.getByRole('button', { name: '创建会话', exact: true }).click();
  await expect(form).toHaveCount(0);
  return page.evaluate(async () => { const state = (await window.desktop.snapshot()).state; return state.sessions.find(session => session.id === state.selectedSessionId)!; });
}

async function completed(page: Page) {
  await expect(page.locator('.session-header .status-tag')).toContainText('本轮完成');
  await expect(page.locator('.session-actions').getByRole('button', { name: '中断任务', exact: true })).toHaveCount(0);
  await expect(page.locator('.session-actions').getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
}

test('session experience: Enter sends once, modifiers insert lines, IME is safe, and automatic/manual names persist', async ({}, testInfo) => {
  const f = await workspace(); let app = await f.launch();
  try {
    let page = await app.firstWindow(); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 680));
    const session = await create(page), editor = page.getByLabel('提示词编辑器', { exact: true });
    expect(session.title).toBe('新的开发会话'); expect(session.titleSource).toBe('default');
    await editor.fill('修复登录页面校验');
    await editor.dispatchEvent('compositionstart');
    await editor.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
    await editor.dispatchEvent('compositionend');
    await editor.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 });
    await editor.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', repeat: true });
    await expect(editor).toHaveValue('修复登录页面校验');
    expect((await page.evaluate(id => window.desktop.chatSnapshot(id), session.id)).messages.filter(value => value.role === 'user')).toHaveLength(0);
    await editor.press('Enter'); await completed(page);
    await expect(page.getByRole('heading', { name: '修复登录页面校验', exact: true })).toBeVisible();
    await expect(page.locator('.session-row.active')).toContainText('修复登录页面校验');
    await expect(editor).toHaveValue('');
    expect((await f.records()).filter(value => value.event === 'prompt')).toHaveLength(1);

    await editor.fill('第一行'); await editor.press('Control+Enter'); await editor.press('a');
    await expect(editor).toHaveValue('第一行\na');
    await editor.press('Meta+Enter'); await editor.press('b'); await editor.press('Shift+Enter'); await editor.press('c');
    await expect(editor).toHaveValue('第一行\na\nb\nc');
    expect((await f.records()).filter(value => value.event === 'prompt')).toHaveLength(1);
    await editor.press('Enter'); await completed(page);
    await expect.poll(async () => (await f.records()).filter(value => value.event === 'prompt').length).toBe(2);
    expect((await f.records()).filter(value => value.event === 'prompt')[1].text).toBe('第一行\na\nb\nc');
    await expect(page.getByRole('heading', { name: '修复登录页面校验', exact: true })).toBeVisible();
    await close(app); app = await f.launch(); page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: '修复登录页面校验', exact: true })).toBeVisible();
    expect((await page.evaluate(() => window.desktop.snapshot())).state.sessions[0].titleSource).toBe('auto');
    await page.getByRole('button', { name: '重命名', exact: true }).click();
    await page.getByLabel('新的会话名称', { exact: true }).fill('登录校验专项');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByLabel('提示词编辑器', { exact: true }).fill('继续补充接口验证');
    await page.getByLabel('提示词编辑器', { exact: true }).press('Enter'); await completed(page);
    await expect(page.getByRole('heading', { name: '登录校验专项', exact: true })).toBeVisible();
    expect((await page.evaluate(() => window.desktop.snapshot())).state.sessions[0].titleSource).toBe('manual');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 680));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByLabel('提示词编辑器', { exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath('session-completed-narrow.png') });
    await close(app); app = await f.launch(); page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: '登录校验专项', exact: true })).toBeVisible();
    expect((await page.evaluate(() => window.desktop.snapshot())).state.sessions[0].titleSource).toBe('manual');
    expect(errors).toEqual([]); await expect(page.locator('.error-banner')).toHaveCount(0);
  } finally { await close(app); await f.dispose(); }
});

test('session experience: active tasks block worktree changes, completed workers are reclaimed, and the original conversation resumes', async () => {
  const f = await workspace(), app = await f.launch();
  try {
    const page = await app.firstWindow(), original = await create(page, '常驻进程会话');
    await page.getByLabel('提示词编辑器', { exact: true }).fill('保持运行直到测试确认完成');
    await page.getByLabel('提示词编辑器', { exact: true }).press('Enter');
    await expect.poll(async () => (await f.records()).filter(value => value.event === 'prompt').length).toBe(1);
    await expect(page.locator('.session-actions').getByRole('button', { name: '中断任务', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /新建会话/ }).click();
    const form = page.getByRole('dialog', { name: '新建会话', exact: true });
    await form.getByLabel('会话名称', { exact: true }).fill('下一项独立任务');
    await form.getByRole('checkbox', { name: /创建独立 Git worktree/ }).check();
    await form.getByLabel('Worktree 名称', { exact: true }).fill('next-task');
    await form.getByRole('button', { name: '创建会话', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('停止');
    expect((await page.evaluate(() => window.desktop.snapshot())).state.sessions).toHaveLength(1);
    expect(f.git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    await f.signal('complete');
    await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).state.sessions.find(value => value.id === original.id)?.taskState).toBe('completed');
    await form.getByRole('button', { name: '创建会话', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '下一项独立任务', exact: true })).toBeVisible();
    const created = (await page.evaluate(() => window.desktop.snapshot())).state.sessions.find(value => value.title === '下一项独立任务')!;
    expect(created.worktree).toBeTruthy(); expect(await fs.readFile(path.join(created.cwd, 'README.md'), 'utf8')).toBe('Session experience fixture\n');
    await page.locator('.session-row').filter({ hasText: '常驻进程会话' }).click();
    await completed(page);
    await page.getByLabel('提示词编辑器', { exact: true }).fill('继续原来的任务');
    await page.getByLabel('提示词编辑器', { exact: true }).press('Enter'); await completed(page);
    await expect.poll(async () => (await f.records()).filter(value => value.event === 'prompt').length).toBe(2);
    const records = await f.records(), starts = records.filter(value => value.event === 'start');
    expect(starts).toHaveLength(2); expect(starts[1].resume).toBe(true); expect(starts[1].pid).not.toBe(starts[0].pid);
    expect(starts.map(value => value.session)).toEqual([original.claudeId, original.claudeId]);
    expect((await page.evaluate(id => window.desktop.chatSnapshot(id), original.id)).messages.filter(value => value.role === 'user')).toHaveLength(2);
    await expect(page.locator('.error-banner')).toHaveCount(0);
  } finally { await close(app); await f.dispose(); }
});

test('session experience: native composer submits one multiline prompt through the PTY and names from the accepted hook', async () => {
  const f = await workspace(), app = await f.launch();
  try {
    const page = await app.firstWindow(), session = await create(page, '', 'terminal');
    await page.getByRole('button', { name: '启动会话', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(id => window.desktop.terminalSnapshot(id), session.id)).chunks.map(value => value.data).join('')).toContain('NATIVE_READY');
    await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeVisible();
    const editor = page.getByLabel('提示词编辑器', { exact: true });
    await editor.fill('整理终端任务'); await editor.press('Control+Enter'); await editor.press('x');
    await expect(editor).toHaveValue('整理终端任务\nx');
    await editor.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
    await editor.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', repeat: true });
    expect((await f.records()).filter(value => value.event === 'prompt')).toHaveLength(0);
    await editor.press('Enter');
    await expect.poll(async () => (await f.records()).filter(value => value.event === 'prompt').length).toBe(1);
    expect((await f.records()).find(value => value.event === 'prompt')?.text).toBe('整理终端任务\nx');
    await expect(editor).toHaveValue(''); await completed(page);
    await expect(page.getByRole('heading', { name: '整理终端任务', exact: true })).toBeVisible();
    const updated = (await page.evaluate(() => window.desktop.snapshot())).state.sessions[0];
    expect(updated.titleSource).toBe('auto'); expect(updated.terminalSync).toBe('synced');
    await expect(page.locator('.error-banner')).toHaveCount(0);
  } finally { await close(app); await f.dispose(); }
});

test('session experience: an unobserved native CLI keeps paste-and-confirm without submitting on Enter', async () => {
  const f = await workspace(false), app = await f.launch();
  try {
    const page = await app.firstWindow(), session = await create(page, '', 'terminal');
    await page.getByRole('button', { name: '启动会话', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(id => window.desktop.terminalSnapshot(id), session.id)).chunks.map(value => value.data).join('')).toContain('NATIVE_READY');
    const editor = page.getByLabel('提示词编辑器', { exact: true });
    await editor.fill('终端中确认这条提示词'); await editor.press('Enter');
    await expect(editor).toHaveValue('终端中确认这条提示词');
    await expect(page.locator('.error-banner')).toContainText('粘贴到终端');
    await page.getByRole('button', { name: '关闭错误', exact: true }).click();
    expect((await f.records()).filter(value => value.event === 'prompt')).toHaveLength(0);
    await expect(page.getByRole('button', { name: '发送任务', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '粘贴到终端', exact: true }).click();
    await expect(editor).toHaveValue('');
    expect((await f.records()).filter(value => value.event === 'prompt')).toHaveLength(0);
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await f.records()).filter(value => value.event === 'prompt').length).toBe(1);
    expect((await f.records()).find(value => value.event === 'prompt')?.text).toBe('终端中确认这条提示词');
    await expect(page.getByRole('heading', { name: '新的开发会话', exact: true })).toBeVisible();
    await expect(page.locator('.error-banner')).toHaveCount(0);
  } finally { await close(app); await f.dispose(); }
});
