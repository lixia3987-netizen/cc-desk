import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import type { Session } from '../src/shared/types';
import { desktopRoot } from './helpers/paths';
import { electronLaunchArgs } from './helpers/electron-launch';
import { closeNativeApp } from './helpers/native-app-cleanup';
// @ts-expect-error The executable HTTP/SSE fixture is shared with agent-node tests.
import { assistantMessage, functionCall, startResponsesFixture } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

interface Fixture { baseURL: string; requests: Array<Record<string, unknown>>; errors: unknown[]; close(): Promise<void> }
interface RequestBody { input: Array<Record<string, unknown>>; tools: unknown[] }
const credential = 'sk-native-auto-compaction-local-fixture-only';
const firstGoal = 'AUTO_ORIGINAL_GOAL_保留此原始目标：只读取 fixture.txt，保持 UTF-8 和审批边界。';
const recentGoal = 'AUTO_RECENT_TURN_读取 fixture.txt，保留完整工具调用与返回。';
const nextGoal = 'AUTO_NEXT_TASK_沿用历史继续，不重复先前操作。';
const summaryText = 'AUTO_COMPACTED_HISTORY_前两轮分析已完成，文件没有改动；后续仍遵守最初约束。';
// Three completed turns exceed 90% of a 50,000-byte input budget. The first
// two turns still fit in one summary request, and the last complete turn fits
// comfortably alongside the summary and the next instruction.
const longAnswer = (turn: number) => `AUTO_ORIGINAL_ANSWER_${turn}\n${'x'.repeat(16_000)}`;

