import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import type { IpcMainInvokeEvent } from 'electron';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { chatQueueWorkspace, closeQueueApp } from './fixtures/chat-queue-fixture';
import type { Session } from '../src/shared/types';
import type { ChatSnapshot } from '../src/shared/chat';

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

interface ChatFeedbackFixture {
  holdSubmission(): void;
  submissionEntered(): boolean;
  releaseSubmission(error?: string): void;
  holdAcknowledgement(): void;
  acknowledgementEntered(): boolean;
  releaseAcknowledgement(): void;
  holdSnapshot(): void;
  snapshotReadsEntered(): number;
  releaseSnapshot(): void;
  holdProjection(): void;
  releaseProjection(): void;
  holdInterrupt(): void;
  interruptEntered(): boolean;
  releaseInterrupt(): void;
  refresh(): void;
  records(): {
    submissions: { id: string; text: string; requestId?: string }[];
    acknowledgements: { requestId?: string; messageId: string }[];
    submissionFeedback: { text: string; draft: string; visible: boolean }[];
    interrupts: number; interruptFeedback: { text: string; disabled: boolean }[]; reads: number;
  };
  dispose(): void;
}
type ChatFeedbackGlobal = typeof globalThis & { chatQueueFeedbackFixture: ChatFeedbackFixture };

