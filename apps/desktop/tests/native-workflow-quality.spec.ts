import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NativeQualityReportDeclaration, NativeQualityRole, NativeWorkflowQualityState } from '@cc-desk/contracts/native-workflow-quality';
import type { ChatTurnResult } from '../src/shared/chat';
import { desktopRoot } from './helpers/paths';
import { electronLaunchArgs } from './helpers/electron-launch';
import { captureNativeDiagnostics, closeNativeApp } from './helpers/native-app-cleanup';
import { openChatAssistance } from './helpers/chat-assistance';
import { buildNativeReviewGoal } from '../src/main/engines/native/agent-prompts';
// @ts-expect-error Shared executable HTTP fixture replaces only the external model.
import { assistantMessage, functionCall, startResponsesFixture } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

const execute = promisify(execFile), secret = 'sk-native-workflow-quality-test-protected';
interface Item { type?: string; role?: string; content?: string | Array<{ text?: string }>; call_id?: string; output?: string }
interface Body { input: Item[]; tools: Array<{ name: string }>; instructions: string }
interface ToolResult { status: string; output: { hash?: string; content?: string; path?: string; exitCode?: number; [key: string]: unknown } }
interface Fixture { baseURL: string; requests: Body[]; errors: unknown[]; close(): Promise<void> }
const results = (body: Body) => new Map(body.input.filter(item => item.type === 'function_call_output').map(item => [item.call_id!, JSON.parse(item.output!) as ToolResult]));
const textContent = (item?: Item) => typeof item?.content === 'string' ? item.content : item?.content?.map(part => part.text ?? '').join('') ?? '';
const goal = (body: Body) => textContent(body.input.find(item => item.role === 'user'));
const call = (id: string, name: string, input: unknown) => ({ output: [functionCall(id, name, input)] });
const final = (id: string, text: string) => ({ output: [assistantMessage(id, text)] });
const qualityRole = (body: Body): NativeQualityRole | undefined => body.instructions.match(/host-assigned quality role is (reviewer|challenger|verifier)/u)?.[1] as NativeQualityRole | undefined;
const readId = (file: string) => `quality-read-${file.replaceAll(/[^a-z0-9]/giu, '-')}`;
const parentPlan = () => call('parent-plan', 'update_plan', { expectedRevision: 0,
  plan: { goal: 'Inspect the delivery and independently validate the actual evidence.',
    steps: [{ id: 'deliver', title: 'Inspect, deliver and validate', dependsOn: [], status: 'in_progress' }],
    criteria: [{ id: 'manual-review', description: 'The user reviews delivery evidence before manual acceptance.', stepIds: ['deliver'], kind: 'manual' }] } });

