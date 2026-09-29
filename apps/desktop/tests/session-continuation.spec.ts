import { sessionAction } from './helpers/session-ui';
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatHistory } from '../src/main/chat-history';
import { desktopRoot } from './helpers/paths';
import { electronLaunchArgs } from './helpers/electron-launch';
import { closeNativeApp } from './helpers/native-app-cleanup';

test('visible conversation transfer previews selections and creates an unsent native draft with new identity', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-continuation-ui-'));
  const data = path.join(directory, 'data'), cwd = path.join(directory, 'project');
  await fs.mkdir(data); await fs.mkdir(cwd);
  const projectId = randomUUID(), sourceId = randomUUID(), conversationId = randomUUID(), now = new Date().toISOString();
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify({ version: 3,
    projects: [{ id: projectId, name: 'Continue project', path: cwd, createdAt: now }], selectedSessionId: sourceId,
    sessions: [{ id: sourceId, projectId, title: 'Source conversation', kind: 'agent', cwd,
      execution: { providerId: 'claude', mode: 'structured', conversationId },
      engineConfig: { schemaVersion: 1, options: { model: '', effort: 'default', permissionMode: 'default' } },
      started: false, status: 'stopped', taskState: 'completed', archived: false, createdAt: now, updatedAt: now }],
    settings: { claudePath: path.join(directory, 'missing-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000, engineDefaults: {} },
  }));
  const history = new ChatHistory(data, () => false);
  for (const [id, role, text] of [['user', 'user', 'Keep the visible requirement'], ['assistant', 'assistant', 'Review this answer'], ['tool', 'tool', 'TOOL_OUTPUT_NOT_TRANSFERRED']] as const) {
    const message = { id, role, text, turnId: 'source-turn', createdAt: now };
    history.append(sourceId, { type: 'message', message }); history.upsertMessage(sourceId, message);
  }
  history.flush();
  const app = await electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot, env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data } });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('main.workspace')).toBeVisible();
    await sessionAction(page, 'Source conversation', '带入内容到新会话');
    await page.getByRole('button', { name: '自研 Agent · Alpha', exact: true }).click();
    await expect(page.getByRole('button', { name: '创建会话', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '读取可见消息', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: '带入第 1 条用户消息' })).not.toBeChecked();
    await page.getByRole('checkbox', { name: '带入第 1 条用户消息' }).check();
    await page.getByLabel('手写摘要', { exact: true }).fill('User reviewed summary');
    await page.getByRole('button', { name: '创建会话', exact: true }).click();
    await expect(page.getByLabel('提示词编辑器', { exact: true })).toHaveValue(/Keep the visible requirement/);
    const snapshot = await page.evaluate(() => window.desktop.snapshot());
    const created = snapshot.state.sessions.find(session => session.id === snapshot.state.selectedSessionId)!;
    expect(created.id).not.toBe(sourceId); expect(created.execution.conversationId).not.toBe(conversationId);
    expect(created.execution.providerId).toBe('native'); expect(created.started).toBe(false);
    expect(created.draft).toContain('User reviewed summary');
    expect(created.draft).not.toContain('Review this answer'); expect(created.draft).not.toContain('TOOL_OUTPUT_NOT_TRANSFERRED');
    expect(snapshot.state.sessions.find(session => session.id === sourceId)!.execution.conversationId).toBe(conversationId);
  } finally { await closeNativeApp(app); await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