async function workspace() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-native-auto-压缩 空格-'));
  const data = path.join(directory, '应用 数据'), cwd = path.join(directory, '项目 空格');
  await fs.mkdir(data); await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, 'fixture.txt'), 'auto-fixture-original\n');
  const projectId = randomUUID();
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify({ version: 3, projects: [
    { id: projectId, name: '自动上下文维护项目', path: cwd, createdAt: new Date().toISOString() },
  ], sessions: [], settings: { claudePath: path.join(directory, 'missing-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000, engineDefaults: {} } }));
  return { directory, data, cwd, projectId,
    launch: () => electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot, env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data } }),
    dispose: () => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}
async function ready(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  await expect(page.locator('main.workspace')).toBeVisible();
  return page;
}
async function configure(page: Page, projectId: string, baseURL: string): Promise<Session> {
  return page.evaluate(async ({ projectId, baseURL, credential }) => {
    let connection = await window.desktop.nativeConnections.upsert({ name: '自动压缩 HTTP fixture', protocol: 'responses', baseURL, model: 'auto-compaction-fixture', allowLoopbackHttp: true, enabled: true, auth: { mode: 'memory' } });
    connection = await window.desktop.nativeConnections.setCredential({ id: connection.id, revision: connection.revision, mode: 'memory', secret: credential });
    const session = await window.desktop.createSession({ projectId, title: 'Native 发送前自动压缩', kind: 'agent', providerId: 'native', mode: 'structured', isolated: false,
      engineConfig: { schemaVersion: 1, options: { connectionId: connection.id, model: '' } } });
    await window.desktop.setSelection(session.id);
    return session;
  }, { projectId, baseURL, credential });
}
async function restoreCredential(page: Page) {
  await page.evaluate(async credential => {
    const connection = (await window.desktop.nativeConnections.list()).connections[0];
    await window.desktop.nativeConnections.setCredential({ id: connection.id, revision: connection.revision, mode: 'memory', secret: credential });
  }, credential);
}
async function send(page: Page, sessionId: string, text: string) {
  const result = await page.evaluate(({ sessionId, text }) => window.desktop.sendChat(sessionId, text), { sessionId, text });
  expect(result.success, result.error).toBe(true);
  return result;
}
async function seedHistory(page: Page, sessionId: string) {
  await expect(page.getByLabel('会话自动压缩', { exact: true })).toHaveValue('off');
  await send(page, sessionId, firstGoal);
  await send(page, sessionId, 'AUTO_MIDDLE_TURN_继续分析，并保留原始约束。');
  await send(page, sessionId, recentGoal);
}
async function saveAutomaticCompaction(page: Page, sessionId: string, enabled: boolean) {
  const value = enabled ? 'before_send' : 'off', maxInputTokens = enabled ? 50_000 : 64_000;
  await page.getByLabel('会话自动压缩', { exact: true }).selectOption(value);
  await page.getByLabel('会话输入预算（估算 tokens）', { exact: true }).fill(String(maxInputTokens));
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect.poll(() => page.evaluate(async id => {
    const options = (await window.desktop.snapshot()).state.sessions.find(item => item.id === id)!.engineConfig.options;
    return { autoCompact: options.autoCompact, maxInputTokens: options.maxInputTokens };
  }, sessionId)).toEqual({ autoCompact: value, maxInputTokens });
}
async function noWorker(app: ElectronApplication) {
  await expect.poll(() => app.evaluate(({ app }) => app.getAppMetrics().some(metric => metric.serviceName === 'cc-desk native agent' || metric.name === 'cc-desk native agent'))).toBe(false);
}
function conversationResponse(body: RequestBody) {
  const users = body.input.filter(item => item.role === 'user'), latest = JSON.stringify(users.at(-1));
  const recentResult = body.input.find(item => item.type === 'function_call_output' && item.call_id === 'auto_recent_read');
  if (latest.includes('AUTO_RECENT_TURN_') && !recentResult) return { output: [functionCall('auto_recent_read', 'read_file', { path: 'fixture.txt' })] };
  return { output: [assistantMessage(`auto_turn_${users.length}`, latest.includes('AUTO_NEXT_') ? '自动维护后的任务完成。' : longAnswer(users.length))] };
}

test('native opt-in auto compaction persists UI settings and sends one summary before the next task with the goal and latest tool pair intact', async () => {
  const f = await workspace();
  const fixture: Fixture = await startResponsesFixture({ assertReplay: false, handler: ({ body }: { body: RequestBody }) =>
    body.tools.length === 0 ? { output: [assistantMessage('auto_summary', summaryText)] } : conversationResponse(body) });
  let app = await f.launch();
  try {
    let page = await ready(app), session = await configure(page, f.projectId, fixture.baseURL);
    await seedHistory(page, session.id);
    expect(fixture.requests).toHaveLength(4);
    expect(fixture.requests.every(request => (request.tools as unknown[]).length > 0)).toBe(true);
    const before = await page.evaluate(id => window.desktop.chatSnapshot(id), session.id);
    await saveAutomaticCompaction(page, session.id, true);
    // Enabling the option and relaunching never starts a request on their own.
    await closeNativeApp(app); app = await f.launch(); page = await ready(app);
    await page.evaluate(id => window.desktop.setSelection(id), session.id);
    await expect(page.getByLabel('会话自动压缩', { exact: true })).toHaveValue('before_send');
    await expect(page.getByLabel('会话输入预算（估算 tokens）', { exact: true })).toHaveValue('50000');
    await restoreCredential(page);
    expect(fixture.requests).toHaveLength(4);

    await send(page, session.id, nextGoal);
    expect(fixture.requests).toHaveLength(6);
    const summary = fixture.requests[4], task = fixture.requests[5];
    expect(summary.tools).toEqual([]);
    expect(JSON.stringify(summary.input)).toContain('AUTO_ORIGINAL_ANSWER_1');
    expect(JSON.stringify(summary.input)).not.toContain(recentGoal);
    expect(JSON.stringify(summary.input)).not.toContain(nextGoal);
    expect((task.tools as unknown[]).length).toBeGreaterThan(0);
    const input = task.input as Array<Record<string, unknown>>, serialized = JSON.stringify(input);
    expect(serialized).toContain(firstGoal);
    expect(serialized).toContain(summaryText);
    expect(serialized).toContain(recentGoal);
    expect(serialized).toContain(nextGoal);
    expect(serialized).toContain('AUTO_ORIGINAL_ANSWER_3');
    expect(serialized).not.toContain('AUTO_ORIGINAL_ANSWER_1');
    expect(serialized).not.toContain('AUTO_ORIGINAL_ANSWER_2');
    expect(input.filter(item => item.type === 'function_call' && item.call_id === 'auto_recent_read')).toHaveLength(1);
    expect(input.filter(item => item.type === 'function_call_output' && item.call_id === 'auto_recent_read')).toHaveLength(1);
    const after = await page.evaluate(id => window.desktop.chatSnapshot(id), session.id);
    expect(after.nativeContextMaintenance?.lastCompaction).toBeTruthy();
    expect(after.nativeContextMaintenance!.lastCompaction!.afterBytes).toBeLessThan(after.nativeContextMaintenance!.lastCompaction!.beforeBytes);
    for (const message of before.messages) expect(after.messages).toContainEqual(message);
    await expect(page.locator('.chat-message.assistant').last()).toContainText('自动维护后的任务完成');

    await closeNativeApp(app); app = await f.launch(); page = await ready(app);
    await page.evaluate(id => window.desktop.setSelection(id), session.id);
    const restored = await page.evaluate(id => window.desktop.chatSnapshot(id), session.id);
    expect(restored.nativeContextMaintenance?.lastCompaction).toEqual(after.nativeContextMaintenance?.lastCompaction);
    for (const message of before.messages) expect(restored.messages).toContainEqual(message);
    await restoreCredential(page);
    await send(page, session.id, 'AUTO_NEXT_RESTART_继续沿用已压缩上下文。');
    expect(fixture.requests).toHaveLength(7);
    expect(JSON.stringify(fixture.requests[6].input)).toContain(summaryText);
    expect(fixture.requests.filter(request => (request.tools as unknown[]).length === 0)).toHaveLength(1);
    expect(fixture.errors).toEqual([]);
  } finally { try { await closeNativeApp(app); await f.dispose(); } finally { await fixture.close(); } }
});

test('native cancelling an automatic summary keeps the queued message and original context across restart without sending the task', async () => {
  const f = await workspace();
  const fixture: Fixture = await startResponsesFixture({ assertReplay: false, handler: ({ body }: { body: RequestBody }) =>
    body.tools.length === 0 ? { hang: true } : conversationResponse(body) });
  let app = await f.launch();
  try {
    let page = await ready(app), session = await configure(page, f.projectId, fixture.baseURL);
    await seedHistory(page, session.id);
    await saveAutomaticCompaction(page, session.id, true);
    const before = await page.evaluate(id => window.desktop.chatSnapshot(id), session.id);
    const accepted = await page.evaluate(({ id, text }) => window.desktop.submitChat(id, text, [], 'auto-cancel-message'), { id: session.id, text: nextGoal });
    await expect.poll(() => fixture.requests.length).toBe(5);
    expect(fixture.requests[4].tools).toEqual([]);
    const meter = page.locator('details.context-meter');
    if (!(await meter.evaluate(element => (element as HTMLDetailsElement).open))) await meter.locator('summary').click();
    await expect(meter).toContainText('正在自动压缩，完成后继续本次发送');
    await expect(page.getByLabel('会话自动压缩', { exact: true })).toBeDisabled();
    await meter.getByRole('button', { name: '取消压缩', exact: true }).click();
    await expect.poll(() => page.evaluate(async id => {
      const snapshot = await window.desktop.chatSnapshot(id);
      return { compacting: !!snapshot.nativeContextMaintenance?.compacting, paused: snapshot.queue?.paused, items: snapshot.queue?.items.map(item => ({ id: item.id, text: item.text, status: item.status })) };
    }, session.id)).toEqual({ compacting: false, paused: true, items: [{ id: accepted.messageId, text: nextGoal, status: 'queued' }] });
    await noWorker(app);
    const cancelled = await page.evaluate(id => window.desktop.chatSnapshot(id), session.id);
    expect(cancelled.nativeContextMaintenance?.lastCompaction).toBeUndefined();
    expect(cancelled.messages).toHaveLength(before.messages.length + 1);
    expect(cancelled.messages.slice(0, before.messages.length)).toEqual(before.messages);
    expect(cancelled.messages.at(-1)).toMatchObject({ role: 'system', text: expect.stringContaining('发送前自动压缩未完成') });
    expect(cancelled.messages.at(-1)!.text).toContain('不会自动重复尝试');
    await expect(page.getByRole('region', { name: '待发送消息' })).toContainText('队列已暂停');
    await expect(page.getByRole('region', { name: '待发送消息' })).toContainText(nextGoal);
    expect(fixture.requests).toHaveLength(5);

    await closeNativeApp(app);
    const ledger = await NativeRunStore.open({ rootDirectory: path.join(f.data, 'native', 'conversations'), conversationId: session.execution.conversationId! });
    try {
      // The durable automatic-attempt receipt advances the journal head, while
      // all model protocol items remain exactly as they were before the send.
      expect(ledger.loadContext()!.items).toEqual([
        ...(fixture.requests[3].input as unknown[]), assistantMessage('auto_turn_3', longAnswer(3)),
      ]);
      expect(ledger.listRuns()).toHaveLength(3);
    } finally { await ledger.close(); }
    app = await f.launch(); page = await ready(app);
    await page.evaluate(id => window.desktop.setSelection(id), session.id);
    await restoreCredential(page);
    const restored = await page.evaluate(id => window.desktop.chatSnapshot(id), session.id);
    expect(restored.queue?.paused).toBe(true);
    expect(restored.queue?.items.map(item => ({ id: item.id, text: item.text, status: item.status }))).toEqual([{ id: accepted.messageId, text: nextGoal, status: 'queued' }]);
    expect(restored.nativeContextMaintenance?.headHash).toBe(cancelled.nativeContextMaintenance?.headHash);
    expect(restored.nativeContextMaintenance?.lastCompaction).toBeUndefined();
    expect(restored.messages).toEqual(cancelled.messages);
    await noWorker(app);
    expect(fixture.requests).toHaveLength(5);
    expect(fixture.errors).toEqual([]);
  } finally { try { await closeNativeApp(app); await f.dispose(); } finally { await fixture.close(); } }
});

test('native rejected automatic summary pauses the queue without losing the message and allows an explicit retry with automation disabled', async () => {
  const f = await workspace();
  const fixture: Fixture = await startResponsesFixture({ assertReplay: false, handler: ({ body }: { body: RequestBody }) =>
    body.tools.length === 0 ? { output: [] } : conversationResponse(body) });
  const app = await f.launch();
  try {
    const page = await ready(app), session = await configure(page, f.projectId, fixture.baseURL);
    await seedHistory(page, session.id);
    await saveAutomaticCompaction(page, session.id, true);
    const before = await page.evaluate(id => window.desktop.chatSnapshot(id), session.id);
    const accepted = await page.evaluate(({ id, text }) => window.desktop.submitChat(id, text, [], 'auto-invalid-summary-message'), { id: session.id, text: nextGoal });
    await expect.poll(() => page.evaluate(async id => (await window.desktop.chatSnapshot(id)).queue?.paused, session.id)).toBe(true);
    const failed = await page.evaluate(id => window.desktop.chatSnapshot(id), session.id);
    expect(failed.queue?.items.map(item => ({ id: item.id, text: item.text, status: item.status }))).toEqual([{ id: accepted.messageId, text: nextGoal, status: 'queued' }]);
    expect(failed.nativeContextMaintenance?.lastCompaction).toBeUndefined();
    expect(failed.messages).toHaveLength(before.messages.length + 1);
    expect(failed.messages.slice(0, before.messages.length)).toEqual(before.messages);
    expect(failed.messages.at(-1)).toMatchObject({ role: 'system', text: expect.stringContaining('发送前自动压缩未完成') });
    expect(failed.messages.at(-1)!.text).toContain('不会自动重复尝试');
    await noWorker(app);
    expect(fixture.requests).toHaveLength(5);
    expect(fixture.requests[4].tools).toEqual([]);
    const queue = page.getByRole('region', { name: '待发送消息' });
    await expect(queue).toContainText('队列已暂停');
    await expect(queue).toContainText(nextGoal);

    await saveAutomaticCompaction(page, session.id, false);
    await queue.getByRole('button', { name: '继续发送队列', exact: true }).click();
    await expect.poll(() => page.evaluate(async id => (await window.desktop.chatSnapshot(id)).queue?.items, session.id)).toEqual([]);
    expect(fixture.requests).toHaveLength(6);
    expect(fixture.requests.filter(request => (request.tools as unknown[]).length === 0)).toHaveLength(1);
    const retried = JSON.stringify(fixture.requests[5].input);
    expect(retried).toContain(firstGoal);
    expect(retried).toContain('AUTO_ORIGINAL_ANSWER_1');
    expect(retried).toContain('AUTO_ORIGINAL_ANSWER_2');
    expect(retried).toContain(recentGoal);
    expect(retried).toContain(nextGoal);
    await expect(page.locator('.chat-message.assistant').last()).toContainText('自动维护后的任务完成');
    expect(fixture.errors).toEqual([]);
  } finally { try { await closeNativeApp(app); await f.dispose(); } finally { await fixture.close(); } }
});
