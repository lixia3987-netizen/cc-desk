import { openSessionSettings, closeSessionSettings } from './helpers/session-settings';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { JsonValue, ToolDefinition } from '@cc-desk/agent-core';
import { estimateResponsesInputTokens } from '@cc-desk/agent-node/responses-model';
import type { ChatSnapshot } from '../src/shared/chat';
import { desktopRoot } from './helpers/paths';
import { electronLaunchArgs } from './helpers/electron-launch';
import { closeNativeApp } from './helpers/native-app-cleanup';
// @ts-expect-error The shared HTTP/SSE fixture has no TypeScript declarations.
import { assistantMessage, functionCall, startResponsesFixture } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

interface Body { input: Array<Record<string, unknown>>; tools: Array<{ name: string; description: string; parameters: ToolDefinition['inputSchema'] }>; instructions?: string }
interface Fixture { baseURL: string; errors: unknown[]; requests: Body[]; close(): Promise<void> }
const maxInputTokens = 60_000;
const goal = 'IN_TURN_GOAL_读取两次 fixture.txt，保留原始目标、工具结果，不重复已执行工具。';
const summaryText = 'IN_TURN_SUMMARY_第一批读取已完成，文件保持原样；继续当前任务，不重复先前读取。';
const snapshot = (page: Page, id: string): Promise<ChatSnapshot> => page.evaluate(id => window.desktop.chatSnapshot(id), id);

