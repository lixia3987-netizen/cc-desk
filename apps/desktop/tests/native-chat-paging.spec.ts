import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import type { IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ChatDisplayPage, ChatPageOptions } from '../src/shared/chat';
import { desktopRoot } from './helpers/paths';
import { electronLaunchArgs } from './helpers/electron-launch';
import { closeNativeApp } from './helpers/native-app-cleanup';
import { sessionRow } from './helpers/session-ui';
import { appendNativePagingTurn, prepareNativePagingWorkspace, type PagingSession } from './helpers/native-chat-paging';

interface DisplayRead { id: string; before?: string; after?: string; around?: string; count?: number; bytes?: number; first?: string; last?: string; error?: string }
interface PagingFixture {
  records(): { display: DisplayRead[]; snapshotAttempts: Record<string, number> };
  holdAfter(id: string): void;
  entered(): boolean;
  release(): void;
  failSnapshots(id: string, count: number): void;
  dispose(): void;
}
type FixtureGlobal = typeof globalThis & { nativePagingFixture: PagingFixture };

async function windowGeometry(app: ElectronApplication, page: Page) {
  const native = await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0], display = screen.getDisplayMatching(window.getBounds());
    return { bounds: window.getBounds(), contentBounds: window.getContentBounds(), maximized: window.isMaximized(),
      display: { bounds: display.bounds, workArea: display.workArea, scaleFactor: display.scaleFactor } };
  });
  const renderer = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio }));
  return { native, renderer };
}