async function workspace(content: string) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-workflow-quality-电子 空格-')));
  const data = path.join(directory, '应用 数据'), cwd = path.join(directory, '项目 空格'), projectId = randomUUID();
  await fs.mkdir(data); await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, 'fixture.txt'), content);
  // The deterministic model and commands assert these exact bytes. Preserve
  // this one file through Git checkout without changing inherited autocrlf.
  await fs.writeFile(path.join(cwd, '.gitattributes'), '/fixture.txt -text\n');
  await execute('git', ['-C', cwd, 'init', '-b', 'main'], { windowsHide: true });
  await execute('git', ['-C', cwd, 'config', 'user.name', 'Workflow quality fixture'], { windowsHide: true });
  await execute('git', ['-C', cwd, 'config', 'user.email', 'quality-fixture@localhost'], { windowsHide: true });
  await execute('git', ['-C', cwd, 'add', '--all'], { windowsHide: true });
  await execute('git', ['-C', cwd, 'commit', '-m', 'Quality fixture baseline'], { windowsHide: true });
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify({ version: 3,
    projects: [{ id: projectId, name: 'Native Workflow Quality', path: cwd, createdAt: new Date().toISOString() }], sessions: [],
    settings: { claudePath: path.join(directory, 'missing-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000, engineDefaults: {} } }));
  return { directory, data, cwd, projectId,
    launch: async () => captureNativeDiagnostics(await electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot,
      env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data } })),
    dispose: () => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}
async function ready(app: ElectronApplication) { const page = await app.firstWindow(); await expect(page.locator('main.workspace')).toBeVisible(); return page; }
async function configure(page: Page, projectId: string, baseURL: string) {
  return page.evaluate(async ({ projectId, baseURL, secret }) => {
    const initial = await window.desktop.nativeConnections.upsert({ name: 'Workflow quality model fixture', protocol: 'responses', baseURL,
      model: 'quality-fixture-model', enabled: true, allowLoopbackHttp: true, auth: { mode: 'memory' } });
    const connection = await window.desktop.nativeConnections.setCredential({ id: initial.id, revision: initial.revision, mode: 'memory', secret });
    const session = await window.desktop.createSession({ projectId, title: 'Native 工作流独立质量验证', kind: 'agent', providerId: 'native', mode: 'structured', isolated: false,
      engineConfig: { schemaVersion: 1, options: { connectionId: connection.id, model: '', maxSubagents: 8, maxInputTokens: 128000,
        maxModelRequests: 40, maxToolCalls: 80, maxActiveMs: 120000 } } });
    await window.desktop.setSelection(session.id); return session;
  }, { projectId, baseURL, secret });
}
const snapshot = (page: Page, id: string) => page.evaluate(id => window.desktop.chatSnapshot(id), id);
const childrenCount = (app: ElectronApplication) => app.evaluate(({ app }) => app.getAppMetrics().filter(metric => metric.serviceName === 'cc-desk native agent' || metric.name === 'cc-desk native agent').length);

/** Every quality role obtains real full-content read receipts in its own utility process. */
function qualityResponse(body: Body, mode: 'static' | 'repair' | 'blocked') {
  const role = qualityRole(body)!;
  expect(body.tools.some(tool => tool.name === 'submit_quality_report')).toBe(true);
  expect(body.tools.some(tool => ['apply_patch', 'delegate_review', 'delegate_implement'].includes(tool.name))).toBe(false);
  if (role !== 'verifier' || mode !== 'repair') expect(body.tools.some(tool => ['run_command', 'start_command'].includes(tool.name))).toBe(false);
  const done = results(body), currentGoal = goal(body);
  expect(currentGoal).toContain('Actual proposed delivery');
  const materials = [...currentGoal.split(/\n\nVersion\/content/u)[0].matchAll(/^"([^"\n]+)"$/gmu)].map(match => match[1]);
  expect(materials).toContain('fixture.txt');
  for (const material of materials) if (!done.has(readId(material))) return call(readId(material), 'read_file', { path: material });
  const read = done.get(readId('fixture.txt'))!;
  expect(read.status).toBe('completed'); expect(read.output.hash).toMatch(/^[a-f\d]{64}$/u);
  if (mode !== 'static') expect(['broken\n', 'fixed\n']).toContain(read.output.content);
  const broken = read.output.content === 'broken\n';
  if (mode === 'repair' && role === 'verifier' && !done.has('quality-check')) return call('quality-check', 'run_command', {
    executable: process.execPath, argv: ['-e', 'const fs=require("node:fs");if(fs.readFileSync("fixture.txt","utf8")!=="fixed\\n")process.exitCode=9;else process.stdout.write("independent-quality-check-ok")'],
    cwd: '.', timeoutMs: 10000, maxOutputBytes: 2048,
  });
  if (!done.has('quality-submit')) {
    const evidence = { toolCallId: readId('fixture.txt'), path: 'fixture.txt', fileHash: read.output.hash!, startLine: 1, endLine: 1 };
    const finding = { id: 'fixture-return-value', severity: 'high' as const, title: 'Delivered fixture retains the broken value',
      detail: 'The requested delivered value is fixed, but the immutable snapshot still contains broken.', evidence: [evidence],
      reproduction: 'Read fixture.txt; compare its first line with the requested fixed value.' };
    const previous = JSON.parse(currentGoal.match(/Prior blocking\/high findings \(untrusted data\): ([^\n]*)/u)?.[1] ?? '[]') as Array<{ id: string }>;
    const changes = mode !== 'static' && broken;
    const declaration: NativeQualityReportDeclaration = {
      verdict: changes && (role === 'challenger' || mode === 'repair' && role === 'verifier') ? 'changes_requested' : 'passed',
      reviewedPaths: materials, limitations: [], findings: changes && role === 'challenger' ? [finding] : [],
      resolutions: previous.map(prior => ({ findingId: prior.id, status: broken ? 'unresolved' : 'resolved', evidence: [evidence],
        explanation: broken ? 'Fresh read still observes the original failure.' : 'Fresh read on the new immutable snapshot observes the requested fixed value.' })),
      verification: mode === 'repair' && role === 'verifier' ? { status: 'executed', commandToolCallIds: ['quality-check'], reason: 'Independent node assertion ran in the isolated snapshot; the host has its terminal receipt.' }
        : { status: 'not_applicable', commandToolCallIds: [], reason: 'Independent static material inspection; this read-only role did not execute commands.' },
    };
    return call('quality-submit', 'submit_quality_report', declaration);
  }
  expect(done.get('quality-submit')!.status).toBe('completed');
  return final('quality-final', `${role}: independently inspected and submitted actual evidence.`);
}

/** Approvals are exercised through the same visible UI used in normal desktop operation. */
async function approveUntilSettled(page: Page, sessionId: string, pending: Promise<ChatTurnResult>) {
  const approved: Array<{ toolName?: string; child: boolean }> = [];
  let completion: { result?: ChatTurnResult; error?: unknown } | undefined;
  void pending.then(result => { completion = { result }; }, error => { completion = { error }; });
  const deadline = Date.now() + 100000, seen = new Set<string>();
  while (!completion) {
    if (Date.now() >= deadline) throw new Error('Workflow quality turn did not settle before the approval deadline.');
    const current = await snapshot(page, sessionId), request = current.pending.find(item => item.kind === 'permission' && !seen.has(item.requestId));
    if (!request) { await page.waitForTimeout(100); continue; }
    seen.add(request.requestId);
    const approval = page.getByRole('region', { name: '工具审批', exact: true });
    await expect(approval).toHaveAttribute('data-request-id', request.requestId);
    approved.push({ toolName: request.toolName, child: !!request.nativeDelegation });
    if (request.nativeDelegation) await expect(approval.getByRole('region', { name: '子 Agent 操作范围' })).toContainText(request.nativeDelegation.title);
    await approval.getByRole('button', { name: '允许本次', exact: true }).click();
  }
  if (completion.error) throw completion.error;
  return { result: completion.result!, approved };
}

async function assertRealQuality(data: string, state: NativeWorkflowQualityState) {
  const persisted = JSON.parse(await fs.readFile(state.receiptPath, 'utf8')) as NativeWorkflowQualityState;
  expect(persisted).toEqual(state); expect(state.manualAcceptance).toBe('not_requested');
  const identities = state.rounds.flatMap(round => round.roles.map(role => role.identity.runId));
  expect(new Set(identities).size).toBe(identities.length);
  for (const round of state.rounds) for (const child of round.roles) {
    const journalPath = path.join(data, 'native', 'conversations', child.identity.conversationId, 'journal.jsonl');
    const raw = await fs.readFile(journalPath, 'utf8'); expect(raw).not.toContain(secret);
    const events = raw.trim().split('\n').map(line => JSON.parse(line).event);
    expect(events.some(event => event.type === 'tool_completed' && event.call.name === 'read_file')).toBe(true);
    if (child.report) {
      expect(child.report.identity).toEqual(child.identity); expect(child.report.snapshotCommit).toBe(round.snapshotCommit);
      expect(child.report.deliveryDigest).toBe(round.deliveryDigest); expect(round.deliveryDigest).toMatch(/^[a-f\d]{64}$/u);
      expect(events.some(event => event.type === 'tool_completed' && event.call.name === 'submit_quality_report' && event.result.status === 'completed')).toBe(true);
      expect(child.report.materialReads.some(read => read.path === 'fixture.txt')).toBe(true);
    }
  }
}

test('direct workflow analysis runs three real independent review processes and restores host quality separately from manual acceptance', async () => {
  test.info().setTimeout(120000);
  const f = await workspace('static material\n');
  const fixture: Fixture = await startResponsesFixture({ assertReplay: false, handler: ({ body }: { body: Body }) => {
    if (qualityRole(body)) return qualityResponse(body, 'static');
    if (!results(body).has('parent-plan')) return parentPlan();
    if (!results(body).has('parent-read')) return call('parent-read', 'read_file', { path: 'fixture.txt' });
    return final('parent-final', '静态分析完成，保留材料读取事实并等待独立检查。');
  } });
  const app = await f.launch();
  try {
    const page = await ready(app), session = await configure(page, f.projectId, fixture.baseURL);
    const result = await page.evaluate(id => window.desktop.sendChat(id, '使用 workflow，分析 `fixture.txt` 的内容与一致性。', [], 'direct-static-workflow'), session.id);
    expect(result.success, result.error).toBe(true); expect(fixture.errors).toEqual([]);
    const saved = await snapshot(page, session.id), quality = saved.nativeWorkflowQuality!;
    expect(quality.status).toBe('passed'); expect(quality.validationMode).toBe('static'); expect(quality.round).toBe(1);
    expect(quality.rounds[0].roles.map(role => role.role).sort()).toEqual(['challenger', 'reviewer', 'verifier']);
    expect(quality.rounds[0].roles.every(role => role.status === 'completed')).toBe(true);
    expect(result.nativeReceipt?.workflowQuality?.status).toBe('passed');
    expect(saved.nativeTask?.verification).toBe('unverified');
    expect(saved.nativeAgentRuntime?.maxSubagents).toBe(8); expect(saved.nativeAgentRuntime?.total).toBe(0);
    await assertRealQuality(f.data, quality);
    const panel = page.getByRole('region', { name: 'Native 工作流质量审查', exact: true });
    await expect(panel).toHaveAttribute('data-quality-status', 'passed'); await expect(panel).toContainText('人工验收：未发起');
    await expect(panel.locator('[data-quality-role]')).toHaveCount(3);
    await expect.poll(() => childrenCount(app)).toBe(0);
    const requestCount = fixture.requests.length;
    await closeNativeApp(app);
    const reopened = await f.launch();
    try {
      const reopenedPage = await ready(reopened), restored = await snapshot(reopenedPage, session.id);
      expect(restored.nativeWorkflowQuality).toEqual(quality); expect(restored.nativeTask?.verification).toBe('unverified');
      expect(fixture.requests).toHaveLength(requestCount);
      await reopenedPage.evaluate(async ({ id, secret }) => {
        const current = await window.desktop.snapshot(), selected = current.state.sessions.find(item => item.id === id)!;
        const connection = (await window.desktop.nativeConnections.list()).connections.find(item => item.id === selected.engineConfig.options.connectionId)!;
        await window.desktop.nativeConnections.setCredential({ id: connection.id, revision: connection.revision, mode: 'memory', secret });
        await window.desktop.saveSettings({ ...current.state.settings, engineDefaults: { ...current.state.settings.engineDefaults,
          native: { schemaVersion: 1, options: { maxSubagents: 12 } } } });
        await window.desktop.updateSession({ id, engineConfig: { ...selected.engineConfig, options: { ...selected.engineConfig.options, runtimePolicy: 'defaults' } } });
      }, { id: session.id, secret });
      const next = await reopenedPage.evaluate(id => window.desktop.sendChat(id, '只用一个 Agent 说明这份材料的第一行。', [], 'follow-defaults-next-turn'), session.id);
      expect(next.success).toBe(true);
      const latest = await snapshot(reopenedPage, session.id);
      expect(latest.nativeAgentRuntime?.maxSubagents).toBe(12); expect(latest.nativeAgentRuntime?.policySource).toBe('defaults');
      expect(latest.nativeWorkflowQuality).toBeUndefined();
    } finally { await closeNativeApp(reopened); }
  } finally { await closeNativeApp(app); await fixture.close(); await f.dispose(); }
});

test('a configured capacity above four starts five actual children while the UI folds only their retained rows', async () => {
  test.info().setTimeout(120000);
  const f = await workspace('five independent checks\n'), started = new Set<string>();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const fixture: Fixture = await startResponsesFixture({ assertReplay: false, handler: async ({ body }: { body: Body }) => {
    const done = results(body);
    if (body.instructions.includes('independent delegated Native agent')) {
      const child = goal(body).match(/Independent question: Question (\d)/u)?.[1];
      expect(child).toBeTruthy();
      if (!done.has('child-read')) { started.add(child!); await barrier; return call('child-read', 'read_file', { path: 'fixture.txt' }); }
      return final('child-final', `Question ${child} checked with a real material receipt.`);
    }
    if (!done.has('parent-read')) return call('parent-read', 'read_file', { path: 'fixture.txt' });
    if (!done.has('parent-delegate')) return call('parent-delegate', 'delegate_review', { tasks: Array.from({ length: 5 }, (_, index) => ({
      title: `Independent question ${index + 1}`, goal: buildNativeReviewGoal({ materials: '`fixture.txt`', version: 'Current project file; obtain your own full-content read receipt.',
        question: `Question ${index + 1}: check independently assigned property ${['first token', 'last token', 'line count', 'newline termination', 'text encoding'][index]}`,
        scope: 'Only the assigned property of fixture.txt', evidence: 'Read actual content and cite your own host evidence.', exclusions: 'Do not answer the other four assigned questions.' }),
    })) });
    const delegated = done.get('parent-delegate')!.output as { parentRunId: string; children: Array<{ childId: string }> };
    for (const [index, child] of delegated.children.entries()) if (!done.has(`parent-result-${index}`)) return call(`parent-result-${index}`, 'read_agent_result', { parentRunId: delegated.parentRunId, childId: child.childId });
    return final('parent-final', 'Five actual independent child results were inspected.');
  } });
  const app = await f.launch();
  try {
    const page = await ready(app), session = await configure(page, f.projectId, fixture.baseURL);
    const pending = page.evaluate(id => window.desktop.sendChat(id, '请使用 5 个 subagent 并行分析 fixture.txt 的五个不同属性。', [], 'five-real-child-checks'), session.id);
    await expect.poll(() => started.size, { timeout: 20000 }).toBe(5);
    await expect.poll(async () => (await snapshot(page, session.id)).nativeAgentRuntime?.active).toBe(5);
    expect(await childrenCount(app)).toBeGreaterThanOrEqual(6);
    const live = await snapshot(page, session.id);
    expect(live.nativeAgentRuntime?.maxSubagents).toBe(8); expect(live.nativeAgentRuntime?.policySource).toBe('session'); expect(live.nativeAgentRuntime?.total).toBe(5);
    await openChatAssistance(page, 'agents');
    const runtime = page.getByLabel('本轮子 Agent 配置', { exact: true });
    await expect(runtime).toContainText('活跃 5 / 有效上限 8');
    await expect(page.locator('[data-agent-id]')).toHaveCount(4);
    await page.getByRole('button', { name: '查看全部子 Agent（5）', exact: true }).click();
    await expect(page.locator('[data-agent-id]')).toHaveCount(5);
    release(); const result = await pending;
    expect(result.success, result.error).toBe(true); expect(fixture.errors).toEqual([]);
    const complete = await snapshot(page, session.id);
    expect(complete.nativeAgentRuntime?.completed).toBe(5); expect(complete.nativeAgentRuntime?.active).toBe(0); expect(complete.nativeAgents?.items).toHaveLength(5);
    expect(complete.nativeWorkflowQuality).toBeUndefined();
    await expect.poll(() => childrenCount(app)).toBe(0);
  } finally { release(); await closeNativeApp(app); await fixture.close(); await f.dispose(); }
});

test('a high-priority independent finding returns to the parent for an approved repair and fresh snapshot revalidation', async () => {
  test.info().setTimeout(150000);
  const f = await workspace('broken\n'); let repairFeedback = false;
  const fixture: Fixture = await startResponsesFixture({ assertReplay: false, handler: ({ body }: { body: Body }) => {
    if (qualityRole(body)) return qualityResponse(body, 'repair');
    const done = results(body);
    if (!done.has('parent-plan')) return parentPlan();
    if (!done.has('parent-read')) return call('parent-read', 'read_file', { path: 'fixture.txt' });
    if (body.input.some(item => item.role === 'user' && textContent(item).includes('workflow_quality_changes_requested'))) {
      repairFeedback = true;
      if (!done.has('parent-repair')) return call('parent-repair', 'apply_patch', { path: 'fixture.txt', content: 'fixed\n', expectedHash: done.get('parent-read')!.output.hash });
      if (!done.has('parent-check')) return call('parent-check', 'run_command', { executable: process.execPath,
        argv: ['-e', 'const fs=require("node:fs");if(fs.readFileSync("fixture.txt","utf8")!=="fixed\\n")process.exitCode=8;else process.stdout.write("parent-fixed-ok")'], cwd: '.', timeoutMs: 10000, maxOutputBytes: 2048 });
    }
    return final(repairFeedback ? 'parent-repaired' : 'parent-premature', repairFeedback ? '已修复并执行检查，等待新快照的独立重验。' : '实现已完成，请进行独立检查。');
  } });
  const app = await f.launch();
  try {
    const page = await ready(app), session = await configure(page, f.projectId, fixture.baseURL);
    const pending = page.evaluate(id => window.desktop.sendChat(id, '使用 workflow，修复 `fixture.txt`，交付内容必须是 fixed，独立验证。', [], 'workflow-repair-and-revalidate'), session.id);
    const { result, approved } = await approveUntilSettled(page, session.id, pending);
    expect(result.success, result.error).toBe(true); expect(repairFeedback).toBe(true); expect(fixture.errors).toEqual([]);
    expect(approved).toContainEqual({ toolName: 'apply_patch', child: false });
    expect(approved.filter(item => item.toolName === 'run_command' && item.child)).toHaveLength(2);
    const saved = await snapshot(page, session.id), quality = saved.nativeWorkflowQuality!;
    expect(quality.status).toBe('passed'); expect(quality.round).toBe(2); expect(quality.validationMode).toBe('commands');
    expect(quality.rounds.map(round => round.status)).toEqual(['changes_requested', 'passed']);
    expect(quality.rounds[0].roles.find(role => role.role === 'challenger')?.report?.declaration.findings[0].severity).toBe('high');
    expect(quality.rounds[0].snapshotCommit).not.toBe(quality.rounds[1].snapshotCommit);
    const resolvedId = quality.rounds[1].roles[0].report?.declaration.resolutions[0]?.findingId;
    expect(resolvedId).toMatch(/^quality-[a-f\d]{40}$/u);
    expect(quality.rounds[1].roles.every(role => role.report?.declaration.resolutions.some(row => row.findingId === resolvedId && row.status === 'resolved'))).toBe(true);
    expect(quality.rounds[1].deliveryDigest).not.toBe(quality.rounds[0].deliveryDigest);
    expect(quality.rounds[1].roles.find(role => role.role === 'verifier')?.report?.commandReceipts).toEqual([{ toolCallId: 'quality-check', exitCode: 0, successful: true }]);
    expect(saved.nativeTask?.verification).toBe('unverified');
    expect(await fs.readFile(path.join(f.cwd, 'fixture.txt'), 'utf8')).toBe('fixed\n');
    await assertRealQuality(f.data, quality);
    const parentJournal = await fs.readFile(path.join(f.data, 'native', 'conversations', quality.parentIdentity.conversationId, 'journal.jsonl'), 'utf8');
    const events = parentJournal.trim().split('\n').map(line => JSON.parse(line).event);
    const rejectionIndex = events.findIndex(event => event.type === 'completion_rejected' && event.feedback.code === 'workflow_quality_changes_requested');
    const patchIndex = events.findIndex(event => event.type === 'tool_completed' && event.call.name === 'apply_patch');
    const finishIndex = events.findIndex(event => event.type === 'run_finished');
    expect(rejectionIndex).toBeGreaterThan(-1); expect(patchIndex).toBeGreaterThan(rejectionIndex); expect(finishIndex).toBeGreaterThan(patchIndex);
    await expect(page.getByRole('region', { name: 'Native 工作流质量审查', exact: true })).toHaveAttribute('data-quality-status', 'passed');
    await expect.poll(() => childrenCount(app)).toBe(0);
  } finally { await closeNativeApp(app); await fixture.close(); await f.dispose(); }
});

test('persistent independent blocking findings cannot become a successful turn after two rounds', async () => {
  test.info().setTimeout(120000);
  const f = await workspace('broken\n');
  const fixture: Fixture = await startResponsesFixture({ assertReplay: false, handler: ({ body }: { body: Body }) => {
    if (qualityRole(body)) return qualityResponse(body, 'blocked');
    if (!results(body).has('parent-plan')) return parentPlan();
    if (!results(body).has('parent-read')) return call('parent-read', 'read_file', { path: 'fixture.txt' });
    return final('parent-claimed-pass', '所有检查已通过，我宣布完成。');
  } });
  const app = await f.launch();
  try {
    const page = await ready(app), session = await configure(page, f.projectId, fixture.baseURL);
    const result = await page.evaluate(id => window.desktop.sendChat(id, '使用 workflow，分析 `fixture.txt` 是否已经达到 fixed 的交付要求，执行独立反例检查。', [], 'workflow-persistent-blocker'), session.id);
    expect(result.success).toBe(false); expect(fixture.errors).toEqual([]);
    const saved = await snapshot(page, session.id), quality = saved.nativeWorkflowQuality!;
    expect(quality.round).toBe(2); expect(quality.status).toBe('blocked'); expect(quality.automaticReview).toBe('blocked');
    expect(quality.rounds.map(round => round.status)).toEqual(['changes_requested', 'blocked']);
    expect(quality.findings.some(finding => finding.severity === 'high')).toBe(true);
    expect(result.nativeReceipt?.workflowQuality?.automaticReview).toBe('blocked');
    expect(saved.nativeTask?.verification).toBe('unverified');
    await assertRealQuality(f.data, quality);
    await expect(page.getByRole('region', { name: 'Native 工作流质量审查', exact: true })).toHaveAttribute('data-quality-status', 'blocked');
    expect(await fs.readFile(path.join(f.cwd, 'fixture.txt'), 'utf8')).toBe('broken\n');
    await expect.poll(() => childrenCount(app)).toBe(0);
  } finally { await closeNativeApp(app); await fixture.close(); await f.dispose(); }
});

test('an explicit adversarial read-only WorkflowEngine stage completes only with real static quality and a current final fingerprint', async () => {
  test.info().setTimeout(120000);
  const f = await workspace('static workflow delivery\n');
  const fixture: Fixture = await startResponsesFixture({ assertReplay: false, handler: ({ body }: { body: Body }) => {
    if (qualityRole(body)) return qualityResponse(body, 'static');
    expect(goal(body)).toContain('你正在执行工作流');
    expect(body.tools.some(tool => ['apply_patch', 'run_command', 'start_command', 'delegate_implement', 'submit_quality_report'].includes(tool.name))).toBe(false);
    const done = results(body);
    if (!done.has('parent-plan')) return parentPlan();
    if (!done.has('parent-read')) return call('parent-read', 'read_file', { path: 'fixture.txt' });
    return final('workflow-static-final', '读取 fixture.txt 后确认第一行是 static workflow delivery；本次仅静态材料检查，未执行命令，人工验收未发起。');
  } });
  const app = await f.launch();
  try {
    const page = await ready(app), session = await configure(page, f.projectId, fixture.baseURL);
    await page.getByRole('button', { name: '工作流', exact: true }).click();
    const created = await page.evaluate(sessionId => window.desktop.createWorkflow({ sessionId, title: 'Static adversarial engine delivery',
      goal: '静态分析 `fixture.txt` 的内容并提供有来源的交付总结；保持项目文件不变。', collaboration: 'adversarial',
      pauseAfterEachStage: false, maxAttempts: 1, stages: [{ id: 'static-delivery', title: '静态交付', gate: 'none',
        instruction: '实际读取 fixture.txt，核对第一行并输出静态结论及验证限制。', toolPolicy: 'read_only' }] }), session.id);
    const run = page.locator('.workflow-run');
    await expect(run).toHaveCount(1); await run.getByRole('button', { name: '开始', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(id => window.desktop.workflows(id), session.id)).find(item => item.id === created.id)?.status,
      { timeout: 25000 }).toBe('completed');
    const completed = (await page.evaluate(id => window.desktop.workflows(id), session.id)).find(item => item.id === created.id)!;
    expect(completed.collaboration).toBe('adversarial'); expect(completed.stages[0].status).toBe('completed'); expect(completed.stages[0].attempts).toBe(1);
    const receipt = completed.stages[0].nativeReceipts![0], quality = receipt.workflowQuality!;
    expect(quality.collaboration).toBe('adversarial'); expect(quality.validationMode).toBe('static'); expect(quality.status).toBe('passed');
    expect(quality.round).toBe(1); expect(quality.rounds[0].roles).toHaveLength(3);
    expect(receipt.workspace?.complete).toBe(true); expect(receipt.workspace?.fingerprint).toBe(quality.workspaceFingerprint);
    const saved = await snapshot(page, session.id);
    expect(saved.nativeTask?.execution).toBe('ended'); expect(saved.nativeTask?.verification).toBe('unverified');
    expect(saved.nativeTask?.workspace?.current.complete).toBe(true);
    expect(saved.nativeTask?.workspace?.current.fingerprint).toBe(quality.workspaceFingerprint);
    expect(saved.nativeTask?.taskId).toBe(receipt.taskId);
    await assertRealQuality(f.data, quality);
    const raw = await fs.readFile(path.join(f.data, 'native', 'conversations', receipt.identity.conversationId, 'journal.jsonl'), 'utf8');
    const events = raw.trim().split('\n').map(line => JSON.parse(line).event);
    const started = events.find(event => event.type === 'run_started');
    expect(started.request.configuration.nativeExecutionPolicy).toEqual({ toolPolicy: 'read_only', collaboration: 'adversarial', qualityValidation: 'static' });
    expect(completed.usage?.recordedExecutionIds).toEqual([receipt.identity.runId]);
    expect(completed.usage?.modelRequests).toBe(fixture.requests.length); expect(fixture.errors).toEqual([]);
    expect(await fs.readFile(path.join(f.cwd, 'fixture.txt'), 'utf8')).toBe('static workflow delivery\n');
    await page.getByRole('button', { name: /^已结束（/u }).click();
    await expect(run.locator('> header .status-tag')).toHaveText('已完成');
    await run.getByText('执行成果与验证记录', { exact: true }).click();
    await expect(run.getByRole('region', { name: 'Native 工作流质量审查', exact: true })).toHaveAttribute('data-quality-status', 'passed');
    await expect.poll(() => childrenCount(app)).toBe(0);
    const requestCount = fixture.requests.length;
    await closeNativeApp(app);
    const reopened = await f.launch();
    try {
      const reopenedPage = await ready(reopened);
      const restored = (await reopenedPage.evaluate(id => window.desktop.workflows(id), session.id)).find(item => item.id === created.id)!;
      expect(restored.status).toBe('completed'); expect(restored.stages[0].nativeReceipts?.[0].workflowQuality).toEqual(quality);
      expect((await snapshot(reopenedPage, session.id)).nativeWorkflowQuality).toEqual(quality);
      expect(fixture.requests).toHaveLength(requestCount);
    } finally { await closeNativeApp(reopened); }
  } finally { await closeNativeApp(app); await fixture.close(); await f.dispose(); }
});
