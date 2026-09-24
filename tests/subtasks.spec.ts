import { electronLaunchArgs } from './helpers/electron-launch';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppState, Session } from '../src/shared/types';
import type { Subtask } from '../src/shared/subtasks';

/** Use the same standard npm layout as a real installation, including on Windows. */
async function protocolFixture(directory: string) {
  const prefix = path.join(directory, 'npm CLI'), pkg = path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code');
  const npm = path.join(prefix, 'node_modules', 'npm', 'bin'), config = path.join(directory, 'claude-config');
  const commands = path.join(directory, 'commands.json'), acknowledged = path.join(directory, 'acknowledged.txt');
  await Promise.all([fs.mkdir(pkg, { recursive: true }), fs.mkdir(npm, { recursive: true }), fs.mkdir(config)]);
  await fs.writeFile(commands, '[]');
  const node = path.join(prefix, process.platform === 'win32' ? 'node.exe' : 'node');
  if (process.platform === 'win32') await fs.copyFile(process.execPath, node);
  else await fs.symlink(process.execPath, node);
  await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', bin: { claude: 'cli.js' } }));
  await fs.writeFile(path.join(pkg, 'cli.js'), `const commandsFile = ${JSON.stringify(commands)}, acknowledgedFile = ${JSON.stringify(acknowledged)};\n` + String.raw`
const fs = require('node:fs'), readline = require('node:readline');
if (process.argv.includes('--version')) { console.log('Claude Code subtask fixture 2.1.0'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--session-id --resume --fork-session --permission-mode --model --effort --print --input-format --output-format --verbose --permission-prompt-tool --include-partial-messages --forward-subagent-text\n--effort <level> low medium high max'); process.exit(0); }
if (process.argv.includes('auth')) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'fixture' })); process.exit(0); }
const flag = name => process.argv[process.argv.indexOf(name) + 1];
const session = process.argv.includes('--session-id') ? flag('--session-id') : flag('--resume');
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
let started = false, cursor = 0;
const start = (id, description) => ({ type: 'system', subtype: 'task_started', task_id: 'task-' + id, tool_use_id: 'tool-' + id, task_type: 'local_agent', description });
const completion = id => ({ type: 'system', subtype: 'task_notification', task_id: 'task-' + id, tool_use_id: 'tool-' + id, status: 'completed', summary: id === 'alpha' ? '已核对 12 个接口，未发现接口兼容问题。' : '已完成界面布局检查。' });
const finish = () => output({ type: 'result', subtype: 'success', session_id: session, result: '两项检查已完成。', is_error: false, num_turns: 1 });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request') {
    output({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
    if (frame.request.subtype === 'interrupt') finish();
  } else if (frame.type === 'user') {
    started = true;
    output({ type: 'system', subtype: 'init', session_id: session, model: 'fixture-model', permissionMode: 'default' });
    output({ type: 'assistant', parent_tool_use_id: null, message: { id: 'launch-agents', content: [
      { type: 'tool_use', id: 'tool-alpha', name: 'Agent', input: { description: '核对接口', subagent_type: 'Explore', run_in_background: true } },
      { type: 'tool_use', id: 'tool-beta', name: 'Agent', input: { description: '检查界面', subagent_type: 'Explore', run_in_background: true } },
    ] } });
    output(start('alpha', '核对接口')); output(start('beta', '检查界面')); output(start('alpha', '核对接口'));
    output({ type: 'system', subtype: 'task_progress', task_id: 'task-alpha', tool_use_id: 'tool-alpha', summary: '正在读取接口定义', last_tool_name: 'Read', usage: { tool_uses: 3, total_tokens: 2400, duration_ms: 1200 } });
    output({ type: 'system', subtype: 'task_updated', task_id: 'task-beta', patch: { description: '检查窄窗口界面', is_backgrounded: true } });
  }
});
const interval = setInterval(() => {
  if (!started) return;
  let commands; try { commands = JSON.parse(fs.readFileSync(commandsFile, 'utf8')); } catch { return; }
  for (; cursor < commands.length; cursor++) {
    if (commands[cursor] === 'complete-alpha') output(completion('alpha'));
    if (commands[cursor] === 'duplicate-alpha') { output(completion('alpha')); output(start('alpha', '核对接口')); }
    if (commands[cursor] === 'complete-beta') {
      output(completion('beta'));
      output({ type: 'assistant', message: { id: 'final-answer', content: [{ type: 'text', text: '两项检查已完成。' }] } });
      finish();
    }
    fs.writeFileSync(acknowledgedFile, String(cursor + 1));
  }
}, 25);
process.stdin.on('end', () => { clearInterval(interval); process.exit(0); });
`);
  const cli = path.join(prefix, 'claude.cmd');
  await fs.writeFile(cli, '@echo off\r\nexit /b 99\r\n', { mode: 0o755 });
  // Keep the real update banner visible without depending on an external npm registry.
  const npmScript = "console.log(JSON.stringify('2.1.10'));\n";
  await fs.writeFile(path.join(npm, 'npm-cli.js'), npmScript);
  await fs.writeFile(path.join(prefix, 'npm.cmd'), '@echo off\r\nexit /b 99\r\n', { mode: 0o755 });
  if (process.platform !== 'win32') await fs.writeFile(path.join(prefix, 'npm'), '#!/usr/bin/env node\n' + npmScript, { mode: 0o755 });
  const sent: string[] = [];
  return { cli, config, signal: async (command: string) => {
    sent.push(command); await fs.writeFile(commands, JSON.stringify(sent));
    await expect.poll(() => fs.readFile(acknowledged, 'utf8').then(Number, () => 0)).toBe(sent.length);
  } };
}