async function workspace(long = false) {
  const prepared = await prepareNativePagingWorkspace(long);
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot,
      env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: prepared.data } });
    const page = await app.firstWindow();
    await expect(page.locator('main.workspace')).toBeVisible();
    // Host work areas vary. Establish the real viewport required by the
    // byte-clipped eight-row underfill fixture before selecting any session.
    await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window.isMaximized()) await new Promise<void>(resolve => {
        window.once('unmaximize', () => resolve()); window.unmaximize();
      });
      window.setContentSize(1460, 1200);
    });
    await frames(page);
    const geometry = await windowGeometry(app, page);
    await test.info().attach('native-paging-window.json', { body: JSON.stringify(geometry), contentType: 'application/json' });
    expect(geometry.native.maximized).toBe(false);
    expect(geometry.native.contentBounds).toMatchObject({ width: 1460, height: 1200 });
    expect(geometry.renderer).toMatchObject({ width: 1460, height: 1200 });
    await app.evaluate(({ ipcMain }) => {
      type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
      const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, Handler> })._invokeHandlers;
      const original = handlers?.get('chat:display'), snapshot = handlers?.get('chat:snapshot');
      if (!original || !snapshot) throw new Error('The real display and snapshot IPC handlers are required');
      const records: DisplayRead[] = [], snapshotAttempts: Record<string, number> = {}, failures = new Map<string, number>();
      let gate: { id: string; entered: boolean; promise: Promise<void>; resolve(): void } | undefined;
      ipcMain.removeHandler('chat:snapshot');
      ipcMain.handle('chat:snapshot', async (event, id: string) => {
        snapshotAttempts[id] = (snapshotAttempts[id] ?? 0) + 1;
        const left = failures.get(id) ?? 0;
        // A transient failure occurs before the real handler. Successful snapshots are never fabricated.
        if (left) { failures.set(id, left - 1); throw new Error('PAGING_TRANSIENT_SNAPSHOT_UNAVAILABLE'); }
        return snapshot(event, id);
      });
      ipcMain.removeHandler('chat:display');
      ipcMain.handle('chat:display', async (event, input: ChatPageOptions & { id: string }) => {
        try {
          const value = await original(event, input) as ChatDisplayPage;
          records.push({ ...input, count: value.messages.length, bytes: Buffer.byteLength(JSON.stringify(value)), first: value.messages[0]?.id, last: value.messages.at(-1)?.id });
          // Delay only delivery of a genuine page to exercise a late response after switching sessions.
          if (gate?.id === input.id && input.after && !gate.entered) { gate.entered = true; await gate.promise; }
          return value;
        } catch (error) { records.push({ ...input, error: String(error) }); throw error; }
      });
      (globalThis as FixtureGlobal).nativePagingFixture = {
        records: () => ({ display: [...records], snapshotAttempts: { ...snapshotAttempts } }),
        holdAfter: id => {
          if (gate) throw new Error('An after-page gate is already armed');
          let resolve!: () => void;
          const promise = new Promise<void>(yes => { resolve = yes; });
          gate = { id, entered: false, promise, resolve };
        },
        entered: () => !!gate?.entered,
        release: () => { const pending = gate; if (!pending?.entered) throw new Error('A real after page has not reached the gate'); gate = undefined; pending.resolve(); },
        failSnapshots: (id, count) => failures.set(id, count),
        dispose: () => { gate?.resolve(); gate = undefined; },
      };
    });
    const launched = app;
    return { ...prepared, app: launched, page, close: async () => {
      await launched.evaluate(() => (globalThis as FixtureGlobal).nativePagingFixture.dispose()).catch(() => {});
      try { await closeNativeApp(launched); }
      finally { await fs.rm(prepared.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    } };
  } catch (error) {
    if (app) await closeNativeApp(app);
    await fs.rm(prepared.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    throw error;
  }
}

async function select(page: Page, value: PagingSession) {
  await sessionRow(page, value.session.title).click();
  await expect(page.getByRole('heading', { name: value.session.title, exact: true })).toBeVisible();
  await expect(page.locator('.chat-pane')).toHaveAttribute('data-session-id', value.session.id);
}

async function count(page: Page) { return Number(await page.locator('[data-virtual-chat-list]').getAttribute('data-message-count')); }
async function records(app: ElectronApplication) { return app.evaluate(() => (globalThis as FixtureGlobal).nativePagingFixture.records()); }
async function reads(app: ElectronApplication) { return (await records(app)).display; }
async function frames(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
async function viewportRows(page: Page) {
  return page.locator('.chat-scroll').evaluate(element => {
    const viewport = element.getBoundingClientRect();
    return Array.from(element.querySelectorAll<HTMLElement>('[data-virtual-message-id]')).filter(row => {
      const bounds = row.getBoundingClientRect();
      return bounds.bottom > viewport.top + element.clientTop && bounds.top < viewport.top + element.clientTop + element.clientHeight;
    }).map(row => row.dataset.virtualMessageId!);
  });
}

async function attachEvidence(app: ElectronApplication, page: Page, name: string) {
  const ipc = await records(app);
  const actualViewportRows = await viewportRows(page);
  const scroll = await page.locator('.chat-scroll').evaluate(element => ({ top: element.scrollTop, height: element.clientHeight, scrollHeight: element.scrollHeight }));
  const ui = await page.locator('.chat-pane').evaluate(element => ({ sessionId: (element as HTMLElement).dataset.sessionId,
    messageCount: element.querySelector('[data-virtual-chat-list]')?.getAttribute('data-message-count'),
    mounted: Array.from(element.querySelectorAll<HTMLElement>('[data-message-id]')).map(row => row.dataset.messageId),
    error: element.querySelector('.chat-error')?.textContent }));
  const metrics = test.info().outputPath(name + '.json');
  const window = await windowGeometry(app, page);
  await fs.writeFile(metrics, JSON.stringify({ ipc, ui, viewportRows: actualViewportRows, scroll, window, offlineLedger: true, externalModelCalls: 0 }, null, 2));
  await test.info().attach(name + '.json', { path: metrics, contentType: 'application/json' });
  const screenshot = test.info().outputPath(name + '.png');
  await page.screenshot({ path: screenshot });
  await test.info().attach(name + '.png', { path: screenshot, contentType: 'image/png' });
}

test('native paging: an underfilled saved page loads older records automatically and explicitly reaches the beginning', async () => {
  const f = await workspace();
  try {
    const a = f.sessions[0];
    expect(a.firstDisplayCount).toBe(8);
    await select(f.page, a);
    // No scroll or button input occurs before these assertions.
    await expect.poll(() => count(f.page)).toBeGreaterThan(a.firstDisplayCount);
    await expect.poll(async () => (await reads(f.app)).some(read => read.id === a.session.id && !!read.before && (read.count ?? 0) > 0)).toBe(true);
    const first = (await reads(f.app)).find(read => read.id === a.session.id && !read.before && !read.after)!;
    expect(first.count).toBe(8); expect(first.bytes).toBeLessThanOrEqual(256 * 1024);
    const beginning = f.page.getByText('已到本地保留记录的开头。', { exact: true });
    for (let attempt = 0; attempt < 4 && !await beginning.isVisible(); attempt++) {
      const earlier = f.page.getByRole('button', { name: '查看更早消息', exact: true });
      await expect(earlier).toBeEnabled(); await earlier.click();
      await expect(f.page.getByRole('button', { name: '读取中…', exact: true })).toHaveCount(0);
    }
    await expect(beginning).toBeVisible();
    expect(await count(f.page)).toBe(a.total);
    await expect(f.page.getByRole('button', { name: '查看更早消息', exact: true })).toHaveCount(0);
    await expect(f.page.locator('.chat-pane .chat-error')).toHaveCount(0);
    await f.page.locator('.chat-scroll').evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
    await expect.poll(() => viewportRows(f.page)).toContain(a.runId + ':user');
    expect((await viewportRows(f.page))[0]).toBe(a.runId + ':user');
    await f.page.locator('.chat-scroll').evaluate(element => { element.scrollTop = (element.scrollHeight - element.clientHeight) / 2; element.dispatchEvent(new Event('scroll')); });
    await expect.poll(async () => (await viewportRows(f.page)).length).toBeGreaterThan(0);
    await expect.poll(async () => (await viewportRows(f.page))[0]).toMatch(new RegExp('^' + a.runId + ':tool:fixture-tool-\\d+$'));
    expect(await f.page.locator('.chat-pane [data-message-id]').count()).toBeLessThanOrEqual(60);
    await attachEvidence(f.app, f.page, 'native-underfilled-autopaging');
  } catch (error) {
    await attachEvidence(f.app, f.page, 'native-underfilled-failure').catch(() => {});
    throw error;
  } finally { await f.close(); }
});

test('native paging: a temporary unavailable file retains history and retry; clipped history advances toward live replies without crossing sessions', async () => {
  test.setTimeout(90_000);
  const f = await workspace(true);
  const [a, b] = f.sessions;
  const journal = path.join(f.data, 'chat', b.session.id + '.jsonl'), moved = journal + '.paging-test-held';
  let isolated = false;
  try {
    await select(f.page, b);
    await expect.poll(() => count(f.page)).toBeGreaterThan(b.firstDisplayCount);
    // Restore an archived reading anchor through a genuine session switch before fault injection.
    await select(f.page, a);
    await expect.poll(() => count(f.page)).toBeGreaterThan(0);
    await select(f.page, b);
    await expect.poll(async () => (await reads(f.app)).some(read => read.id === b.session.id && !!read.around)).toBe(true);
    const earlier = f.page.getByRole('button', { name: '查看更早消息', exact: true });
    await expect(earlier).toBeEnabled();
    const retained = await count(f.page);
    const digest = createHash('sha256').update(await fs.readFile(journal)).digest('hex');
    await fs.rename(journal, moved); isolated = true;
    try {
      await earlier.click();
      await expect(f.page.locator('.chat-pane .chat-error')).toContainText(/会话记录正在更新|部分会话记录暂时无法读取/);
      expect(await count(f.page)).toBe(retained);
      await expect(earlier).toBeEnabled();
      await expect(f.page.getByText('已到本地保留记录的开头。', { exact: true })).toHaveCount(0);
      await attachEvidence(f.app, f.page, 'native-unavailable-page-preserved');
    } finally { await fs.rename(moved, journal); isolated = false; }
    expect(createHash('sha256').update(await fs.readFile(journal)).digest('hex')).toBe(digest);
    await f.page.getByRole('button', { name: '重试读取记录', exact: true }).click();
    await expect.poll(() => count(f.page)).toBeGreaterThan(retained);
    await expect(f.page.locator('.chat-pane .chat-error')).toHaveCount(0);

    const beginning = f.page.getByText('已到本地保留记录的开头。', { exact: true });
    for (let attempt = 0; attempt < 6 && !await beginning.isVisible(); attempt++) {
      await expect(earlier).toBeEnabled(); await earlier.click();
      await expect(f.page.getByRole('button', { name: '读取中…', exact: true })).toHaveCount(0);
    }
    await expect(beginning).toBeVisible();
    expect(await count(f.page)).toBeLessThan(b.total);
    const later = f.page.getByRole('button', { name: '查看较新消息', exact: true });
    await expect(later).toBeEnabled();
    await expect(f.page.locator(`[data-message-id="${b.finalId}"]`)).toHaveCount(0);

    const marker = 'PAGING_LEGAL_LOCAL_UPDATE_AFTER_CLIPPED_HISTORY';
    const addedId = await appendNativePagingTurn(f.data, b.session, marker);
    // This real snapshot discovers the new ledger head and emits the production changed notification.
    const authorityContainsReply = await f.page.evaluate(async ({ id, marker }) => (await window.desktop.chatSnapshot(id)).messages.some(message => message.text === marker), { id: b.session.id, marker });
    expect(authorityContainsReply).toBe(true);
    await expect(f.page.getByText('有较新的消息', { exact: true })).toBeVisible();
    await expect(f.page.locator(`[data-message-id="${addedId}"]`)).toHaveCount(0);
    await expect(f.page.getByRole('button', { name: '跳到最新消息', exact: true })).toBeVisible();

    await later.click();
    await expect.poll(async () => (await reads(f.app)).filter(read => read.id === b.session.id && !!read.after && (read.count ?? 0) > 0).length).toBeGreaterThanOrEqual(1);
    await expect(f.page.getByRole('button', { name: '读取中…', exact: true })).toHaveCount(0);
    // Explicit latest navigation must mount its destination before scrolling, even after an old anchor was trimmed.
    const jumpAfterPaging = f.page.getByRole('button', { name: '跳到最新消息', exact: true });
    await expect(jumpAfterPaging).toBeVisible();
    await f.page.locator('.chat-scroll').evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
    await expect.poll(async () => (await viewportRows(f.page)).length).toBeGreaterThan(0);
    await jumpAfterPaging.click();
    await expect(f.page.locator(`[data-message-id="${addedId}"]`)).toBeInViewport();
    await expect.poll(() => viewportRows(f.page)).toContain(addedId);
    // A newer page retains the reading anchor. Moving to its actual bottom exercises the after-scroll path.
    for (let attempt = 0; attempt < 6 && !await f.page.locator(`[data-message-id="${addedId}"]`).isVisible(); attempt++) {
      await f.page.locator('.chat-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')); });
      await frames(f.page);
      if (await later.isVisible()) { await expect(later).toBeEnabled(); await later.click(); }
      await expect(f.page.getByRole('button', { name: '读取中…', exact: true })).toHaveCount(0);
    }
    await f.page.locator('.chat-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')); });
    await expect(f.page.locator(`[data-message-id="${addedId}"]`)).toBeVisible();
    await expect(f.page.locator(`[data-message-id="${addedId}"]`)).toContainText(marker);
    await expect(f.page.locator('.chat-pane .chat-error')).toHaveCount(0);
    expect(await f.page.locator('.chat-pane [data-message-id]').count()).toBeLessThanOrEqual(60);
    await attachEvidence(f.app, f.page, 'native-newer-page-live-update');

    // Detach the bounded window again, then deliver a real after page after the user leaves.
    for (let attempt = 0; attempt < 6 && !await later.isVisible(); attempt++) {
      await expect(earlier).toBeEnabled(); await earlier.click();
      await expect(f.page.getByRole('button', { name: '读取中…', exact: true })).toHaveCount(0);
    }
    await expect(later).toBeEnabled();
    await f.app.evaluate((_, id) => (globalThis as FixtureGlobal).nativePagingFixture.holdAfter(id), b.session.id);
    await later.click();
    await expect.poll(() => f.app.evaluate(() => (globalThis as FixtureGlobal).nativePagingFixture.entered())).toBe(true);
    await select(f.page, a);
    await expect.poll(() => count(f.page)).toBeGreaterThan(0);
    await f.app.evaluate(() => (globalThis as FixtureGlobal).nativePagingFixture.release());
    await frames(f.page);
    expect(await f.page.locator('.chat-pane [data-message-id]').evaluateAll((rows, prefix) => rows.every(row => (row as HTMLElement).dataset.messageId?.startsWith(prefix)), a.runId)).toBe(true);
    await expect(f.page.getByText(marker, { exact: true })).toHaveCount(0);
    await select(f.page, b);
    const latest = f.page.getByRole('button', { name: '跳到最新消息', exact: true });
    if (await latest.isVisible()) await latest.click();
    await f.page.locator('.chat-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')); });
    await expect(f.page.locator(`[data-message-id="${addedId}"]`)).toBeVisible();
    expect(await f.page.locator('.chat-pane [data-message-id]').evaluateAll((rows, prefix) => rows.every(row => !(row as HTMLElement).dataset.messageId?.startsWith(prefix)), a.runId)).toBe(true);
    await attachEvidence(f.app, f.page, 'native-session-paging-isolation');
  } catch (error) {
    await attachEvidence(f.app, f.page, 'native-paging-failure').catch(() => {});
    throw error;
  } finally {
    try { if (isolated) await fs.rename(moved, journal); }
    finally { await f.close(); }
  }
});