/** 包装真实 IPC；门闩控制接收/投影/中断时机，校验、队列和 CLI 都由产品执行。 */
async function installChatFeedbackFixture(app: ElectronApplication, sessionId: string) {
  await app.evaluate(({ ipcMain, BrowserWindow }, sessionId) => {
    type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
    type Gate = { entered: boolean; resolve?: () => void; reject?: (error: Error) => void };
    type SnapshotGate = { entered: number; promise: Promise<void>; resolve: () => void };
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, Handler> })._invokeHandlers;
    if (!(handlers instanceof Map)) throw new Error('Electron IPC invoke handler interception is unavailable');
    const submitHandler = handlers.get('chat:submit'), snapshotHandler = handlers.get('chat:snapshot'), interruptHandler = handlers.get('session:interrupt');
    if (!submitHandler || !snapshotHandler || !interruptHandler) throw new Error('Expected real chat submission, snapshot and interrupt handlers');
    let submissionGate: Gate | undefined, acknowledgementGate: Gate | undefined, interruptGate: Gate | undefined;
    let snapshotGate: SnapshotGate | undefined;
    let projectionHeld = false, reads = 0, interrupts = 0;
    const submissions: { id: string; text: string; requestId?: string }[] = [];
    const acknowledgements: { requestId?: string; messageId: string }[] = [];
    const submissionFeedback: { text: string; draft: string; visible: boolean }[] = [];
    const interruptFeedback: { text: string; disabled: boolean }[] = [];
    const refresh = () => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('chat:changed', sessionId); };
    ipcMain.removeHandler('chat:submit');
    ipcMain.handle('chat:submit', async (event, input: { id: string; text: string; requestId?: string }) => {
      if (input.id !== sessionId) return submitHandler(event, input);
      submissions.push({ id: input.id, text: input.text, requestId: input.requestId });
      submissionFeedback.push(await event.sender.executeJavaScript(`(() => {
        const card = document.querySelector('[aria-label="消息提交状态"]');
        const editor = document.querySelector('[aria-label="提示词编辑器"]');
        return { text: card?.textContent ?? '', draft: editor?.value ?? '', visible: !!card && card.getBoundingClientRect().height > 0 };
      })()`));
      const gate = submissionGate;
      if (gate) {
        gate.entered = true;
        await new Promise<void>((resolve, reject) => { gate.resolve = resolve; gate.reject = reject; });
      }
      const receipt = await submitHandler(event, input) as { messageId: string };
      acknowledgements.push({ requestId: input.requestId, messageId: receipt.messageId });
      const acknowledgement = acknowledgementGate;
      if (acknowledgement) {
        acknowledgement.entered = true;
        await new Promise<void>((resolve, reject) => { acknowledgement.resolve = resolve; acknowledgement.reject = reject; });
      }
      return receipt;
    });
    ipcMain.removeHandler('chat:snapshot');
    ipcMain.handle('chat:snapshot', async (event, id: string) => {
      const gate = id === sessionId ? snapshotGate : undefined;
      if (gate) { gate.entered++; await gate.promise; }
      const value = await snapshotHandler(event, id) as ChatSnapshot;
      if (id !== sessionId) return value;
      reads++;
      // 保留真实 sending 队列，只推迟正式用户消息的可见投影。
      // 不伪造轮次、完成状态、接收回执或队列内容。
      return projectionHeld ? { ...value, messages: value.messages.filter(message => message.role !== 'user') } : value;
    });
    ipcMain.removeHandler('session:interrupt');
    ipcMain.handle('session:interrupt', async (event, id: string) => {
      if (id !== sessionId) return interruptHandler(event, id);
      interrupts++;
      interruptFeedback.push(await event.sender.executeJavaScript(`(() => {
        const button = [...document.querySelectorAll('.chat-composer button')].find(button => button.textContent?.trim() === '正在停止…');
        return { text: button?.textContent ?? '', disabled: !!button?.disabled };
      })()`));
      const gate = interruptGate;
      if (gate) {
        gate.entered = true;
        await new Promise<void>((resolve, reject) => { gate.resolve = resolve; gate.reject = reject; });
      }
      return interruptHandler(event, id);
    });
    (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture = {
      holdSubmission: () => { if (submissionGate) throw new Error('Submission gate already armed'); submissionGate = { entered: false }; },
      submissionEntered: () => submissionGate?.entered === true,
      releaseSubmission: error => {
        const gate = submissionGate; submissionGate = undefined;
        if (!gate?.resolve) throw new Error('No pending submission reached the gate');
        if (error) gate.reject!(new Error(error)); else gate.resolve();
      },
      holdAcknowledgement: () => { if (acknowledgementGate) throw new Error('Acknowledgement gate already armed'); acknowledgementGate = { entered: false }; },
      acknowledgementEntered: () => acknowledgementGate?.entered === true,
      releaseAcknowledgement: () => {
        const gate = acknowledgementGate; acknowledgementGate = undefined;
        if (!gate?.resolve) throw new Error('No real submission acknowledgement reached the gate');
        gate.resolve();
      },
      holdSnapshot: () => {
        if (snapshotGate) throw new Error('Snapshot gate already armed');
        let resolve!: () => void;
        const promise = new Promise<void>(done => { resolve = done; });
        snapshotGate = { entered: 0, promise, resolve };
      },
      snapshotReadsEntered: () => snapshotGate?.entered ?? 0,
      releaseSnapshot: () => {
        const gate = snapshotGate; snapshotGate = undefined;
        if (!gate) throw new Error('No snapshot gate armed');
        gate.resolve();
      },
      holdProjection: () => { projectionHeld = true; },
      releaseProjection: () => { projectionHeld = false; refresh(); },
      holdInterrupt: () => { if (interruptGate) throw new Error('Interrupt gate already armed'); interruptGate = { entered: false }; },
      interruptEntered: () => interruptGate?.entered === true,
      releaseInterrupt: () => {
        const gate = interruptGate; interruptGate = undefined;
        if (!gate?.resolve) throw new Error('No pending interrupt reached the gate');
        gate.resolve();
      },
      refresh,
      records: () => ({ submissions, acknowledgements, submissionFeedback, interrupts, interruptFeedback, reads }),
      dispose: () => {
        submissionGate?.reject?.(new Error('Feedback fixture disposed'));
        acknowledgementGate?.reject?.(new Error('Feedback fixture disposed'));
        const gate = snapshotGate; snapshotGate = undefined; gate?.resolve();
        interruptGate?.reject?.(new Error('Feedback fixture disposed'));
      },
    };
  }, sessionId);
}

