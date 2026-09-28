import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ChatSnapshot } from '../src/shared/chat';
import { desktopRoot } from './helpers/paths';
import { electronLaunchArgs } from './helpers/electron-launch';
import { closeNativeApp } from './helpers/native-app-cleanup';
// @ts-expect-error Shared executable local HTTP fixture has no TypeScript declarations.
import { assistantMessage, functionCall, startResponsesFixture } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

const original = 'preserve user content\n';
const replacement = original + 'new content with "quotes"\r\n';
const created = '新增内容，没有末尾换行';
const createdPath = '新增 文件.txt';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
interface Fixture { baseURL: string; errors: unknown[]; requests: unknown[]; close(): Promise<void> }
type ProtocolItem = Record<string, unknown>;
interface Receipt { status: string; output: { hash?: string } }
async function workspace() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-change-set-电子 空格-'));
  const data = path.join(directory, 'data'), cwd = path.join(directory, 'project'), projectId = randomUUID();
  await fs.mkdir(data); await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, 'feature.txt'), original);
  await fs.writeFile(path.join(cwd, 'untouched.txt'), 'unrelated user file\n');
  await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'Read feature.txt before editing. Keep unrelated files unchanged. Ask approval for every change set.\n');
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify({ version: 3, projects: [{ id: projectId, name: '多文件审批现场', path: cwd, createdAt: new Date().toISOString() }],
    sessions: [], settings: { claudePath: path.join(directory, 'missing-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000, engineDefaults: {} } }));
  const fixture: Fixture = await startResponsesFixture({ handler: ({ body }: { body: { input: ProtocolItem[] } }) => {
    const receipts = new Map(body.input.filter(item => item.type === 'function_call_output').map(item => [String(item.call_id), JSON.parse(String(item.output)) as Receipt]));
    const read = receipts.get('change-read'), changed = receipts.get('change-apply');
    return { output: !read ? [functionCall('change-read', 'read_file', { path: 'feature.txt' })]
      : !changed ? [functionCall('change-apply', 'apply_change_set', { changes: [
        { path: 'feature.txt', expectedHash: read.output.hash, content: replacement }, { path: createdPath, expectedHash: null, content: created },
      ] })] : [assistantMessage('change-finished', '变更工具已返回：' + changed.status)] };
  } });
  return { directory, data, cwd, projectId, fixture,
    launch: () => electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot, env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data } }),
    async dispose() { await fixture.close(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  };
}
async function ready(app: ElectronApplication) {
  const page = await app.firstWindow(); await expect(page.locator('main.workspace')).toBeVisible(); return page;
}
async function configure(page: Page, projectId: string, baseURL: string) {
  return page.evaluate(async ({ projectId, baseURL }) => {
    const item = await window.desktop.nativeConnections.upsert({ name: 'Local change-set fixture', protocol: 'responses', baseURL,
      model: 'fixture-model', enabled: true, allowLoopbackHttp: true, auth: { mode: 'memory' } });
    const connection = await window.desktop.nativeConnections.setCredential({ id: item.id, revision: item.revision, mode: 'memory', secret: 'sk-change-set-local-fixture-not-a-real-key' });
    const session = await window.desktop.createSession({ projectId, title: '多文件审批界面验证', kind: 'agent', providerId: 'native', mode: 'structured', isolated: false,
      engineConfig: { schemaVersion: 1, options: { connectionId: connection.id, model: '' } } });
    await window.desktop.setSelection(session.id); return session;
  }, { projectId, baseURL });
}
const snapshot = (page: Page, id: string): Promise<ChatSnapshot> => page.evaluate(id => window.desktop.chatSnapshot(id), id);
const approval = (page: Page) => page.getByRole('region', { name: '工具审批', exact: true });
const tool = (page: Page) => page.locator('.tool-card').filter({ has: page.getByText('apply_change_set', { exact: true }) });
async function submitAndWait(page: Page, id: string) {
  const editor = page.getByLabel('提示词编辑器', { exact: true });
  await editor.fill('读取后准备替换与新建两个文件，在批准前不要写入。'); await editor.press('Enter'); await expect(editor).toHaveValue('');
  await expect.poll(async () => (await snapshot(page, id)).pending.find(item => item.toolName === 'apply_change_set')?.requestId).toBeTruthy();
  await expect(approval(page).getByRole('region', { name: '多文件变更预览', exact: true })).toBeVisible();
}
async function finish(page: Page, id: string) {
  await expect.poll(async () => (await snapshot(page, id)).taskState).toBe('completed');
  await expect(approval(page)).toHaveCount(0);
}

test('native multi-file approval shows complete hashes/diffs before writing and preserves structured file receipts after restart', async () => {
  const f = await workspace(); let app: ElectronApplication | undefined;
  try {
    app = await f.launch(); let page = await ready(app); const session = await configure(page, f.projectId, f.fixture.baseURL);
    await submitAndWait(page, session.id);
    const initial = (await snapshot(page, session.id)).pending.find(item => item.toolName === 'apply_change_set')!;
    expect(initial.nativeChangeSet?.files).toHaveLength(2);
    await expect(approval(page)).toContainText(hash(original)); await expect(approval(page)).toContainText(hash(replacement)); await expect(approval(page)).toContainText(hash(created));
    await expect(approval(page)).toContainText('创建文件'); await expect(approval(page)).toContainText('替换文件');
    await expect(approval(page)).toContainText('不具备跨文件原子性'); await expect(approval(page)).toContainText('[CRLF]');
    await expect(approval(page).locator('[data-change-file]')).toHaveCount(2);
    expect(await fs.readFile(path.join(f.cwd, 'feature.txt'), 'utf8')).toBe(original);
    await expect(fs.stat(path.join(f.cwd, createdPath))).rejects.toThrow();
    await page.reload(); await expect(page.locator('main.workspace')).toBeVisible();
    await expect(approval(page).getByRole('region', { name: '多文件变更预览', exact: true })).toBeVisible();
    expect((await snapshot(page, session.id)).pending[0].requestId).toBe(initial.requestId);
    await approval(page).getByRole('button', { name: '允许本次', exact: true }).click(); await finish(page, session.id);
    expect(await fs.readFile(path.join(f.cwd, 'feature.txt'), 'utf8')).toBe(replacement);
    expect(await fs.readFile(path.join(f.cwd, createdPath), 'utf8')).toBe(created);
    expect(await fs.readFile(path.join(f.cwd, 'untouched.txt'), 'utf8')).toBe('unrelated user file\n');
    await tool(page).locator('summary').click();
    await expect(tool(page).locator('[data-file-status="applied"]')).toHaveCount(2);
    await expect(tool(page)).toContainText('不代表任务验收通过');
    const receipt = (await snapshot(page, session.id)).messages.find(item => item.toolName === 'apply_change_set')!.nativeChangeSetResult;
    const requests = f.fixture.requests.length;
    await closeNativeApp(app); app = await f.launch(); page = await ready(app); await page.evaluate(id => window.desktop.setSelection(id), session.id);
    await expect(tool(page).locator('summary')).toContainText('本次变更集写入已记录');
    await tool(page).locator('summary').click(); await expect(tool(page).locator('[data-file-status="applied"]')).toHaveCount(2);
    expect((await snapshot(page, session.id)).messages.find(item => item.toolName === 'apply_change_set')!.nativeChangeSetResult).toEqual(receipt);
    expect(f.fixture.requests).toHaveLength(requests); expect(f.fixture.errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('native-change-set-restored.png') });
  } finally { try { if (app) await closeNativeApp(app); } finally { await f.dispose(); } }
});

test('denying a complete native change set keeps both targets unchanged and reports confirmed non-execution', async () => {
  const f = await workspace(); let app: ElectronApplication | undefined;
  try {
    app = await f.launch(); const page = await ready(app), session = await configure(page, f.projectId, f.fixture.baseURL);
    await submitAndWait(page, session.id); await approval(page).getByRole('button', { name: '拒绝', exact: true }).click(); await finish(page, session.id);
    expect(await fs.readFile(path.join(f.cwd, 'feature.txt'), 'utf8')).toBe(original);
    await expect(fs.stat(path.join(f.cwd, createdPath))).rejects.toThrow();
    await expect(tool(page).locator('summary')).toContainText('本次变更集未执行');
    await tool(page).locator('summary').click(); await expect(tool(page)).toContainText('宿主已确认本次工具未执行写入');
    await expect(tool(page).getByLabel('工具未执行原因', { exact: true })).toContainText('approval_denied');
    await expect(tool(page)).not.toContainText('逐文件回执缺失或无效'); expect(f.fixture.errors).toEqual([]);
  } finally { try { if (app) await closeNativeApp(app); } finally { await f.dispose(); } }
});

test('a native multi-file approval cannot overwrite a target changed while the complete preview was open', async () => {
  const f = await workspace(); let app: ElectronApplication | undefined;
  try {
    app = await f.launch(); const page = await ready(app), session = await configure(page, f.projectId, f.fixture.baseURL);
    await submitAndWait(page, session.id);
    await fs.writeFile(path.join(f.cwd, 'feature.txt'), 'external edit after preview\n');
    await approval(page).getByRole('button', { name: '允许本次', exact: true }).click(); await finish(page, session.id);
    expect(await fs.readFile(path.join(f.cwd, 'feature.txt'), 'utf8')).toBe('external edit after preview\n');
    await expect(fs.stat(path.join(f.cwd, createdPath))).rejects.toThrow();
    await expect(tool(page).locator('summary')).toContainText('本次变更集未执行');
    await tool(page).locator('summary').click(); await expect(tool(page).getByLabel('工具未执行原因', { exact: true })).toContainText('preconditions_changed');
    expect(f.fixture.errors).toEqual([]);
  } finally { try { if (app) await closeNativeApp(app); } finally { await f.dispose(); } }
});