test('native paging: two snapshot failures preserve saved display and recover passively without a manual retry', async () => {
  const f = await workspace();
  try {
    const a = f.sessions[0];
    await select(f.page, a);
    await expect.poll(() => count(f.page)).toBeGreaterThan(0);
    await expect.poll(async () => (await records(f.app)).snapshotAttempts[a.session.id] ?? 0).toBeGreaterThan(0);
    await expect(f.page.locator('.chat-model')).toHaveText('offline-paging-fixture');
    await expect(f.page.locator('.chat-pane .chat-error')).toHaveCount(0);
    await frames(f.page);
    const baseline = (await records(f.app)).snapshotAttempts[a.session.id];
    await f.app.evaluate((_, id) => (globalThis as FixtureGlobal).nativePagingFixture.failSnapshots(id, 2), a.session.id);
    // Exercise the production focus-refresh handler after a valid snapshot exists.
    await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(f.page.locator('.chat-pane .chat-error')).toContainText('状态未知，显示的是上次读取的记录。');
    await expect.poll(async () => (await records(f.app)).snapshotAttempts[a.session.id] ?? 0, { timeout: 8_000 }).toBe(baseline + 2);
    await expect(f.page.locator('.chat-pane .chat-error')).toContainText('PAGING_TRANSIENT_SNAPSHOT_UNAVAILABLE');
    expect(await count(f.page)).toBeGreaterThan(0);
    // First failure waits 5s, the second waits 15s. This assertion never clicks a retry control.
    await expect.poll(async () => (await records(f.app)).snapshotAttempts[a.session.id] ?? 0, { timeout: 18_000 }).toBeGreaterThanOrEqual(baseline + 3);
    await expect(f.page.locator('.chat-pane .chat-error')).toHaveCount(0);
    expect(await count(f.page)).toBeGreaterThan(0);
    await attachEvidence(f.app, f.page, 'native-snapshot-passive-recovery');
  } finally { await f.close(); }
});
