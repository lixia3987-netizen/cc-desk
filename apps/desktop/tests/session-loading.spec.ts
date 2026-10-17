import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import type { IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppState, Session } from '../src/shared/types';
import type { ChatMessage, ChatPage, ChatSnapshot } from '../src/shared/chat';
import { desktopRoot } from './helpers/paths';
import { electronLaunchArgs } from './helpers/electron-launch';
import { closeNativeApp } from './helpers/native-app-cleanup';
import { sessionAction, sessionRow } from './helpers/session-ui';

interface DisplayRead { id: string; before?: string; around?: string; bytes: number; count: number; first?: string; last?: string }
interface LoadingFixture {
  hold(id: string): void;
  entered(id: string): boolean;
  release(id: string, value?: ChatSnapshot): void;
  holdDisplay(id: string): void;
  displayEntered(): boolean;
  releaseDisplay(): void;
  holdDelete(): void;
  deleteEntered(): boolean;
  rejectDelete(message: string): void;
  records(): { snapshots: Record<string, number>; display: DisplayRead[] };
  dispose(): void;
}
type FixtureGlobal = typeof globalThis & { sessionLoadingFixture: LoadingFixture };
interface LoadingObservation {
  targetId: string; prefix: string; expectCache: boolean;
  loadingSeen: boolean; emptySeen: boolean; cachedBlankSeen: boolean; staleSeen: boolean;
}
type ObservedWindow = Window & { loadingObservation?: LoadingObservation; loadingObserver?: MutationObserver };
const lateText = 'LATE_SNAPSHOT_MUST_NOT_POLLUTE_ANOTHER_SESSION';