async function workspace() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-in-turn-回合 空格-'));
  const data = path.join(directory, 'data'), cwd = path.join(directory, 'project 空格'), projectId = randomUUID();
  await fs.mkdir(data); await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, 'fixture.txt'), 'read-only in-turn fixture\n');
  await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'Do not change files or repeat completed operations.\n');
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify({ version: 3, projects: [{ id: projectId, name: '回合内上下文维护', path: cwd, createdAt: new Date().toISOString() }],
    sessions: [], settings: { claudePath: path.join(directory, 'missing-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000, engineDefaults: {} } }));
  let release!: () => void, padding = 0, regularRequests = 0;
  const summaryGate = new Promise<void>(resolve => { release = resolve; });
  const fixture: Fixture = await startResponsesFixture({ assertReplay: false, handler: async ({ body }: { body: Body }) => {
    if (!body.tools.length) {
      await summaryGate;
      return { output: [assistantMessage('summary', summaryText)], usage: { input_tokens: 101, output_tokens: 17, total_tokens: 118 } };
    }
    regularRequests++;
    if (regularRequests === 1) {
      const definitions: ToolDefinition[] = body.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters, risk: 'read' }));
      const baseline = estimateResponsesInputTokens({ protocol: { id: 'openai-responses', version: 1 }, items: body.input as JsonValue[] }, body.instructions, definitions);
      // Two complete model/tool batches reach the threshold; the first alone
      // remains below it. The summary prefix and retained batch each still fit.
      padding = Math.max(1024, Math.floor((maxInputTokens * 0.94 - baseline) / 2));
    }
    if (regularRequests <= 2) return { output: [assistantMessage(`details-${regularRequests}`, `IN_TURN_BATCH_${regularRequests}_${'x'.repeat(padding)}`, 'commentary'),
      functionCall(`in-turn-read-${regularRequests}`, 'read_file', { path: 'fixture.txt' })] };
    return { output: [assistantMessage('final', '回合内维护后的任务结束。')] };
  } });
  return { directory, data, projectId, fixture, release,
    launch: () => electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot, env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data } }),
    async dispose() { release(); await fixture.close(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  };
}
async function configure(app: ElectronApplication, projectId: string, fixture: Fixture) {
  const { baseURL } = fixture;
  const page = await app.firstWindow(); await expect(page.locator('main.workspace')).toBeVisible();
  const session = await page.evaluate(async ({ projectId, baseURL }) => {
    const item = await window.desktop.nativeConnections.upsert({ name: 'Local in-turn compaction fixture', protocol: 'responses', baseURL, model: 'in-turn-fixture', enabled: true, allowLoopbackHttp: true, auth: { mode: 'memory' } });
    const connection = await window.desktop.nativeConnections.setCredential({ id: item.id, revision: item.revision, mode: 'memory', secret: 'sk-in-turn-local-fixture-only' });
    const session = await window.desktop.createSession({ projectId, title: '回合内维护界面验证', kind: 'agent', providerId: 'native', mode: 'structured', isolated: false, engineConfig: { schemaVersion: 1, options: { connectionId: connection.id, model: '' } } });
    await window.desktop.setSelection(session.id); return session;
  }, { projectId, baseURL });
  await openSessionSettings(page, 'compaction');
  await page.getByLabel('会话配置来源', { exact: true }).selectOption('custom');
  const setting = page.getByLabel('会话自动压缩', { exact: true });
  await expect(setting).toHaveValue('off');
  await setting.selectOption('before_send_and_during_run');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect.poll(() => page.evaluate(async id => (await window.desktop.snapshot()).state.sessions.find(item => item.id === id)!.engineConfig.options.autoCompact, session.id)).toBe('before_send_and_during_run');
  await openSessionSettings(page, 'context');
  await page.getByLabel('会话输入预算方式', { exact: true }).selectOption('custom');
  await page.getByLabel('会话输入预算（估算 tokens）', { exact: true }).fill(String(maxInputTokens));
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect.poll(() => page.evaluate(async id => (await window.desktop.snapshot()).state.sessions.find(item => item.id === id)!.engineConfig.options.autoCompact, session.id)).toBe('before_send_and_during_run');
  await closeSessionSettings(page);
  await page.evaluate(({ id, goal }) => window.desktop.submitChat(id, goal), { id: session.id, goal });
  await expect.poll(async () => (await snapshot(page, session.id)).nativeContextMaintenance?.compactionTrigger).toBe('in_turn');
  // The host exposes its phase before the summary worker reaches HTTP. Wait
  // for the gated summary request before asserting counts or cancelling it.
  await expect.poll(() => fixture.requests.length).toBe(3);
  expect(fixture.requests[2].tools).toHaveLength(0);
  const meter = page.locator('details.context-meter');
  if (!(await meter.evaluate(element => (element as HTMLDetailsElement).open))) await meter.locator('summary').click();
  await expect(meter).toContainText('持久保存后继续当前任务；取消会停止本回合');
  await openSessionSettings(page, 'compaction');
  await expect(setting).toBeDisabled();
  await closeSessionSettings(page);
  return { page, session, meter };
}

