import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import type { IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { AppState, Session } from '../src/shared/types';
import { electronLaunchArgs } from './helpers/electron-launch';
import { sessionRow, submitNewSession } from './helpers/session-ui';

interface Submission { id: string; text: string; requestId?: string }
interface FlowFixture {
  holdCreate(): void;
  createEntered(): boolean;
  releaseCreate(): void;
  failNextSubmission(): void;
  records(): { creates: number; submissions: Submission[] };
  dispose(): void;
}
type FlowGlobal = typeof globalThis & { firstSendFixture: FlowFixture };

async function workspace(withExisting = false) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cc-desk-new-session-')));
  const data = path.join(directory, 'data'), projectPath = path.join(directory, '选中的工作目录');
  await fs.mkdir(data); await fs.mkdir(projectPath);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: projectPath, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'First Send Fixture'); git('config', 'user.email', 'tests@example.invalid');
  await fs.writeFile(path.join(projectPath, 'README.md'), 'First send workspace\n');
  git('add', '.'); git('commit', '-m', 'Fixture');
  const now = new Date().toISOString(), project = { id: randomUUID(), name: '已有工作空间', path: projectPath, createdAt: now };
  const existing: Session = {
    id: randomUUID(), projectId: project.id, title: '保持选中的旧会话', kind: 'agent', titleSource: 'manual', cwd: projectPath,
    execution: { providerId: 'claude', mode: 'structured', conversationId: randomUUID() }, started: false,
    model: '', effort: 'default', permissionMode: 'default', status: 'idle', taskState: 'idle', archived: false, createdAt: now, updatedAt: now,
  };
  const state: AppState = {
    version: 2, projects: withExisting ? [project] : [], sessions: withExisting ? [existing] : [], selectedSessionId: withExisting ? existing.id : undefined,
    settings: { claudePath: path.join(directory, 'unavailable-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000 },
  };
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify(state));
  const app = await electron.launch({ args: electronLaunchArgs(), env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data } });
  const page = await app.firstWindow();
  await expect(page.getByRole('button', { name: /新建会话/ })).toBeVisible();
  // Creation, directory selection, persistence and renderer/preload IPC are real.
  // Control only creation timing and the account-dependent submission response.
  await app.evaluate(({ ipcMain }) => {
    type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, Handler> })._invokeHandlers;
    const original = handlers?.get('session:create');
    if (!original) throw new Error('Expected the real session:create handler');
    let creates = 0, fail = false;
    let gate: { entered: boolean; resolve?: () => void; reject?: (error: Error) => void } | undefined;
    const submissions: Submission[] = [];
    ipcMain.removeHandler('session:create');
    ipcMain.handle('session:create', async (event, input: unknown) => {
      creates++;
      if (gate) {
        gate.entered = true;
        await new Promise<void>((resolve, reject) => { gate!.resolve = resolve; gate!.reject = reject; });
      }
      return original(event, input);
    });
    ipcMain.removeHandler('chat:submit');
    ipcMain.handle('chat:submit', (_event, input: Submission) => {
      submissions.push(input);
      if (fail) { fail = false; throw new Error('测试首次提交失败，请重试'); }
      return { messageId: input.requestId ?? 'fixture-submission' };
    });
    (globalThis as FlowGlobal).firstSendFixture = {
      holdCreate: () => { gate = { entered: false }; },
      createEntered: () => !!gate?.entered,
      releaseCreate: () => { const current = gate; gate = undefined; if (!current?.resolve) throw new Error('No pending create request'); current.resolve(); },
      failNextSubmission: () => { fail = true; },
      records: () => ({ creates, submissions }),
      dispose: () => gate?.reject?.(new Error('Fixture disposed')),
    };
  });
  return { app, page, existing, project, projectPath, git, close: async () => {
    await app.evaluate(() => (globalThis as FlowGlobal).firstSendFixture.dispose()).catch(() => {});
    await app.close(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } };
}

async function picker(app: ElectronApplication, directory: string | null) {
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = (async () => ({ canceled: directory === null, filePaths: directory === null ? [] : [directory] })) as typeof dialog.showOpenDialog;
  }, directory);
}