async function workspace(large = false) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cc-desk-session-loading-')));
  const data = path.join(directory, 'data'), projectPath = path.join(directory, 'project');
  await fs.mkdir(projectPath); await fs.mkdir(path.join(data, 'chat'), { recursive: true });
  const now = new Date().toISOString(), projectId = randomUUID();
  const sessions: Session[] = ['加载会话 A', '加载会话 B'].map(title => ({
    id: randomUUID(), projectId, title, titleSource: 'manual', kind: 'agent', cwd: projectPath,
    execution: { providerId: 'claude', mode: 'structured', conversationId: randomUUID() }, started: false,
    engineConfig: { schemaVersion: 1, options: { model: '', effort: 'default', permissionMode: 'default' } },
    status: 'idle', taskState: 'idle', draft: '', archived: false, createdAt: now, updatedAt: now,
  }));
  const messages: Record<string, ChatMessage[]> = {}, sourceBytes: Record<string, number> = {};
  for (const [sessionIndex, session] of sessions.entries()) {
    const prefix = sessionIndex ? 'b' : 'a', long = large && sessionIndex === 1;
    messages[session.id] = Array.from({ length: long ? 240 : 2 }, (_, index): ChatMessage => {
      const base = { id: prefix + '-saved-' + index, turnId: 'saved-' + index, createdAt: now };
      if (long && index % 10 === 9) {
        const fence = String.fromCharCode(96).repeat(3);
        return { ...base, role: 'tool', toolName: 'retained_tool_' + index,
          input: { query: 'INPUT_NOT_MOUNTED_' + index, detail: 'x'.repeat(2048) },
          text: 'LAZY_TOOL_BODY_' + index + '\n\n' + fence + 'typescript\n' + 'const retained = "saved output";\n'.repeat(260) + fence };
      }
      return { ...base, role: index % 2 ? 'assistant' : 'user', text: session.title + '保存消息 ' + index + '\n\n' + (long && index === 20 ? 'UNMOUNTED_SEARCH_TARGET_20\n\n' : '') +
        (long ? 'Saved evidence remains readable without hydrating an execution. '.repeat(34) : '') };
    });
    const journal = messages[session.id].map(message => JSON.stringify({ at: now, type: 'message', conversationId: session.execution.conversationId, message }) + '\n').join('');
    const snapshot: ChatSnapshot = { sessionId: session.id, taskState: 'idle', pending: [], messages: messages[session.id] };
    const saved = JSON.stringify({ ...snapshot, projectionVersion: 1, journalCursor: Buffer.byteLength(journal) });
    sourceBytes[session.id] = Buffer.byteLength(journal);
    await fs.writeFile(path.join(data, 'chat', session.id + '.json'), saved);
    await fs.writeFile(path.join(data, 'chat', session.id + '.jsonl'), journal);
  }
  // Start on the welcome page so the gate is installed before the first read of either conversation.
  const state: AppState = { version: 3, projects: [{ id: projectId, name: '加载项目', path: projectPath, createdAt: now }], sessions,
    settings: { engineDefaults: {}, claudePath: path.join(directory, 'unavailable-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000 } };
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify(state));
  const app = await electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot,
    env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data } });
  const page = await app.firstWindow();
  await expect(page.locator('main.workspace')).toBeVisible();
  await app.evaluate(({ ipcMain }) => {
    type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, Handler> })._invokeHandlers;
    if (!(handlers instanceof Map)) throw new Error('Electron IPC invoke handler interception is unavailable');
    const snapshot = handlers.get('chat:snapshot'), display = handlers.get('chat:display'), remove = handlers.get('session:delete');
    if (!snapshot || !display || !remove) throw new Error('Expected the real snapshot, display and deletion IPC handlers');
    const gates = new Map<string, { entered: boolean; promise: Promise<ChatSnapshot | undefined>; resolve(value?: ChatSnapshot): void; reject(error: Error): void }>();
    interface VoidGate { entered: boolean; promise: Promise<void>; resolve(): void; reject(error: Error): void }
    let displayGate: (VoidGate & { id: string }) | undefined, deletion: VoidGate | undefined;
    const voidGate = (): VoidGate => {
      let resolve!: () => void, reject!: (error: Error) => void;
      const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      void promise.catch(() => {});
      return { entered: false, promise, resolve, reject };
    };
    const snapshots: Record<string, number> = {}, reads: DisplayRead[] = [];
    ipcMain.removeHandler('chat:snapshot');
    ipcMain.handle('chat:snapshot', async (event, id: string) => {
      snapshots[id] = (snapshots[id] ?? 0) + 1;
      const gate = gates.get(id);
      if (gate) {
        gate.entered = true;
        const value = await gate.promise;
        if (value) return value;
      }
      // Hold before the real handler, hence before hydrate; no synthetic display response is installed.
      return snapshot(event, id);
    });
    ipcMain.removeHandler('chat:display');
    ipcMain.handle('chat:display', async (event, input: { id: string; before?: string; around?: string }) => {
      const value = await display(event, input) as ChatPage;
      reads.push({ id: input.id, before: input.before, around: input.around, bytes: Buffer.byteLength(JSON.stringify(value)), count: value.messages.length,
        first: value.messages[0]?.id, last: value.messages.at(-1)?.id });
      // Only the lifecycle case delays delivery of a real display result; no page is fabricated.
      if (displayGate?.id === input.id && !displayGate.entered) { displayGate.entered = true; await displayGate.promise; }
      return value;
    });
    ipcMain.removeHandler('session:delete');
    ipcMain.handle('session:delete', async (event, input: unknown) => {
      // A deliberate fixture failure occurs before the real deletion mutates disk or workspace state.
      if (deletion && !deletion.entered) { deletion.entered = true; await deletion.promise; }
      return remove(event, input);
    });
    (globalThis as FixtureGlobal).sessionLoadingFixture = {
      hold: id => {
        if (gates.has(id)) throw new Error('A snapshot gate is already armed for ' + id);
        let resolve!: (value?: ChatSnapshot) => void, reject!: (error: Error) => void;
        const promise = new Promise<ChatSnapshot | undefined>((yes, no) => { resolve = yes; reject = no; });
        // A gate may be disposed before the delayed status reader reaches it.
        void promise.catch(() => {});
        gates.set(id, { entered: false, promise, resolve, reject });
      },
      entered: id => !!gates.get(id)?.entered,
      release: (id, value) => { const gate = gates.get(id); if (!gate?.entered) throw new Error('No snapshot reached this gate'); gates.delete(id); gate.resolve(value); },
      holdDisplay: id => { if (displayGate) throw new Error('A display gate is already armed'); displayGate = { ...voidGate(), id }; },
      displayEntered: () => !!displayGate?.entered,
      releaseDisplay: () => { const gate = displayGate; if (!gate?.entered) throw new Error('No real display result reached this gate'); displayGate = undefined; gate.resolve(); },
      holdDelete: () => { if (deletion) throw new Error('A deletion gate is already armed'); deletion = voidGate(); },
      deleteEntered: () => !!deletion?.entered,
      rejectDelete: message => { const gate = deletion; if (!gate?.entered) throw new Error('No deletion reached this gate'); deletion = undefined; gate.reject(new Error(message)); },
      records: () => ({ snapshots: { ...snapshots }, display: [...reads] }),
      dispose: () => { for (const gate of gates.values()) gate.reject(new Error('fixture disposed')); gates.clear(); displayGate?.reject(new Error('fixture disposed')); deletion?.reject(new Error('fixture disposed')); },
    };
  });
  return { app, page, sessions, messages, sourceBytes, close: async () => {
    await app.evaluate(() => (globalThis as FixtureGlobal).sessionLoadingFixture.dispose()).catch(() => {});
    try { await closeNativeApp(app); }
    finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  } };
}