test('native in-turn compaction exposes the host phase across reload and persists the committed receipt without replay after restart', async () => {
  const f = await workspace(); let app: ElectronApplication | undefined;
  try {
    app = await f.launch(); const configured = await configure(app, f.projectId, f.fixture); let page = configured.page; const session = configured.session;
    const before = await snapshot(page, session.id);
    expect(before.nativeContextMaintenance?.inTurn?.status).toBe('attempted');
    expect(before.nativeContextMaintenance?.lastCompaction).toBeUndefined();
    expect(f.fixture.requests).toHaveLength(3);
    await page.reload(); await expect(page.locator('main.workspace')).toBeVisible();
    await expect(page.locator('.chat-meta')).toContainText('正在回合内压缩上下文');
    expect((await snapshot(page, session.id)).nativeContextMaintenance?.inTurn?.status).toBe('attempted');
    f.release();
    await expect.poll(async () => (await snapshot(page, session.id)).taskState).toBe('completed');
    const after = await snapshot(page, session.id);
    expect(after.nativeContextMaintenance?.inTurn).toMatchObject({ status: 'committed', summaryUsage: { inputTokens: 101, outputTokens: 17 } });
    expect(after.nativeContextMaintenance!.inTurn!.afterBytes).toBeLessThan(after.nativeContextMaintenance!.inTurn!.beforeBytes!);
    expect(after.usage).toMatchObject({ inputTokens: 134, outputTokens: 38 });
    for (const message of before.messages) expect(after.messages).toContainEqual(message);
    expect(f.fixture.requests).toHaveLength(4);
    const continuation = f.fixture.requests[3].input, serialized = JSON.stringify(continuation);
    expect(serialized).toContain(goal); expect(serialized).toContain(summaryText);
    expect(serialized).not.toContain('IN_TURN_BATCH_1_'); expect(serialized).toContain('IN_TURN_BATCH_2_');
    expect(continuation.filter(item => item.type === 'function_call' && item.call_id === 'in-turn-read-2')).toHaveLength(1);
    expect(continuation.filter(item => item.type === 'function_call_output' && item.call_id === 'in-turn-read-2')).toHaveLength(1);
    await closeNativeApp(app); app = await f.launch(); page = await app.firstWindow(); await expect(page.locator('main.workspace')).toBeVisible();
    await page.evaluate(id => window.desktop.setSelection(id), session.id);
    await openSessionSettings(page, 'compaction');
    await expect(page.getByLabel('会话自动压缩', { exact: true })).toHaveValue('before_send_and_during_run');
    await closeSessionSettings(page);
    expect((await snapshot(page, session.id)).nativeContextMaintenance?.inTurn).toEqual(after.nativeContextMaintenance?.inTurn);
    const meter = page.locator('details.context-meter'); await meter.locator('summary').click();
    await expect(meter).toContainText('回合内压缩已持久保存');
    await expect(meter).toContainText('已计入所属回合汇总，不需重复相加');
    expect(f.fixture.requests).toHaveLength(4); expect(f.fixture.errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('native-in-turn-compaction-restored.png') });
  } finally { f.release(); try { if (app) await closeNativeApp(app); } finally { await f.dispose(); } }
});

test('cancelling native in-turn compaction stops the active turn without a saved-success claim or an automatic retry', async () => {
  const f = await workspace(); let app: ElectronApplication | undefined;
  try {
    app = await f.launch(); const { page, session, meter } = await configure(app, f.projectId, f.fixture);
    await meter.getByRole('button', { name: '取消压缩', exact: true }).click();
    // Aborting marks the turn interrupted before the summary worker finishes
    // cleanup and persists its failed receipt. Wait for that terminal state.
    await expect.poll(async () => {
      const current = await snapshot(page, session.id);
      return { taskState: current.taskState, compacting: current.nativeContextMaintenance?.compacting,
        status: current.nativeContextMaintenance?.inTurn?.status };
    }).toEqual({ taskState: 'interrupted', compacting: false, status: 'failed' });
    const cancelled = await snapshot(page, session.id);
    expect(cancelled.nativeContextMaintenance?.compacting).toBe(false);
    expect(cancelled.nativeContextMaintenance?.inTurn?.status).toBe('failed');
    expect(cancelled.nativeContextMaintenance?.lastCompaction).toBeUndefined();
    await expect(meter).toContainText('回合内压缩未完成，本回合不再自动重试');
    await expect(meter).not.toContainText('回合内压缩已持久保存');
    expect(f.fixture.requests).toHaveLength(3);
    await closeNativeApp(app); app = await f.launch(); const restored = await app.firstWindow(); await expect(restored.locator('main.workspace')).toBeVisible();
    await restored.evaluate(id => window.desktop.setSelection(id), session.id);
    expect((await snapshot(restored, session.id)).nativeContextMaintenance?.inTurn).toEqual(cancelled.nativeContextMaintenance?.inTurn);
    expect(f.fixture.requests).toHaveLength(3); expect(f.fixture.errors).toEqual([]);
  } finally { f.release(); try { if (app) await closeNativeApp(app); } finally { await f.dispose(); } }
});
