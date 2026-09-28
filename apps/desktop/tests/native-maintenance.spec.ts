import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BeginRunRequest, PreparedTool, ToolCall } from '@cc-desk/agent-core';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import type { Session } from '../src/shared/types';
import { desktopRoot } from './helpers/paths';
import { electronLaunchArgs } from './helpers/electron-launch';
import { closeNativeApp } from './helpers/native-app-cleanup';
// @ts-expect-error The executable HTTP/SSE fixture is shared with agent-node tests.
import { assistantMessage, functionCall, startResponsesFixture } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

interface Fixture { baseURL: string; requests: Array<Record<string, unknown>>; errors: unknown[]; close(): Promise<void> }
interface RequestBody { input: Array<Record<string, unknown>>; tools: unknown[] }
const credential = 'sk-native-maintenance-local-fixture-only';
const firstGoal = 'PROJECT_GOAL_保留原文：保持 UTF-8 与换行，只修改已批准的文件。';
const latestGoal = 'RECENT_TURN_读取 fixture.txt，保留完整工具结果后继续。';
const summaryText = 'COMPACTED_HISTORY_已完成前两轮分析；文件仍是 fixture-original；关键约束：UTF-8、逐次审批、禁止重复执行。';
const longAnswer = (turn: number) => `ORIGINAL_ANSWER_${turn}\n${`第 ${turn} 轮完整分析。`.repeat(700)}`;