async function hold(app: ElectronApplication, id: string) {
  await app.evaluate((_, id) => (globalThis as FixtureGlobal).sessionLoadingFixture.hold(id), id);
}

async function select(page: Page, app: ElectronApplication, session: Session) {
  await sessionRow(page, session.title).click();
  await expect(page.getByRole('heading', { name: session.title, exact: true })).toBeVisible();
  await expect.poll(() => app.evaluate((_, id) => (globalThis as FixtureGlobal).sessionLoadingFixture.entered(id), session.id)).toBe(true);
}

async function observe(page: Page, targetId: string, prefix: string, expectCache = false) {
  await page.evaluate(({ targetId, prefix, expectCache, lateText }) => {
    const scope = window as ObservedWindow;
    scope.loadingObserver?.disconnect();
    const result: LoadingObservation = { targetId, prefix, expectCache, loadingSeen: false, emptySeen: false, cachedBlankSeen: false, staleSeen: false };
    scope.loadingObservation = result;
    const inspect = () => {
      const pane = document.querySelector<HTMLElement>('.chat-pane');
      if (pane?.dataset.sessionId !== targetId) return;
      result.loadingSeen ||= Array.from(pane.querySelectorAll('[role="status"]')).some(element => element.textContent?.includes('正在读取会话记录'));
      result.emptySeen ||= !!pane.querySelector('.chat-empty');
      result.cachedBlankSeen ||= expectCache && !Array.from(pane.querySelectorAll<HTMLElement>('[data-message-id]')).some(element => element.dataset.messageId?.startsWith(prefix));
      result.staleSeen ||= !!pane.textContent?.includes(lateText);
    };
    scope.loadingObserver = new MutationObserver(inspect);
    scope.loadingObserver.observe(document.body, { childList: true, subtree: true, attributes: true });
    inspect();
  }, { targetId, prefix, expectCache, lateText });
}

async function observation(page: Page) { return page.evaluate(() => (window as ObservedWindow).loadingObservation!); }

