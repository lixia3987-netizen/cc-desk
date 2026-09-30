import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { desktopRoot } from './helpers/paths';
import { electronLaunchArgs } from './helpers/electron-launch';
import { closeNativeApp as cleanupApp } from './helpers/native-app-cleanup';
import type { NativeConnectionView } from '../src/shared/native-connections';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
// @ts-expect-error The same executable JS HTTP fixture is shared with agent-node tests.
import { assistantMessage, functionCall, startResponsesFixture } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

interface Fixture { baseURL: string; requests: Array<Record<string, unknown>>; errors: unknown[]; close(): Promise<void> }
const sentinel = 'sk-native-electron-dummy-DO-NOT-PERSIST';

async function workspace() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-native-电子 空格-'));
  const data = path.join(directory, '应用 数据'), cwd = path.join(directory, '项目 空格');
  await fs.mkdir(data); await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, 'fixture.txt'), 'before native\n');
  await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'Read fixture.txt before making an approved update.\n');
  const projectId = randomUUID();
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify({ version: 3, projects: [
    { id: projectId, name: '真实 native 项目', path: cwd, createdAt: new Date().toISOString() },
  ], sessions: [], settings: { claudePath: path.join(directory, 'missing-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000, engineDefaults: {} } }));
  return { directory, data, cwd, projectId,
    launch: () => electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot, env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data, OPENAI_API_KEY: sentinel } }),
    dispose: () => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}
async function connection(page: Page, baseURL: string): Promise<NativeConnectionView> {
  return page.evaluate(async ({ baseURL, secret }) => {
    const item = await window.desktop.nativeConnections.upsert({ name: '本地 Responses fixture', protocol: 'responses', baseURL, model: 'fixture-model', allowLoopbackHttp: true, enabled: true, auth: { mode: 'memory' } });
    return window.desktop.nativeConnections.setCredential({ id: item.id, revision: item.revision, mode: 'memory', secret });
  }, { baseURL, secret: sentinel });
}
async function nativeSession(page: Page, projectId: string, connectionId: string, title = '真实 Native Worker') {
  return page.evaluate(async ({ projectId, connectionId, title }) => {
    const session = await window.desktop.createSession({ projectId, title, kind: 'agent', providerId: 'native', mode: 'structured', isolated: false,
      engineConfig: { schemaVersion: 1, options: { connectionId, model: '' } } });
    await window.desktop.setSelection(session.id);
    return session;
  }, { projectId, connectionId, title });
}
async function pendingTool(page: Page, sessionId: string, name: string) {
  await expect.poll(() => page.evaluate(async ({ sessionId, name }) => (await window.desktop.chatSnapshot(sessionId)).pending.find(item => item.toolName === name)?.requestId, { sessionId, name })).toBeTruthy();
  return page.evaluate(async ({ sessionId, name }) => (await window.desktop.chatSnapshot(sessionId)).pending.find(item => item.toolName === name)!.requestId, { sessionId, name });
}
async function readyWindow(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  // firstWindow can resolve while the initial about:blank document is alive.
  // The workspace exists only after navigation, preload, and the state snapshot.
  await expect(page.locator('main.workspace')).toBeVisible();
  return page;
}
async function noSavedSecret(directory: string): Promise<void> {
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) await noSavedSecret(file);
    else if (/\.(json|jsonl|ndjson)$/.test(item.name)) expect(await fs.readFile(file, 'utf8')).not.toContain(sentinel);
  }
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test('native utilityProcess completes approved patch/command, persists selected project Skills, survives restart and deduplicates submission', async () => {
  const f = await workspace();
  const claudeRule = 'CLAUDE_NATIVE_RULE_V1: preserve the existing fixture workflow.';
  const updatedClaudeRule = 'CLAUDE_NATIVE_RULE_V2: continue only from the recorded tool results.';
  const agentsRule = 'AGENTS_NATIVE_RULE: require approval before modifying fixture.txt.';
  const agentSkillPath = '.agents/skills/native-review/SKILL.md';
  const claudeSkillPath = '.claude/skills/native-review/SKILL.md';
  const agentSkill = 'AGENTS_SKILL_SELECTED: preserve unrelated file contents during the approved fixture workflow.';
  const claudeSkill = 'CLAUDE_SKILL_SELECTED: report the recorded command outcome after completing the fixture workflow.';
  const unselectedSkill = 'UNSELECTED_SKILL_MUST_NOT_REACH_MODEL';
  for (const [relative, content] of [[agentSkillPath, agentSkill], [claudeSkillPath, claudeSkill], ['.agents/skills/unselected/SKILL.md', unselectedSkill]]) {
    const file = path.join(f.cwd, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${content}\n`);
  }
  await fs.writeFile(path.join(f.cwd, 'CLAUDE.md'), `${claudeRule}\n`);
  await fs.appendFile(path.join(f.cwd, 'AGENTS.md'), `${agentsRule}\n`);
  const expectProjectInstructions = (request: Record<string, unknown>, expectedClaudeRule: string) => {
    expect(typeof request.instructions).toBe('string');
    const instructions = request.instructions as string;
    expect(instructions).toContain(expectedClaudeRule);
    expect(instructions).toContain(agentsRule);
    expect(instructions.indexOf(expectedClaudeRule)).toBeLessThan(instructions.indexOf(agentsRule));
    expect(instructions).toContain(agentSkill);
    expect(instructions).toContain(claudeSkill);
    expect(instructions).not.toContain(unselectedSkill);
  };
  // process.execPath here is the Playwright Node host, never Electron's GUI binary.
  const fixture: Fixture = await startResponsesFixture({ task: { path: 'fixture.txt', content: 'native Electron fixture complete\n', command: {
    executable: process.execPath, argv: ['-e', 'if(process.env.OPENAI_API_KEY)process.exit(31);require("node:fs").writeFileSync("command-marker.txt","command-ok");process.stdout.write("native-command-ok")'], cwd: '.',
  } } });
  let app = await f.launch();
  try {
    let page = await readyWindow(app);
    const configured = await connection(page, fixture.baseURL);
    const session = await nativeSession(page, f.projectId, configured.id);
    const skills = page.getByRole('region', { name: '项目 Skills', exact: true });
    await expect(skills).toBeVisible();
    await expect(skills.getByRole('checkbox')).toHaveCount(0);
    await skills.getByRole('button', { name: '读取项目 Skills', exact: true }).click();
    await expect(skills.getByRole('checkbox', { name: agentSkillPath, exact: true })).not.toBeChecked();
    await expect(skills.getByRole('checkbox', { name: claudeSkillPath, exact: true })).not.toBeChecked();
    // Same directory names under the two roots are distinct UI choices. Only clicks select them.
    await skills.getByRole('checkbox', { name: agentSkillPath, exact: true }).check();
    await skills.getByRole('checkbox', { name: claudeSkillPath, exact: true }).check();
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect.poll(() => page.evaluate(async id => (await window.desktop.snapshot()).state.sessions.find(item => item.id === id)?.engineConfig.options.projectSkills, session.id)).toEqual([agentSkillPath, claudeSkillPath]);
    expect(fixture.requests).toHaveLength(0);
    const requestId = randomUUID(), text = 'Read the file, apply the approved update, then run the approved command.';
    const result = page.evaluate(({ id, text, requestId }) => window.desktop.sendChat(id, text, [], requestId), { id: session.id, text, requestId });
    await pendingTool(page, session.id, 'apply_patch');
    await expect(page.getByRole('region', { name: '工具审批' })).toContainText('apply_patch');
    expect(await fs.readFile(path.join(f.cwd, 'fixture.txt'), 'utf8')).toBe('before native\n');
    expect(await app.evaluate(({ app }) => app.getAppMetrics().some(metric => metric.serviceName === 'cc-desk native agent' || metric.name === 'cc-desk native agent'))).toBe(true);
    await expect(page.getByLabel('会话模型连接', { exact: true })).toBeDisabled();
    await expect(skills.getByRole('checkbox', { name: agentSkillPath, exact: true })).toBeDisabled();
    await expect(skills.getByRole('button', { name: '刷新项目 Skills', exact: true })).toBeDisabled();
    const competing = await page.evaluate(projectId => window.desktop.createSession({ projectId, title: '同目录 Shell', kind: 'shell', providerId: 'shell', mode: 'terminal', isolated: false }), f.projectId);
    await expect(page.evaluate(id => window.desktop.startSession(id), competing.id)).rejects.toThrow(/目录|占用/);
    await expect(page.evaluate(item => window.desktop.nativeConnections.setCredential({ id: item.id, revision: item.revision, mode: 'memory', secret: 'cannot-change-active' }), configured)).rejects.toThrow(/运行|停止/);
    await page.getByRole('button', { name: '允许本次', exact: true }).click();
    await pendingTool(page, session.id, 'run_command');
    await expect(page.getByRole('region', { name: '工具审批' })).toContainText('run_command');
    await page.getByRole('button', { name: '允许本次', exact: true }).click();
    expect((await result).success).toBe(true);
    expect(await fs.readFile(path.join(f.cwd, 'fixture.txt'), 'utf8')).toBe('native Electron fixture complete\n');
    expect(await fs.readFile(path.join(f.cwd, 'command-marker.txt'), 'utf8')).toBe('command-ok');
    await expect(page.locator('.chat-message.assistant').last()).toContainText('本地任务完成');
    expect(fixture.errors).toEqual([]);
    const count = fixture.requests.length;
    for (const request of fixture.requests) expectProjectInstructions(request, claudeRule);
    const duplicate = await page.evaluate(({ id, text, requestId }) => window.desktop.sendChat(id, text, [], requestId), { id: session.id, text, requestId });
    expect(duplicate.success).toBe(true); expect(fixture.requests).toHaveLength(count);
    await noSavedSecret(f.data);
    await cleanupApp(app); app = await f.launch(); page = await readyWindow(app);
    await page.evaluate(id => window.desktop.setSelection(id), session.id);
    await expect(page.locator('.chat-message.assistant').last()).toContainText('本地任务完成');
    const restoredSkills = page.getByRole('region', { name: '项目 Skills', exact: true });
    await expect(restoredSkills.getByRole('checkbox', { name: agentSkillPath, exact: true })).toBeChecked();
    await expect(restoredSkills.getByRole('checkbox', { name: claudeSkillPath, exact: true })).toBeChecked();
    await expect(restoredSkills.getByRole('button', { name: '读取项目 Skills', exact: true })).toBeVisible();
    expect(await page.evaluate(async id => (await window.desktop.snapshot()).state.sessions.find(item => item.id === id)?.engineConfig.options.projectSkills, session.id)).toEqual([agentSkillPath, claudeSkillPath]);
    const restarted = await page.evaluate(async () => (await window.desktop.nativeConnections.list()).connections[0]);
    expect(restarted.credentialConfigured).toBe(false);
    // A durable receipt may be queried without restoring a credential or starting a worker.
    const recoveredReceipt = await page.evaluate(({ id, text, requestId }) => window.desktop.sendChat(id, text, [], requestId), { id: session.id, text, requestId });
    expect(recoveredReceipt.success).toBe(true); expect(fixture.requests).toHaveLength(count);
    // A new turn must reread both files, including edits made after a clean app restart.
    await fs.writeFile(path.join(f.cwd, 'CLAUDE.md'), `${updatedClaudeRule}\n`);
    await page.evaluate(({ item, secret }) => window.desktop.nativeConnections.setCredential({ id: item.id, revision: item.revision, mode: 'memory', secret }), { item: restarted, secret: sentinel });
    // An idle Shell terminal still owns the directory; stopping it releases that lease.
    await page.evaluate(id => window.desktop.startSession(id), competing.id);
    await expect(page.evaluate(id => window.desktop.sendChat(id, 'continue while shell owns directory'), session.id)).rejects.toThrow(/目录|占用/);
    expect(fixture.requests).toHaveLength(count);
    await page.evaluate(id => window.desktop.stopSession(id), competing.id);
    const continued = await page.evaluate(id => window.desktop.sendChat(id, 'Continue using the complete prior protocol context.', [], 'after-clean-restart'), session.id);
    expect(continued.success).toBe(true); expect(continued.summary).toContain('完整上下文 2');
    expect(fixture.requests.length).toBe(count + 1); expect(fixture.errors).toEqual([]);
    expectProjectInstructions(fixture.requests[count], updatedClaudeRule);
    expect(fixture.requests[count].instructions).not.toContain(claudeRule);
    await restoredSkills.getByRole('button', { name: '读取项目 Skills', exact: true }).click();
    await restoredSkills.getByRole('checkbox', { name: claudeSkillPath, exact: true }).uncheck();
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect.poll(() => page.evaluate(async id => (await window.desktop.snapshot()).state.sessions.find(item => item.id === id)?.engineConfig.options.projectSkills, session.id)).toEqual([agentSkillPath]);
    expect(fixture.requests).toHaveLength(count + 1);
    await noSavedSecret(f.data);
  } finally { try { await cleanupApp(app); await f.dispose(); } finally { await fixture.close(); } }
});

test('native denial does not write, and missing credentials fail before a model request', async () => {
  const f = await workspace(), fixture: Fixture = await startResponsesFixture();
  const app = await f.launch();
  try {
    const page = await readyWindow(app);
    const empty = await page.evaluate(baseURL => window.desktop.nativeConnections.upsert({ name: '尚未设置凭据', protocol: 'responses', baseURL, model: 'fixture-model', allowLoopbackHttp: true, enabled: true, auth: { mode: 'memory' } }), fixture.baseURL);
    const missing = await nativeSession(page, f.projectId, empty.id, '缺失密钥');
    const missingResult = await page.evaluate(id => window.desktop.sendChat(id, 'must not reach model'), missing.id);
    expect(missingResult.success).toBe(false); expect(missingResult.error).toMatch(/凭据/); expect(fixture.requests).toHaveLength(0);
    const configured = await connection(page, fixture.baseURL), session = await nativeSession(page, f.projectId, configured.id, '拒绝写入');
    const result = page.evaluate(id => window.desktop.sendChat(id, 'Read then request an approved change.'), session.id);
    await pendingTool(page, session.id, 'apply_patch');
    await page.getByRole('button', { name: '拒绝', exact: true }).click();
    expect((await result).success).toBe(true);
    expect(await fs.readFile(path.join(f.cwd, 'fixture.txt'), 'utf8')).toBe('before native\n');
    await expect(page.locator('.chat-message.assistant').last()).toContainText('修改未执行');
    expect(fixture.errors).toEqual([]);
    expect(JSON.stringify(fixture.requests.at(-1)?.input)).toContain('denied');
  } finally { try { await cleanupApp(app); await f.dispose(); } finally { await fixture.close(); } }
});

test('native incremental edit uses approved file identity and exposes measured usage separately from its budget', async () => {
  const f = await workspace();
  const original = 'before native\nkeep this line unchanged\n';
  await fs.writeFile(path.join(f.cwd, 'fixture.txt'), original);
  const fixture: Fixture = await startResponsesFixture({ handler: ({ body }: { body: { input: Array<Record<string, unknown>> } }) => {
    const results = new Map(body.input.filter(item => item.type === 'function_call_output').map(item => [item.call_id, JSON.parse(String(item.output))]));
    const read = results.get('daily_read');
    const edited = results.get('daily_edit');
    const output = !read ? [functionCall('daily_read', 'read_file', { path: 'fixture.txt' })]
      : !edited ? [functionCall('daily_edit', 'edit_file', { path: 'fixture.txt', expectedHash: read.output.hash, oldText: 'before native', newText: 'after native' })]
      : [assistantMessage('daily_complete', `增量编辑完成：${edited.status}`)];
    return { output, usage: { input_tokens: 137, output_tokens: 19, total_tokens: 156 } };
  } });
  const app = await f.launch();
  try {
    const page = await readyWindow(app), configured = await connection(page, fixture.baseURL);
    const session = await nativeSession(page, f.projectId, configured.id, '阶段四增量编辑');
    const inputBudget = page.getByLabel('会话输入预算（估算 tokens）', { exact: true });
    await expect(inputBudget).toHaveValue('64000');
    await inputBudget.fill('1');
    await expect(inputBudget).toHaveAttribute('aria-invalid', 'true');
    await inputBudget.blur();
    await expect(inputBudget).toHaveValue('64000');
    await inputBudget.fill('64010');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect.poll(() => page.evaluate(async id => (await window.desktop.snapshot()).state.sessions.find(item => item.id === id)?.engineConfig.options.maxInputTokens, session.id)).toBe(64_010);
    const result = page.evaluate(id => window.desktop.sendChat(id, 'Replace only the unique before native phrase, preserving the other line.'), session.id);
    await pendingTool(page, session.id, 'edit_file');
    const approval = page.getByRole('region', { name: '工具审批' });
    await expect(approval).toContainText('before native');
    await expect(approval).toContainText('after native');
    expect(await fs.readFile(path.join(f.cwd, 'fixture.txt'), 'utf8')).toBe(original);
    const pending = await page.evaluate(id => window.desktop.chatSnapshot(id), session.id);
    expect(pending.context?.budget?.maxInputTokens).toBe(64_010);
    expect(pending.context?.budget?.estimatedInputTokens).toBeGreaterThan(0);
    await expect(inputBudget).toBeDisabled();
    await expect(page.locator('.context-meter')).toContainText('运行预算');
    await page.getByRole('button', { name: '允许本次', exact: true }).click();
    expect((await result).success).toBe(true);
    expect(await fs.readFile(path.join(f.cwd, 'fixture.txt'), 'utf8')).toBe('after native\nkeep this line unchanged\n');
    const completed = await page.evaluate(id => window.desktop.chatSnapshot(id), session.id);
    expect(completed.context?.inputTokens).toBe(137);
    expect(completed.context?.contextWindow).toBeUndefined();
    expect(completed.context?.budget?.maxInputTokens).toBe(64_010);
    await expect(page.locator('.chat-message.assistant').last()).toContainText('增量编辑完成：completed');
    expect(fixture.requests).toHaveLength(3);
    expect(fixture.errors).toEqual([]);
    await noSavedSecret(f.data);
  } finally { try { await cleanupApp(app); await f.dispose(); } finally { await fixture.close(); } }
});

test('native interruption cancels a live HTTP model request and releases its real worker and directory lease', async () => {
  const f = await workspace(), fixture: Fixture = await startResponsesFixture({ handler: () => ({ hang: true }) });
  const app = await f.launch();
  try {
    const page = await readyWindow(app), configured = await connection(page, fixture.baseURL), session = await nativeSession(page, f.projectId, configured.id);
    const result = page.evaluate(id => window.desktop.sendChat(id, 'Wait for the intentionally hanging local fixture.'), session.id);
    await expect.poll(() => fixture.requests.length).toBe(1);
    await page.evaluate(id => window.desktop.interruptSession(id), session.id);
    const interrupted = await result;
    expect(interrupted.success).toBe(false); expect(interrupted.interrupted).toBe(true);
    await expect.poll(() => app.evaluate(({ app }) => app.getAppMetrics().some(metric => metric.serviceName === 'cc-desk native agent' || metric.name === 'cc-desk native agent'))).toBe(false);
    const shell = await page.evaluate(projectId => window.desktop.createSession({ projectId, title: '清理后 Shell', kind: 'shell', providerId: 'shell', mode: 'terminal', isolated: false }), f.projectId);
    await page.evaluate(id => window.desktop.startSession(id), shell.id);
    expect(await page.evaluate(async id => (await window.desktop.snapshot()).state.sessions.find(item => item.id === id)?.status, shell.id)).toBe('running');
    await page.evaluate(id => window.desktop.stopSession(id), shell.id);
    expect(fixture.errors).toEqual([]);
  } finally { try { await cleanupApp(app); await f.dispose(); } finally { await fixture.close(); } }
});

test('native queue executes two accepted messages in order with distinct durable submission identities', async () => {
  const f = await workspace(), firstResponse = gate();
  const fixture: Fixture = await startResponsesFixture({ handler: async ({ index }: { index: number }) => {
    if (index === 0) await firstResponse.promise;
    return { output: [assistantMessage(`queue_${index}`, `真实 native 队列完成 ${index + 1}`)] };
  } });
  const app = await f.launch();
  try {
    const page = await readyWindow(app), configured = await connection(page, fixture.baseURL), session = await nativeSession(page, f.projectId, configured.id);
    const first = await page.evaluate(id => window.desktop.submitChat(id, '第一个顺序消息', [], 'native-queue-client-one'), session.id);
    await expect.poll(() => fixture.requests.length).toBe(1);
    const second = await page.evaluate(id => window.desktop.submitChat(id, '第二个顺序消息', [], 'native-queue-client-two'), session.id);
    expect(first.messageId).not.toBe(second.messageId);
    const retried = await page.evaluate(id => window.desktop.submitChat(id, '第二个顺序消息', [], 'native-queue-client-two'), session.id);
    expect(retried.messageId).toBe(second.messageId);
    expect(fixture.requests).toHaveLength(1);
    expect(await page.evaluate(async id => (await window.desktop.chatSnapshot(id)).queue?.items.filter(item => item.status === 'queued').map(item => item.text), session.id)).toEqual(['第二个顺序消息']);
    firstResponse.release();
    await expect.poll(() => fixture.requests.length).toBe(2);
    await expect.poll(() => page.evaluate(async id => (await window.desktop.chatSnapshot(id)).queue?.items ?? [], session.id)).toEqual([]);
    await expect(page.locator('.chat-message.assistant').last()).toContainText('队列完成 2');
    const firstUsers = (fixture.requests[0].input as Array<{ role?: string; content?: unknown }>).filter(item => item.role === 'user');
    const nextUsers = (fixture.requests[1].input as Array<{ role?: string; content?: unknown }>).filter(item => item.role === 'user');
    expect(firstUsers).toHaveLength(1); expect(JSON.stringify(firstUsers[0].content)).toContain('第一个顺序消息');
    expect(nextUsers).toHaveLength(2); expect(JSON.stringify(nextUsers[1].content)).toContain('第二个顺序消息');
    expect(fixture.errors).toEqual([]);
    await cleanupApp(app);
    const ledger = await NativeRunStore.open({ rootDirectory: path.join(f.data, 'native', 'conversations'), conversationId: session.execution.conversationId! });
    try {
      const runs = ledger.listRuns();
      expect(runs.map(run => run.identity.requestId)).toEqual([first.messageId, second.messageId]);
      expect(new Set(runs.map(run => run.identity.runId)).size).toBe(2);
      expect(runs.every(run => ledger.lookupSubmission(run.identity.requestId)?.result?.committed)).toBe(true);
    } finally { await ledger.close(); }
  } finally { firstResponse.release(); try { await cleanupApp(app); await f.dispose(); } finally { await fixture.close(); } }
});

test('native automatic workflow crosses two real workers without deadlock and holds the directory across stages', async () => {
  const f = await workspace(), stages = [gate(), gate()];
  const fixture: Fixture = await startResponsesFixture({ handler: async ({ index }: { index: number }) => {
    await stages[index]?.promise;
    return { output: [assistantMessage(`stage_${index}`, `真实 native 工作流阶段 ${index + 1} 已完成`)] };
  } });
  const app = await f.launch();
  try {
    const page = await readyWindow(app), configured = await connection(page, fixture.baseURL), session = await nativeSession(page, f.projectId, configured.id);
    const shell = await page.evaluate(projectId => window.desktop.createSession({ projectId, title: '工作流期间 Shell', kind: 'shell', providerId: 'shell', mode: 'terminal', isolated: false }), f.projectId);
    const run = await page.evaluate(sessionId => window.desktop.createWorkflow({ sessionId, goal: '同一个 native 会话串行完成两阶段', pauseAfterEachStage: false, maxAttempts: 1,
      stages: [{ id: 'first', title: '第一阶段', instruction: '读取上下文后仅回复第一阶段结果。' }, { id: 'second', title: '第二阶段', instruction: '沿用前一阶段完整上下文，仅回复第二阶段结果。', dependsOn: ['first'] }],
    }), session.id);
    await page.evaluate(id => window.desktop.startWorkflow(id), run.id);
    await expect.poll(() => fixture.requests.length).toBe(1);
    await expect(page.evaluate(id => window.desktop.startSession(id), shell.id)).rejects.toThrow(/目录|占用/);
    stages[0].release();
    await expect.poll(() => fixture.requests.length).toBe(2);
    await expect.poll(() => page.evaluate(async id => (await window.desktop.workflows()).find(item => item.id === id)?.stages.map(stage => stage.status), run.id)).toEqual(['completed', 'running']);
    // The workflow's reservation spans worker teardown and the next worker startup.
    await expect(page.evaluate(id => window.desktop.startSession(id), shell.id)).rejects.toThrow(/目录|占用/);
    stages[1].release();
    await expect.poll(() => page.evaluate(async id => (await window.desktop.workflows()).find(item => item.id === id)?.status, run.id)).toBe('completed');
    const finished = await page.evaluate(async id => (await window.desktop.workflows()).find(item => item.id === id)!, run.id);
    expect(finished.stages.map(stage => stage.attempts)).toEqual([1, 1]);
    expect(finished.stages.every(stage => stage.status === 'completed' && stage.artifacts.length > 0)).toBe(true);
    expect(fixture.requests).toHaveLength(2); expect(fixture.errors).toEqual([]);
    await page.evaluate(id => window.desktop.startSession(id), shell.id);
    await page.evaluate(id => window.desktop.stopSession(id), shell.id);
    await cleanupApp(app);
    const ledger = await NativeRunStore.open({ rootDirectory: path.join(f.data, 'native', 'conversations'), conversationId: session.execution.conversationId! });
    try {
      const runs = ledger.listRuns();
      expect(runs.map(item => item.identity.requestId)).toEqual([`workflow:${run.id}:first:1`, `workflow:${run.id}:second:1`]);
      expect(new Set(runs.map(item => item.identity.workerGeneration)).size).toBe(2);
    } finally { await ledger.close(); }
  } finally { stages.forEach(stage => stage.release()); try { await cleanupApp(app); await f.dispose(); } finally { await fixture.close(); } }
});