async function workspace() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-native-maintenance-恢复 空格-'));
  const data = path.join(directory, '应用 数据'), cwd = path.join(directory, '项目 空格');
  await fs.mkdir(data); await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, 'fixture.txt'), 'fixture-original\n');
  const projectId = randomUUID();
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify({ version: 3, projects: [
    { id: projectId, name: '长任务与恢复项目', path: cwd, createdAt: new Date().toISOString() },
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
    let connection = await window.desktop.nativeConnections.upsert({ name: '维护 HTTP fixture', protocol: 'responses', baseURL, model: 'maintenance-fixture', allowLoopbackHttp: true, enabled: true, auth: { mode: 'memory' } });
    connection = await window.desktop.nativeConnections.setCredential({ id: connection.id, revision: connection.revision, mode: 'memory', secret: credential });
    const session = await window.desktop.createSession({ projectId, title: 'Native 恢复与压缩', kind: 'agent', providerId: 'native', mode: 'structured', isolated: false,
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
async function openBudget(page: Page) {
  const meter = page.locator('details.context-meter');
  await expect(meter).toBeVisible();
  if (!(await meter.evaluate(element => (element as HTMLDetailsElement).open))) await meter.locator('summary').click();
  return meter;
}
async function longConversation(page: Page, sessionId: string) {
  await send(page, sessionId, firstGoal);
  await send(page, sessionId, 'MIDDLE_TURN_继续完整分析，并保留第一轮约束。');
  await send(page, sessionId, latestGoal);
}
function conversationResponse(body: RequestBody) {
  const users = body.input.filter(item => item.role === 'user');
  const latest = JSON.stringify(users.at(-1));
  const recentResult = body.input.find(item => item.type === 'function_call_output' && item.call_id === 'recent_read');
  if (latest.includes('RECENT_TURN_') && !recentResult) return { output: [functionCall('recent_read', 'read_file', { path: 'fixture.txt' })] };
  return { output: [assistantMessage(`maintenance_${users.length}`, latest.includes('CONTINUE_AFTER_') ? '继续成功，已读取维护后的上下文。' : longAnswer(users.length))] };
}

test('native manual compaction uses one tool-free request, retains exact goal and recent tool pairs, and persists without erasing history', async () => {
  const f = await workspace();
  const fixture: Fixture = await startResponsesFixture({ assertReplay: false, handler: ({ body }: { body: RequestBody }) =>
    body.tools.length === 0 ? { output: [assistantMessage('compact_summary', summaryText)] } : conversationResponse(body) });
  let app = await f.launch();
  try {
    let page = await ready(app);
    const session = await configure(page, f.projectId, fixture.baseURL);
    await longConversation(page, session.id);
    const before = await page.evaluate(id => window.desktop.chatSnapshot(id), session.id);
    expect(before.nativeContextMaintenance?.canCompact).toBe(true);
    const requestCount = fixture.requests.length;
    await expect(page.evaluate(id => window.desktop.compactNativeContext(id, '0'.repeat(64)), session.id)).rejects.toThrow();
    expect(fixture.requests).toHaveLength(requestCount);
    const meter = await openBudget(page);
    await meter.getByRole('button', { name: '压缩上下文（可能计费）', exact: true }).click();
    await expect.poll(() => page.evaluate(async id => (await window.desktop.chatSnapshot(id)).nativeContextMaintenance?.lastCompaction, session.id)).toBeTruthy();
    const compacted = await page.evaluate(id => window.desktop.chatSnapshot(id), session.id);
    expect(fixture.requests).toHaveLength(requestCount + 1);
    const summaryRequest = fixture.requests[requestCount];
    expect(summaryRequest.tools).toEqual([]);
    expect(JSON.stringify(summaryRequest.input)).toContain('ORIGINAL_ANSWER_1');
    expect(JSON.stringify(summaryRequest.input)).not.toContain(latestGoal);
    expect(compacted.nativeContextMaintenance!.lastCompaction!.afterBytes).toBeLessThan(compacted.nativeContextMaintenance!.lastCompaction!.beforeBytes);
    for (const message of before.messages) expect(compacted.messages).toContainEqual(message);
    await expect(meter).toContainText('原始聊天和工具记录已保留');
    await expect(page.locator('.chat-message.assistant').first()).toContainText('ORIGINAL_ANSWER_1');

    await send(page, session.id, 'CONTINUE_AFTER_COMPACTION_使用已压缩的记录继续。');
    const continued = fixture.requests.at(-1)!.input as Array<Record<string, unknown>>;
    const serialized = JSON.stringify(continued);
    expect(serialized).toContain(summaryText);
    expect(serialized).toContain(firstGoal);
    expect(serialized).toContain(latestGoal);
    expect(serialized).toContain('ORIGINAL_ANSWER_3');
    expect(serialized).not.toContain('ORIGINAL_ANSWER_1');
    expect(continued.filter(item => item.type === 'function_call' && item.call_id === 'recent_read')).toHaveLength(1);
    expect(continued.filter(item => item.type === 'function_call_output' && item.call_id === 'recent_read')).toHaveLength(1);

    await closeNativeApp(app); app = await f.launch(); page = await ready(app);
    await page.evaluate(id => window.desktop.setSelection(id), session.id);
    const restored = await page.evaluate(id => window.desktop.chatSnapshot(id), session.id);
    expect(restored.nativeContextMaintenance?.lastCompaction).toEqual(compacted.nativeContextMaintenance?.lastCompaction);
    for (const message of before.messages) expect(restored.messages).toContainEqual(message);
    await expect(page.locator('.chat-message.assistant').first()).toContainText('ORIGINAL_ANSWER_1');
    await restoreCredential(page);
    await send(page, session.id, 'CONTINUE_AFTER_RESTART_沿用已压缩上下文。');
    expect(JSON.stringify(fixture.requests.at(-1)!.input)).toContain(summaryText);
    expect(JSON.stringify(fixture.requests.at(-1)!.input)).not.toContain('ORIGINAL_ANSWER_1');
    expect(fixture.errors).toEqual([]);
  } finally { try { await closeNativeApp(app); await f.dispose(); } finally { await fixture.close(); } }
});

test('native cancelling a hanging compaction preserves its original context and releases the worker', async () => {
  const f = await workspace();
  const fixture: Fixture = await startResponsesFixture({ assertReplay: false, handler: ({ body }: { body: RequestBody }) =>
    body.tools.length === 0 ? { hang: true } : conversationResponse(body) });
  const app = await f.launch();
  try {
    const page = await ready(app), session = await configure(page, f.projectId, fixture.baseURL);
    await longConversation(page, session.id);
    const before = await page.evaluate(id => window.desktop.chatSnapshot(id), session.id);
    const requestCount = fixture.requests.length;
    const meter = await openBudget(page);
    await meter.getByRole('button', { name: '压缩上下文（可能计费）', exact: true }).click();
    await expect.poll(() => fixture.requests.length).toBe(requestCount + 1);
    await expect(meter).toContainText('正在生成摘要');
    await meter.getByRole('button', { name: '取消压缩', exact: true }).click();
    await expect.poll(() => page.evaluate(async id => Boolean((await window.desktop.chatSnapshot(id)).nativeContextMaintenance?.compacting), session.id)).toBe(false);
    await expect.poll(() => app.evaluate(({ app }) => app.getAppMetrics().some(metric => metric.serviceName === 'cc-desk native agent' || metric.name === 'cc-desk native agent'))).toBe(false);
    const cancelled = await page.evaluate(id => window.desktop.chatSnapshot(id), session.id);
    expect(cancelled.nativeContextMaintenance?.lastCompaction).toBeUndefined();
    expect(cancelled.nativeContextMaintenance?.headHash).toBe(before.nativeContextMaintenance?.headHash);
    expect(cancelled.messages).toEqual(before.messages);
    await send(page, session.id, 'CONTINUE_AFTER_CANCEL_保留所有原始内容继续。');
    const input = JSON.stringify(fixture.requests.at(-1)!.input);
    expect(input).toContain('ORIGINAL_ANSWER_1');
    expect(input).toContain('ORIGINAL_ANSWER_2');
    expect(input).not.toContain(summaryText);
    expect(fixture.requests).toHaveLength(requestCount + 2);
    expect(fixture.errors).toEqual([]);
  } finally { try { await closeNativeApp(app); await f.dispose(); } finally { await fixture.close(); } }
});

/** Simulate the exact durable records left by a host that died after a tool boundary. */
async function interruptLedger(data: string, cwd: string, session: Session, unknown: boolean) {
  const ledger = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId: session.execution.conversationId! });
  try {
    const previous = ledger.listRuns().at(-1)!;
    const input = 'RECOVERY_TASK_已完成读取，写入请求在宿主中断前尚未返回。';
    const request: BeginRunRequest = { identity: { ...previous.identity, runId: randomUUID(), requestId: randomUUID(), workerGeneration: previous.identity.workerGeneration + 1 },
      input, inputDigest: 'fixture-recovery-input', userItems: [{ role: 'user', content: input }], protocol: ledger.loadContext()!.protocol,
      configuration: previous.configuration, policyRevision: previous.policyRevision };
    await ledger.beginRun(request);
    const read: ToolCall = { id: 'recovery_read', name: 'read_file', arguments: JSON.stringify({ path: 'fixture.txt' }) };
    const commandInput = { executable: process.execPath, argv: ['-e', 'require("node:fs").appendFileSync("effect-marker.txt","executed\\n")'], cwd: '.' };
    const command: ToolCall = { id: 'recovery_command', name: 'run_command', arguments: JSON.stringify(commandInput) };
    await ledger.append(request.identity, { type: 'model_response', response: { outputItems: [functionCall(read.id, read.name, JSON.parse(read.arguments)), functionCall(command.id, command.name, commandInput)], toolCalls: [read, command], finishReason: 'tool_calls', usage: null } });
    const prepared: PreparedTool = { call: read, definition: { name: read.name, description: 'Read fixture', inputSchema: { type: 'object' }, risk: 'read' }, input: { path: 'fixture.txt' }, inputDigest: 'fixture-read-digest', policyRevision: request.policyRevision, requiresApproval: false, preconditions: {} };
    await ledger.append(request.identity, { type: 'tool_prepared', prepared });
    const readResult = { status: 'completed' as const, output: { content: 'fixture-original\n', hash: 'fixture-read-hash' } };
    await ledger.append(request.identity, { type: 'tool_completed', call: read, result: readResult, resultItems: [{ type: 'function_call_output', call_id: read.id, output: JSON.stringify(readResult) }] });
    if (unknown) {
      const preparedCommand: PreparedTool = { call: command, definition: { name: command.name, description: 'Write marker', inputSchema: { type: 'object' }, risk: 'command' }, input: commandInput, inputDigest: 'fixture-command-digest', policyRevision: request.policyRevision, requiresApproval: true, preconditions: {} };
      await ledger.append(request.identity, { type: 'tool_prepared', prepared: preparedCommand, approval: { binding: { ...request.identity, toolCallId: command.id, inputDigest: preparedCommand.inputDigest, policyRevision: request.policyRevision }, decision: 'approved', expiresAt: Date.now() + 60_000 } });
      // The effect exists, but there is deliberately no durable tool completion.
      await fs.writeFile(path.join(cwd, 'effect-marker.txt'), 'executed\n');
    }
    return request.identity;
  } finally { await ledger.close(); }
}

test('native verified recovery closes unexecuted calls without replay and resumes only after a new instruction', async () => {
  const f = await workspace();
  const fixture: Fixture = await startResponsesFixture({ assertReplay: false, handler: ({ index }: { index: number }) => ({ output: [assistantMessage(`recovery_response_${index}`, '恢复后的新指令完成。')] }) });
  let app = await f.launch();
  try {
    let page = await ready(app), session = await configure(page, f.projectId, fixture.baseURL);
    await send(page, session.id, 'INITIAL_RECOVERY_建立真实模型与服务绑定。');
    await closeNativeApp(app);
    await interruptLedger(f.data, f.cwd, session, false);
    app = await f.launch(); page = await ready(app);
    await page.evaluate(id => window.desktop.setSelection(id), session.id);
    const recovery = (await page.evaluate(id => window.desktop.chatSnapshot(id), session.id)).nativeRecovery!;
    expect(recovery.status).toBe('recoverable');
    expect(recovery.tools).toEqual({ completed: 1, notExecuted: 1, unknown: 0 });
    const region = page.getByRole('region', { name: '中断任务恢复' });
    await expect(region).toBeVisible();
    await expect(page.evaluate(id => window.desktop.resumeNativeRecovery(id, '0'.repeat(64)), session.id)).rejects.toThrow();
    expect(fixture.requests).toHaveLength(1);
    await region.getByRole('button', { name: '已核查，恢复会话', exact: true }).click();
    await expect.poll(() => page.evaluate(async id => (await window.desktop.chatSnapshot(id)).nativeRecovery, session.id)).toBeUndefined();
    expect(fixture.requests).toHaveLength(1);
    await expect(page.getByRole('status').filter({ hasText: '记录已恢复；请发送新指令继续' })).toBeVisible();
    await expect(fs.stat(path.join(f.cwd, 'effect-marker.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await restoreCredential(page);
    await send(page, session.id, 'EXPLICIT_RECOVERY_CONTINUE_检查结果后再规划，不重复旧工具。');
    const continued = fixture.requests.at(-1)!.input as Array<Record<string, unknown>>;
    const outputs = continued.filter(item => item.type === 'function_call_output');
    expect(outputs.filter(item => item.call_id === 'recovery_read')).toHaveLength(1);
    expect(outputs.filter(item => item.call_id === 'recovery_command')).toHaveLength(1);
    expect(JSON.parse(String(outputs.find(item => item.call_id === 'recovery_command')!.output)).status).toBe('not_executed');
    expect(fixture.requests).toHaveLength(2);
    await expect(fs.stat(path.join(f.cwd, 'effect-marker.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await closeNativeApp(app); app = await f.launch(); page = await ready(app);
    const restarted = await page.evaluate(id => window.desktop.chatSnapshot(id), session.id);
    expect(restarted.nativeRecovery).toBeUndefined();
    expect(restarted.messages.some(message => message.text.includes('RECOVERY_TASK_'))).toBe(true);
    expect(fixture.errors).toEqual([]);
  } finally { try { await closeNativeApp(app); await f.dispose(); } finally { await fixture.close(); } }
});

test('native recovery with an unknown command remains read-only and never repeats its side effect', async () => {
  const f = await workspace();
  const fixture: Fixture = await startResponsesFixture({ handler: () => ({ output: [assistantMessage('unknown_initial', '建立会话完成。')] }) });
  let app = await f.launch();
  try {
    let page = await ready(app), session = await configure(page, f.projectId, fixture.baseURL);
    await send(page, session.id, 'INITIAL_UNKNOWN_建立真实模型与服务绑定。');
    await closeNativeApp(app);
    await interruptLedger(f.data, f.cwd, session, true);
    app = await f.launch(); page = await ready(app);
    await page.evaluate(id => window.desktop.setSelection(id), session.id);
    const recovery = (await page.evaluate(id => window.desktop.chatSnapshot(id), session.id)).nativeRecovery!;
    expect(recovery.status).toBe('blocked');
    expect(recovery.tools).toEqual({ completed: 1, notExecuted: 0, unknown: 1 });
    const region = page.getByRole('region', { name: '中断任务恢复' });
    await expect(region).toContainText('结果未知');
    await expect(region.getByRole('button', { name: '已核查，恢复会话', exact: true })).toHaveCount(0);
    await expect(page.evaluate(({ id, headHash }) => window.desktop.resumeNativeRecovery(id, headHash), { id: session.id, headHash: recovery.headHash })).rejects.toThrow();
    await restoreCredential(page);
    const refused = await page.evaluate(async id => {
      try { return await window.desktop.sendChat(id, '必须被阻止，不能重放未知操作。'); }
      catch (error) { return { success: false, error: String(error) }; }
    }, session.id);
    expect(refused.success).toBe(false);
    expect(refused.error).toMatch(/恢复|核查|只读|中断/);
    expect(fixture.requests).toHaveLength(1);
    expect(await fs.readFile(path.join(f.cwd, 'effect-marker.txt'), 'utf8')).toBe('executed\n');
    await closeNativeApp(app); app = await f.launch(); page = await ready(app);
    const restarted = await page.evaluate(id => window.desktop.chatSnapshot(id), session.id);
    expect(restarted.nativeRecovery?.status).toBe('blocked');
    expect(restarted.nativeRecovery?.tools.unknown).toBe(1);
    expect(await fs.readFile(path.join(f.cwd, 'effect-marker.txt'), 'utf8')).toBe('executed\n');
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.errors).toEqual([]);
  } finally { try { await closeNativeApp(app); await f.dispose(); } finally { await fixture.close(); } }
});