async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function attachMetrics(app: ElectronApplication, page: Page, sourceBytes: Record<string, number>) {
  const ipc = await app.evaluate(() => (globalThis as FixtureGlobal).sessionLoadingFixture.records());
  const dom = await page.evaluate(() => ({ mountedMessageRows: document.querySelectorAll('.chat-pane [data-message-id]').length,
    markdownBodies: document.querySelectorAll('.chat-pane .message-markdown').length, toolBodies: document.querySelectorAll('.chat-pane details .message-markdown').length }));
  const file = test.info().outputPath('session-loading-metrics.json');
  await fs.writeFile(file, JSON.stringify({ sourceJournalBytes: sourceBytes, ipc, dom }, null, 2));
  await test.info().attach('session-loading-metrics.json', { path: file, contentType: 'application/json' });
}

test('session loading: persisted display precedes held hydrate, loading never flashes empty and payload and DOM stay bounded', async () => {
  const f = await workspace(true);
  try {
    const [a, b] = f.sessions;
    await hold(f.app, a.id); await select(f.page, f.app, a);
    await expect(f.page.locator('[data-message-id="a-saved-1"]')).toContainText(a.title + '保存消息 1');
    await hold(f.app, b.id); await observe(f.page, b.id, 'b-saved-');
    await select(f.page, f.app, b);
    await expect(f.page.locator('[data-message-id="b-saved-239"]')).toBeVisible();
    expect((await observation(f.page)).loadingSeen).toBe(true);
    expect((await observation(f.page)).emptySeen).toBe(false);
    const records = await f.app.evaluate(() => (globalThis as FixtureGlobal).sessionLoadingFixture.records());
    expect(records.snapshots[b.id]).toBe(1);
    const first = records.display.find(read => read.id === b.id && !read.before)!;
    expect(first).toBeTruthy(); expect(first.count).toBeGreaterThan(0); expect(first.count).toBeLessThanOrEqual(50);
    expect(first.bytes).toBeLessThanOrEqual(256 * 1024); expect(first.bytes).toBeLessThan(f.sourceBytes[b.id] / 2);
    expect(await f.page.locator('.chat-pane [data-message-id]').count()).toBeLessThanOrEqual(60);
    await expect(f.page.locator('[data-message-id="b-saved-0"]')).toHaveCount(0);
    await attachMetrics(f.app, f.page, f.sourceBytes);
  } finally { await f.close(); }
});

test('session loading: cached switches retain saved messages and late snapshots cannot contaminate either conversation', async () => {
  const f = await workspace();
  try {
    const [a, b] = f.sessions;
    await hold(f.app, a.id); await hold(f.app, b.id);
    await select(f.page, f.app, a); await expect(f.page.locator('[data-message-id="a-saved-1"]')).toContainText(a.title + '保存消息 1');
    await select(f.page, f.app, b); await expect(f.page.locator('[data-message-id="b-saved-1"]')).toContainText(b.title + '保存消息 1');
    await observe(f.page, a.id, 'a-saved-', true); await select(f.page, f.app, a);
    const stale: ChatSnapshot = { sessionId: b.id, taskState: 'idle', pending: [], messages: [
      { id: 'b-late', turnId: 'late', role: 'assistant', text: lateText, createdAt: new Date().toISOString() },
    ] };
    await f.app.evaluate((_, { id, value }) => (globalThis as FixtureGlobal).sessionLoadingFixture.release(id, value), { id: b.id, value: stale });
    await frames(f.page);
    expect(await observation(f.page)).toMatchObject({ cachedBlankSeen: false, emptySeen: false, staleSeen: false });
    await expect(f.page.locator('[data-message-id="a-saved-1"]')).toContainText(a.title + '保存消息 1');
    await hold(f.app, b.id); await observe(f.page, b.id, 'b-saved-', true); await select(f.page, f.app, b); await frames(f.page);
    expect(await observation(f.page)).toMatchObject({ cachedBlankSeen: false, emptySeen: false, staleSeen: false });
    await expect(f.page.locator('[data-message-id="b-saved-1"]')).toContainText(b.title + '保存消息 1');
    await expect(f.page.getByText(lateText, { exact: true })).toHaveCount(0);
    await expect(f.page.locator('.error-banner')).toHaveCount(0);
    await attachMetrics(f.app, f.page, f.sourceBytes);
  } finally { await f.close(); }
});