test('chat queue feedback: delayed acceptance and canonical projection keep the full message visible across session switches', async () => {
  const f = await chatQueueWorkspace(), app = await f.launch();
  try {
    const page = await app.firstWindow(), [a, b] = f.sessions;
    await expect(page.getByRole('heading', { name: a.title, exact: true })).toBeVisible();
    await installChatFeedbackFixture(app, a.id);
    await app.evaluate(() => { const fixture = (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture; fixture.holdSubmission(); fixture.holdProjection(); });
    const text = '请完整保留这条提交中的任务。\n第一步检查项目现状与已有操作，第二步修复问题并执行验证。\n即使启动与恢复上下文暂未结束，这里的最后一句也必须保持可见。';
    await editor(page).fill(text);
    await editor(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter' });
    await editor(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', repeat: true });
    const pending = page.getByLabel('消息提交状态', { exact: true });
    await expect(pending).toContainText('正在提交…');
    await expect(pending.locator('.queued-chat-text')).toHaveText(text);
    await expect(editor(page)).toHaveValue(text);
    await expect.poll(() => app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture.submissionEntered())).toBe(true);
    const entered = await app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture.records());
    expect(entered.submissions).toHaveLength(1);
    expect(entered.submissionFeedback[0]).toEqual({ text: expect.stringContaining('正在提交…'), draft: text, visible: true });
    const requestId = await pending.locator('[data-submission-request-id]').getAttribute('data-submission-request-id');
    expect(requestId).toBe(entered.submissions[0].requestId);

    await select(page, b.title);
    await editor(page).fill('B 的独立草稿');
    await expect(pending).toHaveCount(0);
    await select(page, a.title);
    await expect(pending.locator('.queued-chat-text')).toHaveText(text);
    await expect(editor(page)).toHaveValue(text);
    await editor(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', repeat: true });
    await app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture.releaseSubmission());
    await expect(editor(page)).toHaveValue('');
    await expect.poll(() => f.prompts(a)).toEqual([text]);
    const startup = page.getByLabel('正在启动的消息', { exact: true });
    await expect(startup).toContainText('正在准备会话与上下文…');
    await expect(startup.locator('.queued-chat-text')).toHaveText(text);
    await expect(pending).toHaveCount(0);
    await expect(page.locator('.chat-message.user')).toHaveCount(0);
    const sending = (await snapshot(page, a.id)).queue!.items.find(item => item.clientRequestId === requestId)!;
    expect(sending.status).toBe('sending');
    expect((await app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture.records())).submissions).toHaveLength(1);

    await app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture.releaseProjection());
    await expect(page.locator('.chat-message.user').filter({ hasText: text })).toHaveCount(1);
    await expect(startup).toHaveCount(0);
    await expect(pending).toHaveCount(0);
    const canonical = (await snapshot(page, a.id)).messages.filter(message => message.role === 'user' && message.text === text);
    expect(canonical).toHaveLength(1); expect(canonical[0].submissionId).toBe(sending.id);

    // ACK 只能清理其捕获的原稿，不能清理等待期间输入的新草稿。
    await app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture.holdSubmission());
    await editor(page).fill('第二条排队任务'); await editor(page).press('Enter');
    await expect.poll(() => app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture.submissionEntered())).toBe(true);
    await editor(page).fill('确认等待期间写下的新草稿');
    await app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture.releaseSubmission());
    await expect(queued(page, '第二条排队任务')).toBeVisible();
    await expect(editor(page)).toHaveValue('确认等待期间写下的新草稿');
    await select(page, b.title); await expect(editor(page)).toHaveValue('B 的独立草稿');
    await select(page, a.title); await expect(editor(page)).toHaveValue('确认等待期间写下的新草稿');
    await f.signal(a, 'complete'); await expect.poll(() => f.prompts(a)).toEqual([text, '第二条排队任务']);
    await f.signal(a, 'complete');
    await expect.poll(async () => (await snapshot(page, a.id)).queue?.items ?? []).toEqual([]);
    expect((await f.records()).filter(record => record.event === 'violation')).toEqual([]);
  } finally {
    await app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture?.dispose()).catch(() => {});
    await closeQueueApp(app); await f.dispose();
  }
});

