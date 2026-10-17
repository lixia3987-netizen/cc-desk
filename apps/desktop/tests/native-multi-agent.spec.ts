import { openChatAssistance } from './helpers/chat-assistance';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { desktopRoot } from './helpers/paths';
import { electronLaunchArgs } from './helpers/electron-launch';
import { captureNativeDiagnostics, closeNativeApp } from './helpers/native-app-cleanup';
import { nativeQueueDiagnosticSources, withNativeQueueDiagnostics } from './helpers/native-queue-diagnostics';
import { NativeTaskStore } from '@cc-desk/agent-node/task-store';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import type { NativeDelegationReceipt } from '../src/main/engines/native/agent-delegation';
import type { ChatTurnResult, NativeAgentResult } from '../src/shared/chat';
import { buildNativeReviewGoal } from '../src/main/engines/native/agent-prompts';
import { nativeDelegationAuditPath, nativeDelegationExecutionPath, nativeDelegationIntervalsOverlap } from '../src/main/engines/native/agent-delegation-audit';
// @ts-expect-error 与 agent-node 回归测试共享这个可执行 HTTP 测试装置。
import { assistantMessage, functionCall, startResponsesFixture } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

const execute = promisify(execFile), secret = 'sk-native-multi-agent-fixture-protected';
interface Item { type?: string; role?: string; content?: string | Array<{ text?: string }>; call_id?: string; output?: string }
interface Body { input: Item[]; tools: Array<{ name: string }>; instructions: string }
interface Response { output?: unknown[]; hang?: boolean }
interface Fixture { baseURL: string; requests: Body[]; errors: unknown[]; close(): Promise<void> }
const toolResults = (body: Body) => new Map(body.input.filter(item => item.type === 'function_call_output')
  .map(item => [item.call_id!, JSON.parse(item.output!) as { status: string; output: {
    result?: NativeAgentResult;
    hash?: string; parentRunId?: string; children?: Array<{ childId: string }> } }]));
const userGoal = (body: Body) => { const content = body.input.find(item => item.role === 'user')?.content;
  return typeof content === 'string' ? content : content?.map(item => item.text ?? '').join('') ?? ''; };
const responseCall = (id: string, name: string, input: unknown): Response => ({ output: [functionCall(id, name, input)] });
const final = (id: string, text: string): Response => ({ output: [assistantMessage(id, text)] });
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