async function workspace() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-desk-subtasks-'));
  const data = path.join(directory, 'data'), projectPath = path.join(directory, '项目 with spaces');
  await Promise.all([fs.mkdir(data), fs.mkdir(projectPath)]);
  const fixture = await protocolFixture(directory), cwd = await fs.realpath(projectPath);
  const now = new Date().toISOString(), projectId = randomUUID();
  const makeSession = (title: string, adapter: Session['execution']['mode'] = 'structured'): Session => ({ execution: { providerId: 'claude', mode: adapter, conversationId: randomUUID() },
    id: randomUUID(), projectId, title, kind: 'agent',  cwd,
    started: false, model: '', effort: 'default', permissionMode: 'default', status: 'idle', taskState: 'idle',
    archived: false, createdAt: now, updatedAt: now,
  });
  const first = makeSession('并行检查'), second = makeSession('独立会话'), terminal = makeSession('CLI 子任务', 'terminal');
  const state: AppState = {
    version: 2, projects: [{ id: projectId, name: '子任务项目', path: cwd, createdAt: now }],
    sessions: [first, second, terminal], selectedSessionId: first.id,
    settings: { claudePath: fixture.cli, shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000 },
  };
  const stateFile = path.join(data, 'workspace.json');
  await fs.writeFile(stateFile, JSON.stringify(state));
  const launch = () => electron.launch({
    args: electronLaunchArgs(),
    env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data, CLAUDE_CONFIG_DIR: fixture.config },
  });
  return { ...fixture, directory, data, state, stateFile, first, second, terminal, launch, dispose: () => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

async function close(app: ElectronApplication) {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }).catch(() => {});
  await app.close();
}

async function counts(page: Page, total: number, active: number, completed: number) {
  const summary = page.getByRole('region', { name: '子任务状态', exact: true }).locator('.subtask-counts');
  await expect(summary).toContainText(`共 ${total}`);
  await expect(summary).toContainText(`进行中 ${active}`);
  await expect(summary).toContainText(`已完成 ${completed}`);
}

