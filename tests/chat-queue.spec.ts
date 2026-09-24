import { test, expect, type Page } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { chatQueueWorkspace, closeQueueApp } from './fixtures/chat-queue-fixture';

const editor = (page: Page) => page.getByLabel('提示词编辑器', { exact: true });
const queued = (page: Page, text: string) => page.getByLabel('待发送消息', { exact: true }).locator('.queued-chat-message').filter({ hasText: text });
const snapshot = (page: Page, id: string) => page.evaluate(id => window.desktop.chatSnapshot(id), id);
const queueTexts = async (page: Page, id: string) => (await snapshot(page, id)).queue?.items.filter(item => item.status === 'queued').map(item => item.text) ?? [];
const submit = async (page: Page, text: string) => {
  await editor(page).fill(text); await editor(page).press('Enter');
  await expect(editor(page)).toHaveValue('');
};
const select = async (page: Page, title: string) => {
  await page.locator('.session-row').filter({ hasText: title }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
};
const remove = async (page: Page, text: string) => {
  const row = queued(page, text); await row.hover();
  await row.getByRole('button', { name: /^移除排队消息/ }).click();
  await expect(row).toHaveCount(0);
};

test('context recovery: cancel preserves the missing identity; confirmation keeps history and drafts and requires manual queue continuation', async () => {
  const f = await chatQueueWorkspace(); let app = await f.launch();
  try {
    let page = await app.firstWindow(); const [session] = f.sessions;
    await submit(page, '保留此前聊天');
    await expect.poll(() => f.prompts(session)).toEqual(['保留此前聊天']);
    await f.signal(session, 'complete');
    await expect.poll(async () => (await snapshot(page, session.id)).queue?.items ?? []).toEqual([]);
    await page.evaluate(id => window.desktop.stopSession(id), session.id);
    await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).state.sessions[0].status).toBe('stopped');
    await fs.rm(path.join(f.configDirectory, 'projects', 'fixture', session.execution.conversationId! + '.jsonl'));
    await submit(page, '恢复后再发送这条消息');
    const recover = page.getByRole('button', { name: '重建空白上下文', exact: true });
    await expect(recover).toBeVisible();
    await expect.poll(async () => (await snapshot(page, session.id)).queue?.paused).toBe(true);
    await editor(page).fill('尚未提交的草稿');
    await recover.click();
    const dialog = page.getByRole('dialog', { name: '重建空白上下文', exact: true });
    await expect(dialog).toContainText('此操作不能恢复原来的 Claude 上下文');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect((await page.evaluate(() => window.desktop.snapshot())).state.sessions[0].execution.conversationId).toBe(session.execution.conversationId);
    await expect(editor(page)).toHaveValue('尚未提交的草稿');
    await recover.click(); await dialog.getByRole('button', { name: '确认重建', exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(recover).toHaveCount(0);
    const renewed = (await page.evaluate(() => window.desktop.snapshot())).state.sessions[0];
    expect(renewed.execution.conversationId).not.toBe(session.execution.conversationId);
    expect(renewed.cwd).toBe(session.cwd); expect(renewed.started).toBe(false);
    await expect(editor(page)).toHaveValue('尚未提交的草稿');
    await expect(page.locator('.chat-message.user').filter({ hasText: '保留此前聊天' })).toBeVisible();
    expect((await snapshot(page, session.id)).queue?.paused).toBe(true);
    expect(await queueTexts(page, session.id)).toEqual(['恢复后再发送这条消息']);
    expect(await f.prompts(renewed)).toEqual([]);
    await page.getByRole('button', { name: '继续发送队列', exact: true }).click();
    await expect.poll(() => f.prompts(renewed)).toEqual(['恢复后再发送这条消息']);
    await f.signal(renewed, 'complete');
    await expect.poll(async () => (await snapshot(page, session.id)).queue?.items ?? []).toEqual([]);
    await closeQueueApp(app); app = await f.launch(); page = await app.firstWindow();
    await expect(editor(page)).toHaveValue('尚未提交的草稿');
    expect((await page.evaluate(() => window.desktop.snapshot())).state.sessions[0].execution.conversationId).toBe(renewed.execution.conversationId);
    await expect(page.locator('.chat-message.user').filter({ hasText: '保留此前聊天' })).toBeVisible();
  } finally { await closeQueueApp(app); await f.dispose(); }
});

test('chat queue: accepted messages clear immediately, Enter is deduplicated, FIFO preserves the next draft and queued attachments', async () => {
  const f = await chatQueueWorkspace(), app = await f.launch();
  try {
    const page = await app.firstWindow(), [session] = f.sessions;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 680));
    await editor(page).fill('第一项保持运行');
    await editor(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter' });
    await editor(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', repeat: true });
    await expect(editor(page)).toHaveValue('');
    await expect.poll(() => f.prompts(session)).toEqual(['第一项保持运行']);
    expect((await f.records()).filter(value => value.event === 'result')).toHaveLength(0);
    await expect(editor(page)).toBeEnabled();

    await submit(page, '第二项顺序执行');
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, f.attachment);
    await page.getByRole('button', { name: '添加附件', exact: true }).click();
    await expect(page.locator('.attachment-chips')).toContainText('queue-image.png');
    await submit(page, '第三项带附件');
    await expect(page.locator('.attachment-chips')).toHaveCount(0);
    await expect.poll(() => queueTexts(page, session.id)).toEqual(['第二项顺序执行', '第三项带附件']);
    expect((await snapshot(page, session.id)).queue?.items.find(item => item.text === '第三项带附件')?.attachments).toHaveLength(1);
    expect(await f.prompts(session)).toEqual(['第一项保持运行']);
    await queued(page, '第三项带附件').hover();
    await expect(queued(page, '第三项带附件').locator('.queued-chat-actions')).toHaveCSS('opacity', '1');
    await expect(editor(page)).toBeInViewport({ ratio: 1 });
    await expect(page.locator('.chat-composer').getByRole('button', { name: '加入队列', exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.locator('.chat-composer').getByRole('button', { name: '中断', exact: true })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(os.tmpdir(), 'ccdesk-chat-queue-narrow.png') });

    await editor(page).fill('还未提交的下一条草稿');
    for (const expected of [['第一项保持运行', '第二项顺序执行'], ['第一项保持运行', '第二项顺序执行', '第三项带附件']]) {
      await f.signal(session, 'complete');
      await expect.poll(() => f.prompts(session)).toEqual(expected);
      await expect(editor(page)).toHaveValue('还未提交的下一条草稿');
    }
    const attached = (await f.records()).find(value => value.event === 'prompt' && value.text === '第三项带附件');
    expect(attached?.content?.some(value => value.type === 'image' && value.source?.media_type === 'image/png' && value.source.data.length > 0)).toBe(true);
    await f.signal(session, 'complete');
    await expect.poll(async () => (await snapshot(page, session.id)).queue?.items ?? []).toEqual([]);
    await expect(editor(page)).toHaveValue('还未提交的下一条草稿');
    expect((await snapshot(page, session.id)).messages.filter(value => value.role === 'user')).toHaveLength(3);
    expect((await f.records()).filter(value => value.event === 'violation')).toEqual([]);
  } finally { await closeQueueApp(app); await f.dispose(); }
});

test('chat queue: hover and keyboard send-now wait for the interrupted turn to settle and preserve all other queued order', async () => {
  const f = await chatQueueWorkspace(), app = await f.launch();
  try {
    const page = await app.firstWindow(), [session] = f.sessions;
    await submit(page, '正在执行的旧任务');
    await expect.poll(() => f.prompts(session)).toEqual(['正在执行的旧任务']);
    for (const text of ['原队首任务', '需要立即执行的任务', '原队尾任务']) await submit(page, text);
    const urgent = queued(page, '需要立即执行的任务');
    await urgent.hover();
    const sendNow = urgent.getByRole('button', { name: '立即发送', exact: true });
    await expect(sendNow).toBeVisible();
    await expect(urgent.locator('.queued-chat-actions')).toHaveCSS('opacity', '1');
    await editor(page).hover(); await urgent.focus(); await urgent.press('Tab');
    await expect(sendNow).toBeFocused();
    await expect(urgent.locator('.queued-chat-actions')).toHaveCSS('opacity', '1');
    await sendNow.press('Enter');
    await expect.poll(async () => (await f.records()).filter(value => value.event === 'interrupt').length).toBe(1);
    await f.signal(session, 'barrier');
    expect(await f.prompts(session)).toEqual(['正在执行的旧任务']);
    await f.signal(session, 'release-interrupt');
    await expect.poll(() => f.prompts(session)).toEqual(['正在执行的旧任务', '需要立即执行的任务']);
    await expect.poll(() => queueTexts(page, session.id)).toEqual(['原队首任务', '原队尾任务']);
    const records = await f.records();
    expect(records.findIndex(value => value.event === 'interrupt')).toBeLessThan(records.findIndex(value => value.event === 'result' && value.text === '正在执行的旧任务'));
    expect(records.findIndex(value => value.event === 'result' && value.text === '正在执行的旧任务')).toBeLessThan(records.findIndex(value => value.event === 'prompt' && value.text === '需要立即执行的任务'));
    await f.signal(session, 'complete');
    await expect.poll(() => f.prompts(session)).toEqual(['正在执行的旧任务', '需要立即执行的任务', '原队首任务']);
    await f.signal(session, 'complete');
    await expect.poll(() => f.prompts(session)).toEqual(['正在执行的旧任务', '需要立即执行的任务', '原队首任务', '原队尾任务']);
    await f.signal(session, 'complete');
    await expect.poll(async () => (await snapshot(page, session.id)).queue?.items ?? []).toEqual([]);
    expect((await f.records()).filter(value => value.event === 'violation')).toEqual([]);
  } finally { await closeQueueApp(app); await f.dispose(); }
});

test('chat queue: session switches and restart retain isolated queues and require explicit recovery before sending', async () => {
  const f = await chatQueueWorkspace(); let app = await f.launch();
  try {
    let page = await app.firstWindow(); const [a, b] = f.sessions;
    await submit(page, 'A 尚未完成'); await expect.poll(() => f.prompts(a)).toEqual(['A 尚未完成']);
    await submit(page, 'A 待发消息'); await editor(page).fill('A 独立草稿');
    await select(page, b.title);
    await expect(editor(page)).toHaveValue('');
    await expect(page.getByLabel('待发送消息', { exact: true })).toHaveCount(0);
    await submit(page, 'B 尚未完成'); await expect.poll(() => f.prompts(b)).toEqual(['B 尚未完成']);
    await submit(page, 'B 待发消息');
    await expect(queued(page, 'A 待发消息')).toHaveCount(0);
    await select(page, a.title); await expect(editor(page)).toHaveValue('A 独立草稿');
    await expect(queued(page, 'B 待发消息')).toHaveCount(0);

    await closeQueueApp(app); app = await f.launch(); page = await app.firstWindow();
    await expect(editor(page)).toHaveValue('A 独立草稿');
    for (const session of [a, b]) {
      await expect.poll(async () => (await snapshot(page, session.id)).queue?.paused).toBe(true);
      expect(await f.prompts(session)).toEqual([session === a ? 'A 尚未完成' : 'B 尚未完成']);
    }
    await select(page, b.title);
    await expect(queued(page, 'B 待发消息')).toBeVisible(); await expect(queued(page, 'A 待发消息')).toHaveCount(0);
    await remove(page, 'B 尚未完成');
    await page.getByRole('button', { name: '继续发送队列', exact: true }).click();
    await expect.poll(() => f.prompts(b)).toEqual(['B 尚未完成', 'B 待发消息']);
    expect(await f.prompts(a)).toEqual(['A 尚未完成']);
    await select(page, a.title); await expect(editor(page)).toHaveValue('A 独立草稿');
    await remove(page, 'A 尚未完成');
    await page.getByRole('button', { name: '继续发送队列', exact: true }).click();
    await expect.poll(() => f.prompts(a)).toEqual(['A 尚未完成', 'A 待发消息']);
    await f.signal(a, 'complete'); await f.signal(b, 'complete');
    await expect.poll(async () => (await snapshot(page, a.id)).queue?.items ?? []).toEqual([]);
    await expect.poll(async () => (await snapshot(page, b.id)).queue?.items ?? []).toEqual([]);
    await expect(editor(page)).toHaveValue('A 独立草稿');
    expect((await f.records()).filter(value => value.event === 'violation')).toEqual([]);
  } finally { await closeQueueApp(app); await f.dispose(); }
});

test('chat queue: a failed turn and an explicit interrupt pause without losing later messages or silently replaying them', async () => {
  const f = await chatQueueWorkspace(), app = await f.launch();
  try {
    const page = await app.firstWindow(), [session] = f.sessions;
    await submit(page, '执行失败的任务'); await expect.poll(() => f.prompts(session)).toEqual(['执行失败的任务']);
    await submit(page, '失败后仍需保留的任务');
    await f.signal(session, 'fail');
    await expect.poll(async () => (await snapshot(page, session.id)).queue?.paused).toBe(true);
    await expect.poll(() => queueTexts(page, session.id)).toEqual(['执行失败的任务', '失败后仍需保留的任务']);
    expect(await f.prompts(session)).toEqual(['执行失败的任务']);
    await remove(page, '执行失败的任务');
    await page.getByRole('button', { name: '继续发送队列', exact: true }).click();
    await expect.poll(() => f.prompts(session)).toEqual(['执行失败的任务', '失败后仍需保留的任务']);
    await submit(page, '中断后仍需保留的任务');
    await page.locator('.chat-composer').getByRole('button', { name: '中断', exact: true }).click();
    await expect.poll(async () => (await f.records()).filter(value => value.event === 'interrupt').length).toBe(1);
    await f.signal(session, 'release-interrupt');
    await expect.poll(async () => (await snapshot(page, session.id)).queue?.paused).toBe(true);
    await expect.poll(() => queueTexts(page, session.id)).toEqual(['失败后仍需保留的任务', '中断后仍需保留的任务']);
    expect(await f.prompts(session)).toEqual(['执行失败的任务', '失败后仍需保留的任务']);
    await remove(page, '失败后仍需保留的任务');
    await page.getByRole('button', { name: '继续发送队列', exact: true }).click();
    await expect.poll(() => f.prompts(session)).toEqual(['执行失败的任务', '失败后仍需保留的任务', '中断后仍需保留的任务']);
    await f.signal(session, 'complete');
    await expect.poll(async () => (await snapshot(page, session.id)).queue?.items ?? []).toEqual([]);
    expect((await f.records()).filter(value => value.event === 'violation')).toEqual([]);
  } finally { await closeQueueApp(app); await f.dispose(); }
});