test('chat queue feedback: raw display takes over an exact persisted submission before ACK and snapshot delivery without duplicating its prompt', async () => {
  const f = await chatQueueWorkspace(), app = await f.launch();
  try {
    const page = await app.firstWindow(), [a, b] = f.sessions;
    await expect(page.getByRole('heading', { name: a.title, exact: true })).toBeVisible();
    await expect(page.locator('.chat-empty')).toBeVisible();
    await snapshot(page, a.id);
    await installChatFeedbackFixture(app, a.id);
    await app.evaluate(() => {
      const fixture = (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture;
      fixture.holdAcknowledgement(); fixture.holdSnapshot(); fixture.holdProjection();
    });
    const text = '这条已持久接收但确认尚未返回的完整任务只能显示一次。请检查原始操作、修复问题并执行验证，切换会话后也要保留最后这句话。';
    await editor(page).fill(text); await editor(page).press('Enter');
    const pending = page.getByLabel('消息提交状态', { exact: true });
    await expect(pending.locator('.queued-chat-text')).toHaveText(text);
    await expect.poll(() => app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture.acknowledgementEntered())).toBe(true);
    await expect.poll(() => app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture.snapshotReadsEntered())).toBeGreaterThan(0);
    await expect.poll(() => f.prompts(a)).toEqual([text]);
    const received = await app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture.records());
    expect(received.submissions).toHaveLength(1);
    expect(received.acknowledgements).toHaveLength(1);
    const requestId = received.submissions[0].requestId!, messageId = received.acknowledgements[0].messageId;
    expect(requestId).toBeTruthy(); expect(messageId).toBeTruthy();
    expect(received.acknowledgements[0].requestId).toBe(requestId);
    // This is the untouched real display handler. Its canonical identity is joined
    // to the request using the host's durable queue receipt, not prompt text.
    await expect.poll(async () => (await page.evaluate(id => window.desktop.chatDisplay(id), a.id)).messages
      .filter(message => message.role === 'user' && message.text === text)
      .map(message => ({ submissionId: message.submissionId, clientRequestId: message.clientRequestId })))
      .toEqual([{ submissionId: messageId, clientRequestId: requestId }]);
    await expect(editor(page)).toHaveValue(text);

    await select(page, b.title); await editor(page).fill('B 保留独立原稿');
    await expect(pending).toHaveCount(0);
    await select(page, a.title);
    const canonical = page.locator('.chat-message.user').filter({ hasText: text });
    const startup = page.getByLabel('正在启动的消息', { exact: true });
    const onlyPrompt = page.locator('.chat-scroll').getByText(text, { exact: true });
    await expect(canonical).toHaveCount(1);
    await expect(onlyPrompt).toHaveCount(1);
    await expect(pending).toHaveCount(0);
    await expect(startup).toHaveCount(0);
    await expect(editor(page)).toHaveValue(text);
    await editor(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', repeat: true });

    // All blocked authority reads share one release, including reads issued by
    // the remounted pane. The user projection remains held while its real
    // sending queue and receipt reach the renderer.
    await app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture.releaseSnapshot());
    await expect.poll(async () => (await snapshot(page, a.id)).queue?.items
      .filter(item => item.clientRequestId === requestId)
      .map(item => ({ id: item.id, status: item.status })))
      .toEqual([{ id: messageId, status: 'sending' }]);
    expect((await snapshot(page, a.id)).messages.filter(message => message.role === 'user')).toEqual([]);
    await expect(canonical).toHaveCount(1);
    await expect(onlyPrompt).toHaveCount(1);
    await expect(pending).toHaveCount(0);
    await expect(startup).toHaveCount(0);
    await expect(editor(page)).toHaveValue(text);

    await app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture.releaseAcknowledgement());
    await expect(editor(page)).toHaveValue('');
    await expect(canonical).toHaveCount(1);
    await expect(onlyPrompt).toHaveCount(1);
    await expect(pending).toHaveCount(0); await expect(startup).toHaveCount(0);
    await select(page, b.title); await expect(editor(page)).toHaveValue('B 保留独立原稿');
    await select(page, a.title); await expect(editor(page)).toHaveValue('');
    await expect(canonical).toHaveCount(1); await expect(onlyPrompt).toHaveCount(1);
    // A display row proves presentation identity, never the result of stopping.
    // Keep the real post-ACK authority read behind a separate shared gate.
    await app.evaluate(() => {
      const fixture = (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture;
      fixture.holdSnapshot(); fixture.holdInterrupt();
    });
    await page.locator('.chat-composer').getByRole('button', { name: '停止本轮', exact: true }).click();
    const stopping = page.locator('.chat-composer').getByRole('button', { name: '正在停止…', exact: true });
    await expect(stopping).toBeDisabled();
    await expect.poll(() => app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture.interruptEntered())).toBe(true);
    await app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture.releaseInterrupt());
    await expect.poll(async () => (await f.records()).filter(record => record.event === 'interrupt').length).toBe(1);
    await expect.poll(() => app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture.snapshotReadsEntered())).toBeGreaterThan(0);
    expect((await page.evaluate(id => window.desktop.chatDisplay(id), a.id)).messages.filter(message => message.role === 'user' && message.clientRequestId === requestId)).toHaveLength(1);
    await expect(canonical).toHaveCount(1); await expect(stopping).toBeDisabled();
    await stopping.dispatchEvent('click');
    await f.signal(a, 'release-interrupt');
    await expect(stopping).toBeDisabled();
    expect((await app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture.records())).interrupts).toBe(1);
    await app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture.releaseSnapshot());
    await expect(stopping).toHaveCount(0);
    // An interrupted turn retains the exact accepted message for deliberate
    // recovery. Its presence is not a second submission or automatic retry.
    await expect.poll(async () => {
      const queue = (await snapshot(page, a.id)).queue;
      return { paused: queue?.paused, items: queue?.items.map(item => ({
        id: item.id, clientRequestId: item.clientRequestId, text: item.text, status: item.status,
      })) };
    }).toEqual({ paused: true, items: [{ id: messageId, clientRequestId: requestId, text, status: 'queued' }] });
    expect((await snapshot(page, a.id)).queue?.error).toContain('消息已保留');
    expect((await app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture.records())).submissions).toHaveLength(1);
    expect(await f.prompts(a)).toEqual([text]);
    expect((await f.records()).filter(record => record.event === 'violation')).toEqual([]);
  } finally {
    await app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture?.dispose()).catch(() => {});
    await closeQueueApp(app); await f.dispose();
  }
});