async function openNew(page: Page) {
  await page.getByRole('button', { name: /新建会话/ }).click();
  const form = page.getByRole('region', { name: '新建会话', exact: true });
  await expect(form).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);
  return form;
}

test('new session: choose or reuse a directory without an empty record, and first send groups sessions by workspace', async () => {
  const f = await workspace();
  try {
    const { page, app } = f;
    await expect(page.getByRole('button', { name: /新建会话/ })).toBeEnabled();
    const form = await openNew(page), editor = form.getByLabel('提示词编辑器', { exact: true });
    await expect(editor).toBeFocused();
    await expect(form.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '添加项目', exact: true })).toHaveCount(0);
    await expect(form.getByLabel('交互方式', { exact: true })).toHaveCount(0);
    await expect(form.getByRole('button', { name: 'Shell 终端', exact: true })).toHaveCount(0);
    await picker(app, null); await form.getByRole('button', { name: '选择目录', exact: true }).click();
    expect((await page.evaluate(() => window.desktop.snapshot())).state.projects).toHaveLength(0);
    await picker(app, f.projectPath); await form.getByRole('button', { name: '选择目录', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).state.projects.length).toBe(1);
    const selected = (await page.evaluate(() => window.desktop.snapshot())).state.projects[0];
    expect(selected.path).toBe(f.projectPath);
    await expect(form.getByLabel('工作空间', { exact: true })).toHaveValue(selected.id);
    await expect(page.locator('.session-group')).toHaveCount(0);
    await picker(app, f.projectPath + path.sep + '.'); await form.getByRole('button', { name: '选择目录', exact: true }).click();
    expect((await page.evaluate(() => window.desktop.snapshot())).state.projects.map(project => project.id)).toEqual([selected.id]);
    await form.getByLabel('会话名称', { exact: true }).fill('目录内的第一项任务');
    await form.getByLabel('模型', { exact: true }).fill('sonnet');
    await form.getByLabel('权限模式', { exact: true }).selectOption('plan');
    await form.getByRole('checkbox', { name: /创建独立 Git worktree/ }).check();
    await form.getByLabel('起始分支', { exact: true }).selectOption('refs/heads/main');
    await form.getByRole('checkbox', { name: /创建独立 Git worktree/ }).uncheck();
    await editor.fill('  '); await expect(form.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
    await editor.fill('第一条真实提交');
    expect((await page.evaluate(() => window.desktop.snapshot())).state.sessions).toHaveLength(0);
    expect(f.git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    const configBounds = (await form.getByLabel('模型', { exact: true }).boundingBox())!, composerBounds = (await editor.boundingBox())!;
    expect(configBounds.y + configBounds.height).toBeLessThanOrEqual(composerBounds.y);
    await app.evaluate(() => (globalThis as FlowGlobal).firstSendFixture.holdCreate());
    await editor.evaluate(element => {
      for (let index = 0; index < 2; index++) element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    });
    await expect.poll(() => app.evaluate(() => (globalThis as FlowGlobal).firstSendFixture.createEntered())).toBe(true);
    expect((await page.evaluate(() => window.desktop.snapshot())).state.sessions).toHaveLength(0);
    expect((await app.evaluate(() => (globalThis as FlowGlobal).firstSendFixture.records())).creates).toBe(1);
    await app.evaluate(() => (globalThis as FlowGlobal).firstSendFixture.releaseCreate());
    await expect(form).toHaveCount(0);
    const first = (await page.evaluate(() => window.desktop.snapshot())).state.sessions[0];
    expect(first).toMatchObject({ projectId: selected.id, title: '目录内的第一项任务', model: 'sonnet', permissionMode: 'plan', kind: 'agent', execution: { providerId: 'claude', mode: 'structured' } });
    const records = await app.evaluate(() => (globalThis as FlowGlobal).firstSendFixture.records());
    expect(records.creates).toBe(1); expect(records.submissions).toHaveLength(1);
    expect(records.submissions[0]).toMatchObject({ id: first.id, text: '第一条真实提交' });
    await openNew(page); await form.getByLabel('会话名称', { exact: true }).fill('同目录的第二项任务');
    await submitNewSession(page, '第二条提交');
    await expect(page.locator('.session-group')).toHaveCount(1);
    await expect(page.locator(`[data-project-id="${selected.id}"] .session-row`)).toHaveCount(2);
    expect((await page.evaluate(() => window.desktop.snapshot())).state.projects).toHaveLength(1);
    await expect(page.locator('.error-banner')).toHaveCount(0);
  } finally { await f.close(); }
});