test('session loading: collapsed tools mount neither markdown nor input until the first expansion', async () => {
  const f = await workspace(true);
  try {
    const b = f.sessions[1]; await hold(f.app, b.id); await select(f.page, f.app, b);
    const tool = f.page.locator('details[data-message-id="b-saved-239"]');
    await expect(tool).toBeVisible(); expect(await tool.evaluate(element => (element as HTMLDetailsElement).open)).toBe(false);
    await expect(tool.locator('.message-markdown')).toHaveCount(0); await expect(tool.locator('.tool-input')).toHaveCount(0);
    await tool.locator('summary').click();
    await expect(tool.locator('.message-markdown')).toBeVisible(); await expect(tool.locator('.message-markdown')).toContainText('LAZY_TOOL_BODY_239');
    await expect(tool.locator('.tool-input')).toContainText('INPUT_NOT_MOUNTED_239');
    await attachMetrics(f.app, f.page, f.sourceBytes);
  } finally { await f.close(); }
});

test('session loading: prepend preserves the visible anchor and search mounts an offscreen target with bounded rows', async () => {
  const f = await workspace(true);
  try {
    const b = f.sessions[1]; await hold(f.app, b.id); await select(f.page, f.app, b);
    const list = f.page.locator('[data-virtual-chat-list]');
    await expect(list).toHaveAttribute('data-message-count', '50');
    await f.page.locator('.chat-scroll').evaluate(element => { element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 240); element.dispatchEvent(new Event('scroll')); });
    await frames(f.page);
    const anchor = await f.page.locator('.chat-scroll').evaluate(element => {
      const top = element.getBoundingClientRect().top;
      const row = Array.from(element.querySelectorAll<HTMLElement>('[data-message-id]')).find(item => item.getBoundingClientRect().bottom > top + 8);
      if (!row) throw new Error('Expected a visible retained message anchor');
      return { id: row.dataset.messageId!, offset: row.getBoundingClientRect().top - top };
    });
    await f.page.getByRole('button', { name: '查看更早消息', exact: true }).click();
    await expect.poll(async () => Number(await list.getAttribute('data-message-count'))).toBeGreaterThan(50);
    await expect.poll(() => f.page.locator('.chat-scroll').evaluate((element, anchor) => {
      const row = Array.from(element.querySelectorAll<HTMLElement>('[data-message-id]')).find(item => item.dataset.messageId === anchor.id);
      return row ? Math.abs(row.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset) : Infinity;
    }, anchor)).toBeLessThanOrEqual(2);
    expect(await f.page.locator('.chat-pane [data-message-id]').count()).toBeLessThanOrEqual(60);
    const records = await f.app.evaluate(() => (globalThis as FixtureGlobal).sessionLoadingFixture.records());
    expect(records.display.some(read => read.id === b.id && !!read.before && read.count > 0)).toBe(true);
    await expect(f.page.locator('[data-message-id="b-saved-20"]')).toHaveCount(0);
    await f.page.getByRole('button', { name: '查找消息', exact: true }).click();
    const search = f.page.getByRole('dialog', { name: '会话内查找', exact: true });
    await search.getByRole('textbox', { name: '查找消息内容', exact: true }).fill('UNMOUNTED_SEARCH_TARGET_20');
    await expect(search.locator('.chat-search-results button')).toHaveCount(1);
    await search.locator('.chat-search-results button').click();
    await expect(search).toHaveCount(0);
    await expect(f.page.locator('[data-message-id="b-saved-20"]')).toBeInViewport();
    await expect(f.page.locator('[data-message-id="b-saved-20"]')).toContainText('UNMOUNTED_SEARCH_TARGET_20');
    expect(await f.page.locator('.chat-pane [data-message-id]').count()).toBeLessThanOrEqual(60);
    await attachMetrics(f.app, f.page, f.sourceBytes);
    // The target must survive the next measurement/redraw frames,
    // rather than only entering the viewport briefly.
    await frames(f.page);
    expect(await f.page.evaluate(() => {
      const target = document.querySelector<HTMLElement>('[data-message-id="b-saved-20"]');
      const scroll = document.querySelector<HTMLElement>('.chat-scroll');
      if (!target || !scroll) return false;
      const bounds = target.getBoundingClientRect(), viewport = scroll.getBoundingClientRect();
      return bounds.bottom > Math.max(0, viewport.top) && bounds.top < Math.min(innerHeight, viewport.bottom);
    })).toBe(true);
  } finally { await f.close(); }
});