test('chat queue feedback: stopping is immediate and stays disabled through delayed IPC and authoritative refresh', async () => {
  const f = await chatQueueWorkspace(), app = await f.launch();
  try {
    const page = await app.firstWindow(), [session] = f.sessions;
    await expect(page.getByRole('heading', { name: session.title, exact: true })).toBeVisible();
    await installChatFeedbackFixture(app, session.id);
    await submit(page, '等待用户停止的真实 CLI 回合');
    await expect.poll(() => f.prompts(session)).toEqual(['等待用户停止的真实 CLI 回合']);
    await app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture.holdInterrupt());
    await page.locator('.chat-composer').getByRole('button', { name: '停止本轮', exact: true }).click();
    const stopping = page.locator('.chat-composer').getByRole('button', { name: '正在停止…', exact: true });
    await expect(stopping).toBeDisabled();
    await expect.poll(() => app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture.interruptEntered())).toBe(true);
    const before = await app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture.records());
    expect(before.interrupts).toBe(1);
    expect(before.interruptFeedback[0]).toEqual({ text: '正在停止…', disabled: true });
    await stopping.dispatchEvent('click'); await stopping.dispatchEvent('click');
    await app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture.refresh());
    await expect.poll(() => app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture.records().reads)).toBeGreaterThan(before.reads);
    await expect(stopping).toBeDisabled();
    expect((await app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture.records())).interrupts).toBe(1);
    expect((await f.records()).filter(record => record.event === 'interrupt')).toHaveLength(0);
    await app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture.releaseInterrupt());
    await expect.poll(async () => (await f.records()).filter(record => record.event === 'interrupt').length).toBe(1);
    // CLI 的中断确认不是回合终态，只有显式结果信号才能结束这一轮。
    expect((await f.records()).filter(record => record.event === 'result')).toHaveLength(0);
    await f.signal(session, 'release-interrupt');
    await expect.poll(async () => (await snapshot(page, session.id)).queue?.paused).toBe(true);
    await expect(stopping).toHaveCount(0);
    expect((await app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture.records())).interrupts).toBe(1);
    expect((await f.records()).filter(record => record.event === 'violation')).toEqual([]);
  } finally {
    await app.evaluate(() => (globalThis as ChatFeedbackGlobal).chatQueueFeedbackFixture?.dispose()).catch(() => {});
    await closeQueueApp(app); await f.dispose();
  }
});

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
    await expect(dialog).toContainText('此操作不能恢复原来的引擎上下文');
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
    await expect(page.locator('.chat-message.user').filter({ hasText: '第一项保持运行' })).toBeVisible();
    await expect(page.locator('.thinking-indicator')).toBeVisible();
    await expect(page.getByLabel('待发送消息', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/消息已(?:发送|接收)/)).toHaveCount(0);

    await submit(page, '第二项顺序执行');
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, f.attachment);
    await page.getByRole('button', { name: '添加附件', exact: true }).click();
    await expect(page.locator('.attachment-chips')).toContainText('queue-image.png');
    await submit(page, '第三项带附件');
    await expect(page.locator('.attachment-chips')).toHaveCount(0);
    await expect.poll(() => queueTexts(page, session.id)).toEqual(['第二项顺序执行', '第三项带附件']);
    expect((await snapshot(page, session.id)).queue?.items.find(item => item.text === '第三项带附件')?.attachments).toHaveLength(1);
    expect(await f.prompts(session)).toEqual(['第一项保持运行']);
    await expect(page.getByLabel('待发送消息', { exact: true })).toContainText('待发送 · 2');
    await expect(page.getByText('当前任务结束后按顺序发送', { exact: true })).toBeVisible();
    await expect(page.getByText(/消息已(?:发送|接收)/)).toHaveCount(0);
    await queued(page, '第三项带附件').hover();
    await expect(queued(page, '第三项带附件').locator('.queued-chat-actions')).toHaveCSS('opacity', '1');
    await expect(editor(page)).toBeInViewport({ ratio: 1 });
    await expect(page.locator('.chat-composer').getByRole('button', { name: '加入队列', exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.locator('.chat-composer').getByRole('button', { name: '停止本轮', exact: true })).toBeInViewport({ ratio: 1 });
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
    await expect(page.getByLabel('待发送消息', { exact: true })).toHaveCount(0);
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
    let page = await app.firstWindow(); const [a, initialB] = f.sessions;
    await expect(page.getByRole('heading', { name: a.title, exact: true })).toBeVisible();
    // 本测试验证并行队列；单独注册的根目录允许这种并发，
    // 同时遵守同一目录的执行互斥限制。
    const independentRoot = path.join(path.dirname(a.cwd), 'independent-queue-project');
    await fs.mkdir(independentRoot);
    const b = JSON.parse(await page.evaluate(async ({ root, initialId, title, selected }) => {
      await window.desktop.deleteSession(initialId);
      const project = await window.desktop.addProject(root);
      const session = await window.desktop.createSession({ projectId: project.id, title, kind: 'agent', providerId: 'claude', mode: 'structured', isolated: false });
      await window.desktop.setSelection(selected);
      return JSON.stringify(session);
    }, { root: independentRoot, initialId: initialB.id, title: initialB.title, selected: a.id })) as Session;
    expect(b.projectId).not.toBe(a.projectId); expect(b.cwd).not.toBe(a.cwd);
    await expect(page.getByRole('heading', { name: a.title, exact: true })).toBeVisible();
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
    await page.locator('.chat-composer').getByRole('button', { name: '停止本轮', exact: true }).click();
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