test('subtasks: real protocol updates counts, deduplicates events, and keeps progress visible with the inspector closed', async ({}, testInfo) => {
  const f = await workspace();
  let app = await f.launch();
  try {
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: f.first.title, exact: true })).toBeVisible();
    // 652 px is the content height of a 680 px macOS window, excluding its title bar.
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setMinimumSize(980, 652);
      window.setContentSize(980, 652);
    });
    expect(await page.evaluate(() => innerHeight)).toBe(652);
    const updateBanner = page.getByRole('region', { name: 'Claude Code CLI 更新', exact: true });
    await expect(updateBanner).toContainText('2.1.10');
    await page.getByLabel('提示词编辑器', { exact: true }).fill('并行检查接口与界面');
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await counts(page, 2, 2, 0);
    const panel = page.getByRole('region', { name: '子任务状态', exact: true });
    // Exercise the smallest chat width before making more room by hiding the inspector.
    await page.getByRole('button', { name: '展开子任务', exact: true }).click();
    await expect(panel.locator('.subtask-row')).toHaveCount(2);
    await expect(panel).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(page.getByLabel('提示词编辑器', { exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.locator('.chat-composer')).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('button', { name: '中断', exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath('subtasks-narrow-inspector-open.png') });
    await page.getByRole('button', { name: '收起子任务', exact: true }).click();
    await page.getByRole('button', { name: '关闭上下文面板', exact: true }).click();
    await expect(page.locator('#session-inspector .inspector-dock')).toBeHidden();
    await expect(panel).toBeInViewport({ ratio: 1 });
    const expand = page.getByRole('button', { name: '展开子任务', exact: true });
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    await expand.focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: '收起子任务', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.locator('.subtask-row')).toHaveCount(2);
    const alpha = panel.locator('.subtask-row').filter({ hasText: '核对接口' });
    await alpha.locator('summary').click();
    await expect(alpha.locator('.subtask-detail')).toContainText('正在读取接口定义');
    await expect(alpha.locator('.subtask-detail')).toContainText('最近工具：Read');
    await expect(alpha.locator('.subtask-detail')).toContainText('3 次工具调用');
    await expect(alpha.locator('.subtask-detail')).toContainText('2,400 tokens');
    await expect(panel.locator('.subtask-row').filter({ hasText: '检查窄窗口界面' })).toHaveAttribute('data-subtask-status', 'running');

    await f.signal('complete-alpha');
    await counts(page, 2, 1, 1);
    await expect(alpha).toHaveAttribute('data-subtask-status', 'completed');
    await expect(alpha.locator('.subtask-detail')).toContainText('已核对 12 个接口，未发现接口兼容问题。');
    await f.signal('duplicate-alpha');
    await counts(page, 2, 1, 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(page.getByLabel('提示词编辑器', { exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.locator('.chat-composer')).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('button', { name: '中断', exact: true })).toBeInViewport({ ratio: 1 });
    await expect(updateBanner).toBeInViewport({ ratio: 1 });
    expect(await panel.locator('.subtask-list').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('subtasks-progress.png') });

    await page.locator('.session-row').filter({ hasText: f.second.title }).click();
    await expect(page.getByRole('region', { name: '子任务状态', exact: true })).toHaveCount(0);
    await page.locator('.session-row').filter({ hasText: f.first.title }).click();
    await counts(page, 2, 1, 1);
    await f.signal('complete-beta');
    await counts(page, 2, 0, 2);
    await expect(page.locator('.chat-message.assistant').last()).toContainText('两项检查已完成。');
    await expect(page.locator('.chat-message.assistant')).toHaveCount(1);
    await close(app); app = await f.launch(); page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await counts(page, 2, 0, 2);
    await expect(page.locator('#session-inspector .inspector-dock')).toBeHidden();
    await page.getByRole('button', { name: '展开子任务', exact: true }).focus();
    await page.keyboard.press('Space');
    await expect(page.locator('.subtask-row[data-subtask-status="completed"]')).toHaveCount(2);
    await page.getByRole('button', { name: '收起子任务', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.subtask-row')).toHaveCount(0);
    await expect(page.locator('.error-banner')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await close(app); await f.dispose(); }
});

test('subtasks: recovered activity distinguishes interruption from completion and isolates current, historical and native-session records', async ({}, testInfo) => {
  const f = await workspace(), now = new Date().toISOString();
  const task = (id: string, turnId: string, status: Subtask['status'], description: string, source: Subtask['source'] = 'stream'): Subtask => ({
    id, turnId, status, description, source, kind: 'agent', startedAt: now, updatedAt: now,
    ...(['completed', 'failed'].includes(status) ? { endedAt: now } : {}),
  });
  f.first.status = 'running'; f.first.taskState = 'tool_running';
  f.first.subtasks = { turnId: 'latest-turn', tasks: [
    task('previous-complete', 'previous-turn', 'completed', '较早轮次检查'),
    { ...task('latest-complete', 'latest-turn', 'completed', '已完成的检查'), summary: '完成确认应保留。' },
    task('latest-active', 'latest-turn', 'running', '退出前正在执行的检查'),
  ] };
  f.terminal.subtasks = { turnId: 'terminal-turn', tasks: [
    task('native-complete', 'terminal-turn', 'completed', '终端子代理完成记录', 'hooks'),
    { ...task('native-failed', 'terminal-turn', 'failed', '终端检查失败：' + 'long-unbroken-project-name-'.repeat(8), 'hooks'), summary: '工具调用失败，任务没有完成。' },
  ] };
  await fs.writeFile(f.stateFile, JSON.stringify(f.state));
  const app = await f.launch();
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 680));
    await counts(page, 2, 0, 1);
    await expect(page.locator('.subtask-counts')).toContainText('已停止 1');
    await page.getByRole('button', { name: '展开子任务', exact: true }).click();
    await expect(page.locator('.subtask-row')).toHaveCount(2);
    const interrupted = page.locator('.subtask-row[data-subtask-status="interrupted"]');
    await interrupted.locator('summary').click();
    await expect(interrupted.locator('.subtask-detail')).toContainText('未收到此子任务的完成确认');
    await expect(interrupted.locator('.subtask-detail')).toContainText('此状态不表示任务已完成');
    await expect(page.getByRole('button', { name: '当前轮', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '全部记录', exact: true }).click();
    await counts(page, 3, 0, 2);
    await expect(page.locator('.subtask-row').filter({ hasText: '较早轮次检查' })).toBeVisible();
    await page.getByRole('button', { name: '当前轮', exact: true }).click();
    await counts(page, 2, 0, 1);
    await expect(page.locator('.subtask-row').filter({ hasText: '较早轮次检查' })).toHaveCount(0);
    const recovered = (await page.evaluate(() => window.desktop.snapshot())).state.sessions.find(session => session.id === f.first.id)!;
    expect(recovered.subtasks?.tasks.find(value => value.id === 'latest-active')?.status).toBe('interrupted');
    expect(recovered.subtasks?.tasks.find(value => value.id === 'latest-complete')?.summary).toBe('完成确认应保留。');

    await page.getByRole('button', { name: '关闭上下文面板', exact: true }).click();
    await page.locator('.session-row').filter({ hasText: f.terminal.title }).click();
    await counts(page, 2, 0, 1);
    await expect(page.locator('.subtask-counts')).toContainText('失败 1');
    await expect(page.locator('.terminal-host')).toBeVisible();
    await expect(page.locator('#session-inspector .inspector-dock')).toBeHidden();
    await page.getByRole('button', { name: '展开子任务', exact: true }).click();
    await expect(page.locator('.subtask-row')).toHaveCount(2);
    await expect(page.locator('.subtask-row').filter({ hasText: '已完成的检查' })).toHaveCount(0);
    const failed = page.locator('.subtask-row[data-subtask-status="failed"]');
    await failed.locator('summary').click();
    await expect(failed.locator('.subtask-detail')).toContainText('工具调用失败，任务没有完成。');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('.subtask-panel').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('subtasks-native-history.png') });
    await page.getByRole('button', { name: '收起子任务', exact: true }).focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: '展开子任务', exact: true })).toBeFocused();
    await expect(page.locator('.subtask-body')).toBeHidden();
    await expect(page.locator('.error-banner')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await close(app); await f.dispose(); }
});