test('session loading: a failed deletion invalidates the old display read and automatically resumes readable history and paging', async () => {
  const f = await workspace(true);
  try {
    const b = f.sessions[1];
    await hold(f.app, b.id);
    await f.app.evaluate((_, id) => (globalThis as FixtureGlobal).sessionLoadingFixture.holdDisplay(id), b.id);
    await select(f.page, f.app, b);
    await expect.poll(() => f.app.evaluate(() => (globalThis as FixtureGlobal).sessionLoadingFixture.displayEntered())).toBe(true);
    await expect(f.page.getByRole('status').filter({ hasText: '正在读取会话记录' })).toBeVisible();
    await expect(f.page.locator('.chat-pane [data-message-id]')).toHaveCount(0);
    await f.app.evaluate(() => (globalThis as FixtureGlobal).sessionLoadingFixture.holdDelete());
    await sessionAction(f.page, b.title, '删除会话');
    const deletion = f.page.getByRole('dialog', { name: '删除会话', exact: true });
    await deletion.getByRole('button', { name: '确认删除会话', exact: true }).click();
    await expect.poll(() => f.app.evaluate(() => (globalThis as FixtureGlobal).sessionLoadingFixture.deleteEntered())).toBe(true);

    await f.app.evaluate(() => (globalThis as FixtureGlobal).sessionLoadingFixture.releaseDisplay());
    await frames(f.page);
    // The real saved page arrived while deleting, so its old lifecycle generation must stay invisible.
    await expect(f.page.locator('.chat-pane [data-message-id]')).toHaveCount(0);
    expect((await f.app.evaluate(() => (globalThis as FixtureGlobal).sessionLoadingFixture.records())).display.filter(read => read.id === b.id)).toHaveLength(1);
    await f.app.evaluate(() => (globalThis as FixtureGlobal).sessionLoadingFixture.rejectDelete('测试：删除未执行，保留会话'));

    await expect.poll(async () => (await f.app.evaluate(() => (globalThis as FixtureGlobal).sessionLoadingFixture.records())).display.filter(read => read.id === b.id).length).toBe(2);
    await expect(f.page.locator('[data-message-id="b-saved-239"]')).toBeVisible();
    await expect(f.page.locator('.chat-history-loading')).toHaveCount(0);
    await expect(deletion.getByRole('alert')).toContainText('测试：删除未执行，保留会话');
    await deletion.getByRole('button', { name: '取消', exact: true }).click();
    await expect(deletion).toHaveCount(0);
    await expect(f.page.getByRole('heading', { name: b.title, exact: true })).toBeVisible();
    const earlier = f.page.getByRole('button', { name: '查看更早消息', exact: true });
    await expect(earlier).toBeEnabled(); await earlier.click();
    await expect.poll(async () => Number(await f.page.locator('[data-virtual-chat-list]').getAttribute('data-message-count'))).toBeGreaterThan(50);
    await expect(earlier).toBeEnabled();
    expect((await f.page.evaluate(() => window.desktop.snapshot())).state.sessions.some(session => session.id === b.id)).toBe(true);
    await attachMetrics(f.app, f.page, f.sourceBytes);
  } finally { await f.close(); }
});