test('new session: editing and switching create no record, and delayed first-send completion does not steal selection', async () => {
  const f = await workspace(true);
  try {
    const { page, app } = f;
    const form = await openNew(page);
    await form.getByLabel('会话名称', { exact: true }).fill('延迟创建的任务');
    await form.getByLabel('提示词编辑器', { exact: true }).fill('尚未发送的任务草稿');
    await form.getByLabel('模型', { exact: true }).fill('sonnet');
    await sessionRow(page, f.existing.title).click(); await expect(form).toHaveCount(0);
    expect((await page.evaluate(() => window.desktop.snapshot())).state.sessions.map(session => session.id)).toEqual([f.existing.id]);
    expect((await app.evaluate(() => (globalThis as FlowGlobal).firstSendFixture.records())).creates).toBe(0);
    await openNew(page);
    await form.getByLabel('会话名称', { exact: true }).fill('延迟创建的任务');
    await form.getByLabel('提示词编辑器', { exact: true }).fill('延迟提交期间切换会话');
    await app.evaluate(() => (globalThis as FlowGlobal).firstSendFixture.holdCreate());
    await form.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as FlowGlobal).firstSendFixture.createEntered())).toBe(true);
    await sessionRow(page, f.existing.title).click();
    await expect(page.getByRole('heading', { name: f.existing.title, exact: true })).toBeVisible();
    await app.evaluate(() => (globalThis as FlowGlobal).firstSendFixture.releaseCreate());
    await expect.poll(async () => (await app.evaluate(() => (globalThis as FlowGlobal).firstSendFixture.records())).submissions.length).toBe(1);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('heading', { name: f.existing.title, exact: true })).toBeVisible();
    const state = (await page.evaluate(() => window.desktop.snapshot())).state;
    expect(state.selectedSessionId).toBe(f.existing.id); expect(state.sessions).toHaveLength(2);
    expect((await app.evaluate(() => (globalThis as FlowGlobal).firstSendFixture.records())).creates).toBe(1);
    await expect(form).toHaveCount(0);
    await expect(page.locator('.error-banner')).toHaveCount(0);
  } finally { await f.close(); }
});

test('new session: retrying a failed first submission reuses its session and request identity', async () => {
  const f = await workspace(true);
  try {
    const { page, app } = f;
    const form = await openNew(page);
    await form.getByLabel('会话名称', { exact: true }).fill('失败后原位重试');
    await form.getByLabel('提示词编辑器', { exact: true }).fill('只应该创建一次的任务');
    await app.evaluate(() => (globalThis as FlowGlobal).firstSendFixture.failNextSubmission());
    await form.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(page.locator('.error-banner')).toContainText('测试首次提交失败');
    const before = (await page.evaluate(() => window.desktop.snapshot())).state.sessions;
    expect(before).toHaveLength(2);
    const created = before.find(session => session.title === '失败后原位重试')!;
    await expect(form.getByLabel('工作空间', { exact: true })).toBeDisabled();
    await expect(form.getByLabel('模型', { exact: true })).toBeDisabled();
    await expect(form.getByLabel('提示词编辑器', { exact: true })).toHaveValue('只应该创建一次的任务');
    await form.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(page.getByRole('heading', { name: created.title, exact: true })).toBeVisible();
    const records = await app.evaluate(() => (globalThis as FlowGlobal).firstSendFixture.records());
    expect(records.creates).toBe(1); expect(records.submissions).toHaveLength(2);
    expect(records.submissions.map(value => value.id)).toEqual([created.id, created.id]);
    expect(records.submissions[0].requestId).toBeTruthy();
    expect(records.submissions[1].requestId).toBe(records.submissions[0].requestId);
    expect((await page.evaluate(() => window.desktop.snapshot())).state.sessions).toHaveLength(2);
  } finally { await f.close(); }
});