async function workspace() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-native-multi-电子 空格-')));
  const data = path.join(directory, '应用 数据'), cwd = path.join(directory, '项目 空格'), projectId = randomUUID();
  await fs.mkdir(data); await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, 'fixture.txt'), 'committed parent\n');
  await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'Inspect fixture.txt before editing. Preserve parent work and request approval for every write and command.\n');
  await execute('git', ['-C', cwd, 'init', '-b', 'main'], { windowsHide: true });
  await execute('git', ['-C', cwd, 'config', 'user.name', 'Native fixture'], { windowsHide: true });
  await execute('git', ['-C', cwd, 'config', 'user.email', 'native-fixture@localhost'], { windowsHide: true });
  await execute('git', ['-C', cwd, 'config', 'core.autocrlf', 'false'], { windowsHide: true });
  await execute('git', ['-C', cwd, 'add', '--all'], { windowsHide: true });
  await execute('git', ['-C', cwd, 'commit', '-m', 'Fixture baseline'], { windowsHide: true });
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify({ version: 3, projects: [{ id: projectId, name: 'Native 多 Agent 项目', path: cwd, createdAt: new Date().toISOString() }],
    sessions: [], settings: { claudePath: path.join(directory, 'missing-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000, engineDefaults: {} } }));
  return { directory, data, cwd, projectId,
    launch: async () => captureNativeDiagnostics(await electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot, env: { ...process.env, WORKBENCH_TEST_MODE: '1', CC_DESK_CHAT_PERF: '1', WORKBENCH_DATA_DIR: data } })),
    dispose: () => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}
async function ready(app: ElectronApplication) { const page = await app.firstWindow(); await expect(page.locator('main.workspace')).toBeVisible(); return page; }
async function configure(page: Page, projectId: string, baseURL: string, maxModelRequests = 30) {
  return page.evaluate(async ({ projectId, baseURL, secret, maxModelRequests }) => {
    const initial = await window.desktop.nativeConnections.upsert({ name: 'Native delegation fixture', protocol: 'responses', baseURL, model: 'fixture-model',
      enabled: true, allowLoopbackHttp: true, auth: { mode: 'memory' } });
    const connection = await window.desktop.nativeConnections.setCredential({ id: initial.id, revision: initial.revision, mode: 'memory', secret });
    const session = await window.desktop.createSession({ projectId, title: 'Native 多 Agent 生产链路', kind: 'agent', providerId: 'native', mode: 'structured', isolated: false,
      engineConfig: { schemaVersion: 1, options: { connectionId: connection.id, model: '', maxModelRequests, maxToolCalls: 60, maxActiveMs: 120000 } } });
    await window.desktop.setSelection(session.id); return session;
  }, { projectId, baseURL, secret, maxModelRequests });
}
const snapshot = (page: Page, id: string) => page.evaluate(id => window.desktop.chatSnapshot(id), id);
async function receipts(directory: string): Promise<NativeDelegationReceipt[]> {
  const results: NativeDelegationReceipt[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) results.push(...await receipts(target));
    else if (entry.isFile() && entry.name === 'receipt.json') {
      const value = JSON.parse(await fs.readFile(target, 'utf8')) as NativeDelegationReceipt;
      if (value.version === 1 && value.childId && value.parentIdentity) results.push(value);
    }
  }
  return results;
}
/** Failure-only metadata: never attach model output, tool arguments or checkpoint context. */
async function childJournalDiagnostics(dataDirectory: string, children: NativeDelegationReceipt[]) {
  return Promise.all(children.map(async child => {
    const directory = path.join(dataDirectory, 'native', 'conversations', child.identity.conversationId);
    const summary = { childId: child.childId, runId: child.identity.runId, status: child.status,
      actor: child.goal.startsWith('IMPLEMENT_A') ? 'child-a' : child.goal.startsWith('IMPLEMENT_B') ? 'child-b' : 'unknown-child' };
    const token = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_:-]{1,160}$/.test(value) ? value : undefined;
    const time = (value: unknown) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value) ? value : undefined;
    const checkpointSeq = await fs.readFile(path.join(directory, 'checkpoint.json'), 'utf8').then(raw => {
      const seq: unknown = JSON.parse(raw).seq; return Number.isSafeInteger(seq) ? seq as number : null;
    }).catch(() => null);
    try {
      const handle = await fs.open(path.join(directory, 'journal.jsonl'), 'r');
      let raw: string;
      try {
        const size = (await handle.stat()).size, start = Math.max(0, size - 128 * 1024), buffer = Buffer.alloc(size - start);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, start + offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        raw = buffer.subarray(0, offset).toString('utf8');
        if (start) raw = raw.slice(raw.indexOf('\n') + 1);
      } finally { await handle.close(); }
      const tail = raw.trimEnd().split('\n').filter(Boolean).slice(-10).map(line => {
        try {
          const record = JSON.parse(line), event = record.event ?? {};
          const call = event.call ?? event.prepared?.call ?? event.response?.toolCalls?.[0];
          return { seq: Number.isSafeInteger(record.seq) ? record.seq as number : undefined, type: token(event.type),
            callId: token(call?.id), toolName: token(call?.name), status: token(event.result?.status ?? event.response?.finishReason ?? event.diagnostic?.phase),
            at: time(record.committedAt) };
        } catch { return { type: 'incomplete_record' }; }
      });
      return { ...summary, checkpointSeq, tail };
    } catch { return { ...summary, checkpointSeq, unavailable: true }; }
  }));
}
async function childrenMetrics(app: ElectronApplication) {
  return app.evaluate(({ app }) => app.getAppMetrics().filter(metric => metric.serviceName === 'cc-desk native agent' || metric.name === 'cc-desk native agent').length);
}
async function waitForChildren(started: Set<string>, page: Page, sessionId: string, fixture: Fixture, dataDirectory: string, pending?: Promise<ChatTurnResult>) {
  let parentCompletion: { settled: boolean; result?: ChatTurnResult; error?: string } = { settled: false };
  // Observe settlement without ever waiting for a still-running parent in the failure path.
  void pending?.then(result => { parentCompletion = { settled: true, result }; }, error => { parentCompletion = { settled: true, error: String(error) }; });
  try {
    await expect.poll(() => {
      if (started.size < 2 && parentCompletion.settled) throw new Error(('Parent turn settled before both children started: ' +
        JSON.stringify({ parentCompletion, fixtureErrors: fixture.errors.map(String) })).replaceAll(secret, '[redacted]'));
      return started.size;
    }, { timeout: 15000 }).toBe(2);
  }
  catch (error) {
    const saved = await snapshot(page, sessionId).catch(error => ({ error: String(error) }));
    const childReceipts = await receipts(dataDirectory).catch(error => ({ error: String(error) }));
    const diagnostic = JSON.stringify({ parentCompletion, requests: fixture.requests.length, fixtureErrors: fixture.errors.map(String), snapshot: saved, receipts: childReceipts }, null, 2).replaceAll(secret, '[redacted]');
    await test.info().attach('native-child-launch-diagnostic.json', { body: Buffer.from(diagnostic), contentType: 'application/json' });
    throw error;
  }
}
function parentResponse(body: Body, mode: 'review' | 'implement'): Response {
  const done = toolResults(body);
  if (!done.has('parent-plan')) return responseCall('parent-plan', 'update_plan', { expectedRevision: 0,
    plan: { goal: '委派两个独立子任务并审阅其证据', steps: [{ id: 'delegate', title: '委派与审阅', dependsOn: [], status: 'in_progress' }],
      criteria: [{ id: 'review', description: '审阅子 Agent 结果和验证证据后确认验收', stepIds: ['delegate'], kind: 'manual' }] } });
  if (!done.has('parent-delegate')) return responseCall('parent-delegate', mode === 'review' ? 'delegate_review' : 'delegate_implement', {
    tasks: mode === 'review' ? ['A', 'B'].map(name => ({ title: `独立审阅 ${name}`, goal: `READ_${name}:\n` + buildNativeReviewGoal({
      materials: 'fixture.txt in the selected project', version: 'Not yet read by parent; obtain actual file content and hash using read_file.',
      question: name === 'A' ? 'What exact line does fixture.txt contain?' : 'Does fixture.txt end with a newline?',
      scope: 'Only fixture.txt', evidence: 'No parent file evidence yet; child must obtain and cite its actual read receipt.',
      exclusions: name === 'A' ? 'Do not evaluate newline formatting.' : 'Do not repeat a full text summary.',
    }) })) :
      [{ title: '隔离实现 A', goal: 'IMPLEMENT_A: 独立修改 fixture.txt 并执行检查' }, { title: '隔离实现 B', goal: 'IMPLEMENT_B: 独立修改 fixture.txt 并执行检查' }],
    ...(mode === 'implement' ? { baseline: 'snapshot' } : {}),
  });
  if (mode === 'review') {
    const delegated = done.get('parent-delegate')!;
    for (let index = 0; index < (delegated.output.children?.length ?? 0); index++) {
      if (!done.has(`parent-result-${index}`)) return responseCall(`parent-result-${index}`, 'read_agent_result', {
        parentRunId: delegated.output.parentRunId, childId: delegated.output.children![index].childId });
    }
  }
  return final('parent-final', '子任务已结束，成果和证据已保留，等待审阅验收。');
}

test('native utilityProcess requires missing declared materials before accepting child completion', async () => {
  const f = await workspace(), barrier = gate(), started = new Set<string>(), corrected = new Set<string>();
  await fs.writeFile(path.join(f.cwd, 'review.md'), 'Independent review index for both delegated questions.\n');
  const fixture: Fixture = await startResponsesFixture({ assertReplay: false, handler: async ({ body }: { body: Body }) => {
    const done = toolResults(body);
    if (!body.instructions.includes('independent delegated Native agent')) {
      if (done.has('parent-plan') && !done.has('parent-delegate')) return responseCall('parent-delegate', 'delegate_review', {
        tasks: ['A', 'B'].map(name => ({ title: `Review ${name}`, goal: `READ_${name}:\n` + buildNativeReviewGoal({
          materials: 'files `fixture.txt` and `review.md`', version: 'Current local snapshot; obtain actual read receipts and hashes.',
          question: name === 'A' ? 'What exact line does fixture.txt contain?' : 'Does fixture.txt end with a newline?',
          scope: 'Both declared files', evidence: 'No parent evidence; child must read every declared material.',
          exclusions: name === 'A' ? 'Do not evaluate newline formatting.' : 'Do not repeat a full text summary.',
        }) })),
      });
      return parentResponse(body, 'review');
    }
    const name = userGoal(body).startsWith('READ_A') ? 'a' : 'b';
    expect(body.tools.some(tool => ['apply_patch', 'run_command', 'start_command', 'delegate_review', 'delegate_implement'].includes(tool.name))).toBe(false);
    if (!done.has(`child-${name}-read`)) { started.add(name); await barrier.promise; return responseCall(`child-${name}-read`, 'read_file', { path: 'fixture.txt' }); }
    if (!done.has(`child-${name}-index`)) {
      const last = body.input.filter(item => item.role === 'user').at(-1)?.content;
      const feedback = typeof last === 'string' ? last : last?.map(item => item.text ?? '').join('') ?? '';
      if (!feedback.includes('Host completion validation: declared_material_reads_missing')) return final(`child-${name}-premature`, 'I claim that all declared materials are reviewed.');
      expect(feedback).toContain('["review.md"]');
      expect(feedback).not.toContain('Independent review index for both delegated questions.');
      corrected.add(name);
      return responseCall(`child-${name}-index`, 'read_file', { path: 'review.md' });
    }
    return final(`child-${name}-done`, `Review ${name} updated after the actual index read.`);
  } });
  const app = await f.launch();
  try {
    const page = await ready(app), session = await configure(page, f.projectId, fixture.baseURL);
    const pending = page.evaluate(id => window.desktop.sendChat(id, '请并行分析 fixture.txt 的内容和换行格式，并读取 review.md。', [], 'completion-correction-review'), session.id);
    await waitForChildren(started, page, session.id, fixture, f.data, pending); barrier.release();
    const result = await pending;
    expect(result.success).toBe(true); expect(corrected.size).toBe(2); expect(fixture.errors).toEqual([]);
    expect(fixture.requests).toHaveLength(13); expect(result.nativeReceipt?.usage.modelRequests).toBe(13);
    expect(result.nativeReceipt?.usage.toolCalls).toBe(8);
    const saved = await receipts(f.data); expect(saved).toHaveLength(2);
    const audit = JSON.parse(await fs.readFile(nativeDelegationAuditPath(f.data, saved[0].parentIdentity), 'utf8'));
    expect(audit.status).toBe('satisfied'); expect(audit.batches[0].childrenWithMaterialReads).toBe(2);
    for (const child of saved) {
      expect(child.result?.status).toBe('completed'); expect(child.result?.modelRequests).toBe(4); expect(child.result?.toolCalls).toBe(2);
      const journal = await fs.readFile(child.result!.evidence!.runJournalPath!, 'utf8'); expect(journal).not.toContain(secret);
      const records = journal.trim().split('\n').map(line => JSON.parse(line));
      const rejection = records.find(record => record.event.type === 'completion_rejected');
      expect(rejection.event.attempt).toBe(2); expect(rejection.event.feedback.paths).toEqual(['review.md']);
      const reads = records.filter(record => record.event.type === 'tool_completed' && record.event.call.name === 'read_file');
      expect(reads.map(record => record.event.result.output.path)).toEqual(['fixture.txt', 'review.md']);
      expect(reads[0].seq).toBeLessThan(rejection.seq); expect(rejection.seq).toBeLessThan(reads[1].seq);
      expect(records.filter(record => record.event.type === 'model_response')).toHaveLength(4);
      const reopened = await NativeRunStore.open({ rootDirectory: path.join(f.data, 'native', 'conversations'), conversationId: child.identity.conversationId });
      try { expect(reopened.recoveryRequired).toBe(false); expect(reopened.getRun(child.identity.runId)?.status).toBe('completed'); }
      finally { await reopened.close(); }
    }
    expect(await fs.readFile(path.join(f.cwd, 'fixture.txt'), 'utf8')).toBe('committed parent\n');
    await expect.poll(() => childrenMetrics(app)).toBe(0);
  } finally { barrier.release(); await closeNativeApp(app); await fixture.close(); await f.dispose(); }
});

test('a model role plan or claimed parallel success without actual delegation cannot pass host completion', async () => {
  const f = await workspace();
  const fixture: Fixture = await startResponsesFixture({ assertReplay: false, handler: ({ body }: { body: Body }) => {
    const latest = body.input.filter(item => item.role === 'user').at(-1)?.content;
    const input = typeof latest === 'string' ? latest : latest?.map(item => item.text ?? '').join('') ?? '';
    if (input.includes('只用一个 Agent')) {
      expect(body.tools.some(tool => tool.name.startsWith('delegate_'))).toBe(false);
      return final('single-agent-final', '按单 Agent 约束直接处理本次审阅。');
    }
    return final('unexecuted-plan', 'Agent A 检查内容，Agent B 检查边界。并行分析已完成。');
  } });
  const app = await f.launch();
  try {
    const page = await ready(app), session = await configure(page, f.projectId, fixture.baseURL);
    const result = await page.evaluate(id => window.desktop.sendChat(id, '请并行分析 fixture.txt 的内容和换行格式。', [], 'unexecuted-parallel-request'), session.id);
    expect(result.success).toBe(false); expect(result.error).toContain('没有实际批量只读委派');
    expect(result.summary).toContain('未通过宿主并行核验'); expect(await childrenMetrics(app)).toBe(0);
    expect(await receipts(f.data)).toHaveLength(0); expect(fixture.requests).toHaveLength(1);
    const single = await page.evaluate(id => window.desktop.sendChat(id, '只用一个 Agent 审阅 fixture.txt。', [], 'explicit-single-request'), session.id);
    expect(single.success).toBe(true); expect(await childrenMetrics(app)).toBe(0); expect(fixture.requests).toHaveLength(2);
  } finally { await closeNativeApp(app); await fixture.close(); await f.dispose(); }
});

test('production Native utilityProcesses review concurrently with independent contexts and visible retained child state', async () => {
  const f = await workspace(), barrier = gate(), started = new Set<string>();
  const fixture: Fixture = await startResponsesFixture({ assertReplay: false, handler: async ({ body }: { body: Body }) => {
    if (!body.instructions.includes('independent delegated Native agent')) return parentResponse(body, 'review');
    const goal = userGoal(body), name = goal.startsWith('READ_A') ? 'a' : 'b', done = toolResults(body);
    expect(body.input.filter(item => item.role === 'user')).toHaveLength(1);
    expect(goal).not.toContain('委派两个'); expect(body.tools.some(tool => ['apply_patch', 'run_command', 'delegate_review', 'delegate_implement'].includes(tool.name))).toBe(false);
    if (!done.has(`child-${name}-read`)) { started.add(name); await barrier.promise; return responseCall(`child-${name}-read`, 'read_file', { path: 'fixture.txt' }); }
    return final(`child-${name}-done`, `独立审阅 ${name} 完成，fixture.txt 已读取。`);
  } });
  const app = await f.launch();
  try {
    const page = await ready(app), session = await configure(page, f.projectId, fixture.baseURL);
    const pending = page.evaluate(id => window.desktop.sendChat(id, '委派两个独立只读审阅', [], 'multi-review-request'), session.id);
    await waitForChildren(started, page, session.id, fixture, f.data, pending);
    expect(await childrenMetrics(app)).toBeGreaterThanOrEqual(3);
    await expect.poll(async () => (await snapshot(page, session.id)).nativeAgents?.items.filter(child => child.status === 'running').length).toBe(2);
    await expect(page.getByRole('region', { name: 'Native Agent 协作', exact: true })).toBeHidden();
    await openChatAssistance(page, 'agents');
    await expect(page.getByRole('region', { name: 'Native Agent 协作', exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('native-agent-review.png'), fullPage: true });
    barrier.release(); const result = await pending;
    expect(result.success).toBe(true); expect(fixture.requests).toHaveLength(9); expect(fixture.errors).toEqual([]);
    expect(result.nativeReceipt?.usage.modelRequests).toBe(9); expect(result.nativeReceipt?.usage.toolCalls).toBe(6);
    const saved = await receipts(f.data); expect(saved).toHaveLength(2);
    const execution = JSON.parse(await fs.readFile(nativeDelegationExecutionPath(path.join(f.data, 'native'), saved[0].parentIdentity, saved[0].batchId), 'utf8'));
    expect(nativeDelegationIntervalsOverlap(execution)).toBe(true);
    expect(execution.children.every((child: { started?: unknown; settled?: unknown }) => child.started && child.settled)).toBe(true);
    const audit = JSON.parse(await fs.readFile(nativeDelegationAuditPath(f.data, saved[0].parentIdentity), 'utf8'));
    expect(audit.status).toBe('satisfied'); expect(audit.batches[0].inspectedChildren).toBe(2); expect(audit.batches[0].childrenWithMaterialReads).toBe(2);
    const parentTask = await NativeTaskStore.readSnapshot({ rootDirectory: path.join(f.data, 'native'), conversationId: saved[0].parentIdentity.conversationId, sessionId: session.id });
    expect(parentTask?.taskId).toBe(saved[0].parentTaskId); expect(parentTask?.verification).toBe('unverified');
    expect(new Set(saved.map(child => child.identity.conversationId)).size).toBe(2);
    expect(new Set(saved.map(child => child.identity.runId)).size).toBe(2);
    for (const child of saved) {
      expect(child.status).toBe('completed'); expect(child.mode).toBe('review'); expect(child.result!.toolCalls).toBe(1);
      expect(child.parentIdentity.sessionId).toBe(session.id); expect(child.identity.sessionId).not.toBe(session.id);
      expect(child.result!.evidence!.taskSnapshotPath).toBeTruthy(); expect(child.result!.evidence!.runJournalPath).toBeTruthy();
      expect(await fs.readFile(child.result!.evidence!.runJournalPath!, 'utf8')).not.toContain(secret);
    }
    await expect.poll(async () => (await snapshot(page, session.id)).nativeAgents?.items.filter(child => child.status === 'completed').length).toBe(2);
    await expect.poll(() => childrenMetrics(app)).toBe(0);
    await closeNativeApp(app);
    expect(await receipts(f.data)).toHaveLength(2);
    const reopened = await f.launch();
    try {
      const reopenedPage = await ready(reopened), restored = await snapshot(reopenedPage, session.id);
      expect(restored.nativeAgents?.items).toHaveLength(2);
      expect(restored.nativeAgents!.items.every(child => child.status === 'completed')).toBe(true);
      expect(new Set(restored.nativeAgents!.items.map(child => child.identity.runId))).toEqual(new Set(saved.map(child => child.identity.runId)));
      await openChatAssistance(reopenedPage, 'agents');
      await expect(reopenedPage.getByRole('region', { name: 'Native Agent 协作', exact: true })).toBeVisible();
      expect(await childrenMetrics(reopened)).toBe(0);
    } finally { await closeNativeApp(reopened); }
  } finally { barrier.release(); await closeNativeApp(app); await fixture.close(); await f.dispose(); }
});

test('physical children have independent request allowances while one exhausted child cannot stop the parent', async () => {
  const f = await workspace(), barrier = gate(), started = new Set<string>();
  const fixture: Fixture = await startResponsesFixture({ assertReplay: false, handler: async ({ body }: { body: Body }) => {
    if (!body.instructions.includes('independent delegated Native agent')) return parentResponse(body, 'review');
    const name = userGoal(body).startsWith('READ_A') ? 'a' : 'b', done = toolResults(body);
    if (!done.has(`child-${name}-read`)) { started.add(name); await barrier.promise; return responseCall(`child-${name}-read`, 'read_file', { path: 'fixture.txt' }); }
    if (name === 'a') {
      expect(done.has('child-a-extra-read'), 'the exhausted child cannot issue a third model request').toBe(false);
      return responseCall('child-a-extra-read', 'read_file', { path: 'fixture.txt' });
    }
    return final('child-b-done', '子任务 B 使用自己的额度完成审阅。');
  } });
  const app = await f.launch();
  try {
    const page = await ready(app), session = await configure(page, f.projectId, fixture.baseURL, 2);
    const pending = page.evaluate(id => window.desktop.sendChat(id, '委派两个独立只读审阅，每个子 Agent 独立限制请求次数，失败后继续主任务。', [], 'multi-budget-request'), session.id);
    await waitForChildren(started, page, session.id, fixture, f.data, pending); barrier.release();
    const result = await pending;
    expect(result.success).toBe(true); expect(fixture.requests).toHaveLength(9); expect(fixture.errors).toEqual([]);
    const saved = await receipts(f.data); expect(saved).toHaveLength(2);
    const exhausted = saved.find(child => child.goal.startsWith('READ_A'))!, completed = saved.find(child => child.goal.startsWith('READ_B'))!;
    expect(exhausted.status).toBe('failed'); expect(exhausted.result?.status).toBe('budget_exhausted'); expect(exhausted.result?.committed).toBe(true);
    expect(exhausted.result?.modelRequests).toBe(2); expect(exhausted.result?.toolCalls).toBe(2);
    expect(completed.status).toBe('completed'); expect(completed.result?.committed).toBe(true); expect(completed.result?.modelRequests).toBe(2);
    expect(saved.reduce((sum, child) => sum + child.result!.modelRequests, 0)).toBe(4);
    const parentRequests = fixture.requests.filter(body => !body.instructions.includes('independent delegated Native agent'));
    expect(parentRequests).toHaveLength(5); expect(parentRequests.length).toBeGreaterThan(2);
    expect(toolResults(parentRequests.at(-1)!).get('parent-delegate')?.status).toBe('completed');
    expect(toolResults(parentRequests.at(-1)!).has('parent-result-0')).toBe(true);
    expect(toolResults(parentRequests.at(-1)!).has('parent-result-1')).toBe(true);
    expect(result.nativeReceipt?.usage.modelRequests).toBe(9); expect(result.nativeReceipt?.usage.toolCalls).toBe(7);
    const audit = JSON.parse(await fs.readFile(nativeDelegationAuditPath(f.data, exhausted.parentIdentity), 'utf8'));
    expect(audit.issues).toContain('child_execution_incomplete'); expect(audit.status).not.toBe('satisfied');
    expect(await fs.readFile(path.join(f.cwd, 'fixture.txt'), 'utf8')).toBe('committed parent\n');
    await expect.poll(() => childrenMetrics(app)).toBe(0);
  } finally { barrier.release(); await closeNativeApp(app); await fixture.close(); await f.dispose(); }
});

test('stopping the parent aborts both physical child requests and retains their terminal receipts', async () => {
  const f = await workspace(), started = new Set<string>();
  const fixture: Fixture = await startResponsesFixture({ assertReplay: false, handler: ({ body }: { body: Body }) => {
    if (!body.instructions.includes('independent delegated Native agent')) return parentResponse(body, 'review');
    started.add(userGoal(body)); return { hang: true };
  } });
  const app = await f.launch();
  try {
    const page = await ready(app), session = await configure(page, f.projectId, fixture.baseURL);
    const pending = page.evaluate(id => window.desktop.sendChat(id, '委派并等待两个只读审阅', [], 'multi-cancel-request'), session.id);
    await waitForChildren(started, page, session.id, fixture, f.data, pending); expect(await childrenMetrics(app)).toBeGreaterThanOrEqual(3);
    await page.evaluate(id => window.desktop.stopSession(id), session.id);
    expect((await pending).success).toBe(false);
    await expect.poll(() => childrenMetrics(app)).toBe(0);
    const saved = await receipts(f.data); expect(saved).toHaveLength(2);
    expect(saved.every(child => child.status === 'cancelled' && child.result?.status === 'cancelled' && child.result.committed)).toBe(true);
    expect(fixture.requests).toHaveLength(4); expect(fixture.errors).toEqual([]);
    expect(await fs.readFile(path.join(f.cwd, 'fixture.txt'), 'utf8')).toBe('committed parent\n');
  } finally { await closeNativeApp(app); await fixture.close(); await f.dispose(); }
});

test('physical implementation children inherit an explicit dirty snapshot, approve writes/commands in the parent UI and retain independent worktrees', async () => {
  test.info().setTimeout(120000);
  const f = await workspace(), barrier = gate(), started = new Set<string>();
  let selected: NativeDelegationReceipt | undefined;
  const handoffMarker = '核查保存补丁，并将选定成果写入 integrated-result.txt；保留父工作区原有文件';
  await fs.writeFile(path.join(f.cwd, 'fixture.txt'), 'staged parent draft\n');
  await execute('git', ['-C', f.cwd, 'add', 'fixture.txt'], { windowsHide: true });
  await fs.writeFile(path.join(f.cwd, 'fixture.txt'), 'unstaged parent draft\n');
  await fs.writeFile(path.join(f.cwd, 'parent-untracked.txt'), 'user-owned parent file\n');
  const parentIndex = await fs.readFile(path.join(f.cwd, '.git', 'index')), parentHead = (await execute('git', ['-C', f.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
  const implementationResponse = async ({ body }: { body: Body }): Promise<Response> => {
    if (!body.instructions.includes('independent delegated Native agent')) {
      const done = toolResults(body), latestUser = body.input.filter(item => item.role === 'user').at(-1)?.content;
      const latestGoal = typeof latestUser === 'string' ? latestUser : latestUser?.map(item => item.text ?? '').join('') ?? '';
      if (selected && latestGoal.includes(handoffMarker)) {
        expect(latestGoal).toContain(selected.childId); expect(latestGoal).toContain(selected.parentIdentity.runId);
        expect(latestGoal).toContain(selected.artifact!.sha256!);
        if (!done.has('followup-result')) return responseCall('followup-result', 'read_agent_result', {
          parentRunId: selected.parentIdentity.runId, childId: selected.childId, expectedPatchSha256: selected.artifact!.sha256 });
        const savedResult = done.get('followup-result')!;
        expect(savedResult.status).toBe('completed'); expect(savedResult.output.result?.acceptance).toBe('not_assessed');
        expect(savedResult.output.result?.patch?.integrity).toBe('verified');
        const content = savedResult.output.result!.patch!.text.match(/^\+(child [ab] implementation)$/m)![1] + '\n';
        if (!done.has('parent-integrate')) return responseCall('parent-integrate', 'apply_patch', { path: 'integrated-result.txt', content, expectedHash: null });
        if (!done.has('parent-verify')) return responseCall('parent-verify', 'run_command', { executable: process.execPath, cwd: '.',
          argv: ['-e', `const fs=require('node:fs');if(fs.readFileSync('integrated-result.txt','utf8')!==${JSON.stringify(content)})process.exitCode=8;else process.stdout.write('parent-integration-verified')`], timeoutMs: 10000, maxOutputBytes: 4096 });
        return final('parent-followup-final', '已读取指定历史成果，按审批写入并在父工作区验证，等待人工验收。');
      }
      const delegated = done.get('parent-delegate');
      if (delegated && !done.has('parent-read-result')) return responseCall('parent-read-result', 'read_agent_result', {
        parentRunId: delegated.output.parentRunId, childId: delegated.output.children![0].childId });
      if (done.has('parent-read-result')) {
        expect(done.get('parent-read-result')!.status).toBe('completed');
        expect(done.get('parent-read-result')!.output.result?.patch?.text).toMatch(/child [ab] implementation/);
        expect(done.get('parent-read-result')!.output.result?.acceptance).toBe('not_assessed');
      }
      return parentResponse(body, 'implement');
    }
    const name = userGoal(body).startsWith('IMPLEMENT_A') ? 'a' : 'b', done = toolResults(body), content = `child ${name} implementation\n`;
    if (!done.has(`child-${name}-read`)) { started.add(name); await barrier.promise; return responseCall(`child-${name}-read`, 'read_file', { path: 'fixture.txt' }); }
    if (!done.has(`child-${name}-patch`)) return responseCall(`child-${name}-patch`, 'apply_patch', { path: 'fixture.txt', content, expectedHash: done.get(`child-${name}-read`)!.output.hash });
    if (!done.has(`child-${name}-command`)) return responseCall(`child-${name}-command`, 'run_command', { executable: process.execPath, cwd: '.',
      argv: ['-e', `const fs=require('node:fs');if(fs.readFileSync('fixture.txt','utf8')!==${JSON.stringify(content)})process.exitCode=9;else process.stdout.write('child-${name}-verified')`], timeoutMs: 10000, maxOutputBytes: 4096 });
    return final(`child-${name}-done`, `隔离实现 ${name} 与命令检查已完成，等待审阅。`);
  };
  const requestDiagnostics: Array<{ index: number; actor: string; toolResultIds: string[]; branch: string; receivedAt: string; responseReadyAt?: string }> = [];
  const fixture: Fixture = await startResponsesFixture({ assertReplay: false, handler: async ({ body, index }: { body: Body; index: number }) => {
    const child = body.instructions.includes('independent delegated Native agent');
    const record = { index, actor: child ? userGoal(body).startsWith('IMPLEMENT_A') ? 'child-a' : 'child-b' : 'parent',
      toolResultIds: body.input.filter(item => item.type === 'function_call_output').map(item => item.call_id).filter((id): id is string => typeof id === 'string' && /^[a-zA-Z0-9_:-]{1,160}$/.test(id)),
      branch: 'handler_pending', receivedAt: new Date().toISOString(), responseReadyAt: undefined as string | undefined };
    requestDiagnostics.push(record);
    try {
      const response = await implementationResponse({ body });
      const call = response.output?.find((item): item is { type: string; name: string } => Boolean(item && typeof item === 'object' && 'type' in item && item.type === 'function_call' && 'name' in item && typeof item.name === 'string'));
      record.branch = call?.name ?? 'final';
      return response;
    } catch (error) { record.branch = 'handler_failed'; throw error; }
    finally { record.responseReadyAt = new Date().toISOString(); }
  } });
  const app = await f.launch();
  try {
    const page = await ready(app), session = await configure(page, f.projectId, fixture.baseURL);
    const initialDiagnostics = nativeQueueDiagnosticSources({ app, page, dataDirectory: f.data, sessionId: session.id, fixture });
    const initialTiming: Record<string, number | readonly number[] | undefined> = {};
    const initialClock = performance.now();
    const pending = page.evaluate(id => window.desktop.sendChat(id, '从当前未提交修改快照委派两个独立实现，不自动合并', [], 'multi-implement-request'), session.id);
    let parentCompletion: { settled: boolean; success?: boolean; interrupted?: boolean; error?: string } = { settled: false };
    void pending.then(result => { parentCompletion = { settled: true, success: result.success, interrupted: result.interrupted, error: result.error }; },
      error => { parentCompletion = { settled: true, error: String(error) }; });
    let initialApprovalId: string | undefined, phase = 'initial_host_approval';
    try {
      // #21's trace returned a valid approval at send+6.119s, after the generic
      // 5s poll expired. This phase includes worker startup, two responses and
      // the dirty baseline's Git checks; readiness is not a snapshot-I/O timer.
      // Preserve the 15s readiness requirement. When it fails, collect the
      // parent's bounded journal/process evidence before snapshot hydration;
      // response-ready timestamps alone cannot identify which host phase stalled.
      await withNativeQueueDiagnostics(async () => {
        initialTiming.approvalWaitStartedElapsedMs = performance.now() - initialClock;
        try {
          await expect.poll(async () => {
            initialApprovalId = await page.evaluate(async id => (await window.desktop.chatAttention())
              .find(item => item.sessionId === id && item.toolName === 'delegate_implement')?.requestId, session.id);
            if (!initialApprovalId && parentCompletion.settled) throw new Error('Parent settled before delegation approval: ' + JSON.stringify(parentCompletion));
            return initialApprovalId;
          }, { timeout: 15000 }).toBeTruthy();
        } finally { initialTiming.approvalWaitSettledElapsedMs = performance.now() - initialClock; }
      }, { phase: 'initial-delegation-approval', conversationId: session.execution.conversationId!, sources: initialDiagnostics,
        timing: initialTiming, attach: (name, options) => test.info().attach(name, options) });
      phase = 'initial_ui_approval';
      const approval = page.getByRole('region', { name: '工具审批' });
      await expect(approval).toHaveAttribute('data-request-id', initialApprovalId!);
      await expect(approval).toContainText('snapshot');
    } catch (error) {
      const diagnostic = JSON.stringify({ phase, parentCompletion, initialApprovalId, requests: fixture.requests.length,
        fixtureErrors: fixture.errors.length, requestDiagnostics: requestDiagnostics.slice(-64),
        omittedRequests: Math.max(0, requestDiagnostics.length - 64) }, null, 2).replaceAll(secret, '[redacted]');
      await test.info().attach('native-initial-delegation-diagnostic.json', { body: Buffer.from(diagnostic), contentType: 'application/json' });
      throw error;
    }
    await page.getByRole('button', { name: '允许本次', exact: true }).click();
    await waitForChildren(started, page, session.id, fixture, f.data, pending); expect(await childrenMetrics(app)).toBeGreaterThanOrEqual(3);
    expect(await fs.readFile(path.join(f.cwd, 'fixture.txt'), 'utf8')).toBe('unstaged parent draft\n'); barrier.release();
    const approvals: string[] = [], approvedRequests = new Set<string>();
    for (let i = 0; i < 4; i++) {
      try { await expect.poll(async () => (await snapshot(page, session.id)).pending.find(item => ['apply_patch', 'run_command'].includes(item.toolName ?? '') && !approvedRequests.has(item.requestId))?.requestId).toBeTruthy(); }
      catch (error) {
        const live = await page.evaluate(async id => {
          const [snapshot, attention] = await Promise.all([window.desktop.chatSnapshot(id), window.desktop.chatAttention()]);
          return { at: new Date().toISOString(), attention: attention.filter(item => item.sessionId === id)
            .map(item => ({ sessionId: item.sessionId, requestId: item.requestId, kind: item.kind, toolName: item.toolName, createdAt: item.createdAt })),
            snapshot: { taskState: snapshot.taskState, sessionStatus: snapshot.sessionStatus, version: snapshot.version,
              pending: snapshot.pending.map(item => ({ requestId: item.requestId, toolUseId: item.toolUseId, toolName: item.toolName, kind: item.kind, createdAt: item.createdAt,
                ...(item.nativeDelegation ? { childRunId: item.nativeDelegation.runId } : {}) })),
              children: snapshot.nativeAgents?.items.map(item => ({ childId: item.childId, runId: item.identity.runId, status: item.status, updatedAt: item.updatedAt })) } };
        }, session.id).catch(() => ({ unavailable: true }));
        const children = await receipts(f.data).catch(() => []);
        const diagnostic = JSON.stringify({ approved: approvals, requests: fixture.requests.length, fixtureErrors: fixture.errors.length,
          requestDiagnostics: requestDiagnostics.slice(-64), omittedRequests: Math.max(0, requestDiagnostics.length - 64),
          live, children: await childJournalDiagnostics(f.data, children) }, null, 2).replaceAll(secret, '[redacted]');
        await test.info().attach('native-child-approval-diagnostic.json', { body: Buffer.from(diagnostic), contentType: 'application/json' });
        throw error;
      }
      const request = (await snapshot(page, session.id)).pending.find(item => ['apply_patch', 'run_command'].includes(item.toolName ?? '') && !approvedRequests.has(item.requestId))!;
      approvedRequests.add(request.requestId); approvals.push(request.toolName!);
      const approval = page.getByRole('region', { name: '工具审批' });
      await expect(approval).toHaveAttribute('data-request-id', request.requestId);
      await expect(approval).toContainText(request.toolName!);
      const child = request.nativeDelegation!;
      expect(child).toBeTruthy();
      await expect(approval.getByRole('region', { name: '子 Agent 操作范围' })).toContainText(child.title);
      await expect(approval).toContainText(child.cwd);
      if (i === 0) {
        await expect(page.getByRole('button', { name: /^子 Agent ·/ })).toHaveAttribute('aria-expanded', 'false');
        await approval.evaluate(element => element.scrollIntoView({ block: 'start' }));
        await page.screenshot({ path: test.info().outputPath('native-agent-child-approval.png'), fullPage: true });
      }
      await approval.getByRole('button', { name: '允许本次', exact: true }).click();
    }
    const result = await pending; expect(result.success).toBe(true); expect(fixture.errors).toEqual([]);
    expect(approvals.filter(name => name === 'apply_patch')).toHaveLength(2); expect(approvals.filter(name => name === 'run_command')).toHaveLength(2);
    const saved = await receipts(f.data); expect(saved).toHaveLength(2);
    expect(new Set(saved.map(child => child.workspace!.path)).size).toBe(2); expect(new Set(saved.map(child => child.workspace!.baseCommit)).size).toBe(1);
    for (const child of saved) {
      const name = child.goal.startsWith('IMPLEMENT_A') ? 'a' : 'b';
      expect(child.status).toBe('completed'); expect(child.workspaceVerified).toBe(true); expect(child.workspace!.baseline).toBe('snapshot');
      expect(child.workspace!.parentHead).toBe(parentHead); expect(child.workspace!.baseCommit).not.toBe(parentHead); expect(child.workspace!.branch).toMatch(/^codex\/native-agent-/);
      expect(await fs.readFile(path.join(child.workspace!.cwd, 'fixture.txt'), 'utf8')).toBe(`child ${name} implementation\n`);
      expect(await fs.readFile(path.join(child.workspace!.cwd, 'parent-untracked.txt'), 'utf8')).toBe('user-owned parent file\n');
      expect(await fs.readFile(child.artifact!.patchPath, 'utf8')).toContain(`child ${name} implementation`);
      expect(child.result!.evidence!.commandReceipts).toHaveLength(1); expect(child.result!.evidence!.commandReceipts![0].exitCode).toBe(0);
    }
    expect(await fs.readFile(path.join(f.cwd, '.git', 'index'))).toEqual(parentIndex);
    expect((await execute('git', ['-C', f.cwd, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(parentHead);
    expect((await execute('git', ['-C', f.cwd, 'branch', '--show-current'])).stdout.trim()).toBe('main');
    expect(await fs.readFile(path.join(f.cwd, 'fixture.txt'), 'utf8')).toBe('unstaged parent draft\n');
    await openChatAssistance(page, 'agents');
    const childPane = page.locator(`[data-agent-id="${saved[0].childId}"]`);
    await childPane.locator(':scope > summary').click();
    await childPane.getByRole('link', { name: '隔离工作区', exact: true }).click();
    await childPane.getByRole('button', { name: '复制隔离工作区路径', exact: true }).click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(saved[0].workspace!.path);
    await page.screenshot({ path: test.info().outputPath('native-agent-worktree-result.png'), fullPage: true });
    selected = saved[0];
    const requestCount = fixture.requests.length;
    const composer = page.getByRole('textbox', { name: '提示词编辑器', exact: true });
    await composer.fill('人工补充：保留已有草稿。');
    await childPane.getByRole('button', { name: '查看保存成果', exact: true }).click();
    const viewer = page.getByRole('dialog', { name: '子 Agent 保存成果', exact: true });
    await expect(viewer.getByLabel('保存补丁内容', { exact: true })).toContainText(/child [ab] implementation/);
    await expect(viewer).toContainText(selected.artifact!.sha256!);
    await viewer.getByRole('textbox', { name: '成果审阅意见', exact: true }).fill(handoffMarker);
    await viewer.getByRole('button', { name: '交给父 Agent 审阅/整合', exact: true }).click();
    await expect(viewer).toContainText('已追加到输入框，请检查后发送。');
    await page.screenshot({ path: test.info().outputPath('native-agent-result-review.png'), fullPage: true });
    await viewer.getByRole('button', { name: '关闭成果', exact: true }).click();
    expect(await composer.inputValue()).toMatch(/^人工补充：保留已有草稿。\n\n/);
    expect(await composer.inputValue()).toContain(selected.childId);
    expect(fixture.requests, 'preview and review handoff never contact the model').toHaveLength(requestCount);
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    for (const toolName of ['apply_patch', 'run_command']) {
      await expect.poll(async () => (await snapshot(page, session.id)).pending.find(item => item.toolName === toolName)?.requestId).toBeTruthy();
      const approval = page.getByRole('region', { name: '工具审批', exact: true });
      await expect(approval).toContainText(toolName);
      const pendingApproval = (await snapshot(page, session.id)).pending.find(item => item.toolName === toolName)!;
      expect(pendingApproval.nativeDelegation).toBeUndefined();
      await approval.getByRole('button', { name: '允许本次', exact: true }).click();
    }
    await expect.poll(async () => (await snapshot(page, session.id)).taskState).toBe('completed');
    const continued = await snapshot(page, session.id);
    expect(continued.nativeRun!.runId).not.toBe(selected.parentIdentity.runId);
    expect(continued.nativeAgents?.parentRunId).toBe(selected.parentIdentity.runId);
    expect(continued.nativeAgents?.items).toHaveLength(2);
    expect(continued.nativeTask?.taskId).toBe(selected.parentTaskId);
    expect(continued.nativeTask?.verification).toBe('unverified');
    const name = selected.goal.startsWith('IMPLEMENT_A') ? 'a' : 'b';
    expect(await fs.readFile(path.join(f.cwd, 'integrated-result.txt'), 'utf8')).toBe(`child ${name} implementation\n`);
    expect(await fs.readFile(path.join(f.cwd, 'fixture.txt'), 'utf8')).toBe('unstaged parent draft\n');
    expect(await fs.readFile(path.join(f.cwd, '.git', 'index'))).toEqual(parentIndex);
    expect(fixture.errors).toEqual([]);
    const rejected = await page.evaluate(async ({ id, childId }) => {
      try { await window.desktop.nativeAgentResult(id, { parentRunId: '00000000-0000-4000-8000-000000000001', childId }); return false; }
      catch { return true; }
    }, { id: session.id, childId: selected.childId });
    expect(rejected).toBe(true);
    await closeNativeApp(app);
    for (const child of saved) expect(await fs.stat(child.workspace!.path)).toBeTruthy();
    const reopened = await f.launch();
    try {
      const restored = await snapshot(await ready(reopened), session.id);
      expect(restored.nativeAgents?.items).toHaveLength(2);
      expect(new Set(restored.nativeAgents!.items.map(child => child.worktree?.path))).toEqual(new Set(saved.map(child => child.workspace!.path)));
      expect(restored.nativeTask?.verification).toBe('unverified');
    } finally { await closeNativeApp(reopened); }
  } finally { barrier.release(); await closeNativeApp(app); await fixture.close(); await f.dispose(); }
});
