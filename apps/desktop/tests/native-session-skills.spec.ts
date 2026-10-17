import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import type { IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { EngineConfig } from '../src/shared/execution';
import type { NativeSessionSkillsSave, NativeSessionSkillsView } from '../src/shared/native-skills';
import { desktopRoot } from './helpers/paths';
import { electronLaunchArgs } from './helpers/electron-launch';
import { closeNativeApp } from './helpers/native-app-cleanup';
import { openSessionSettings, closeSessionSettings } from './helpers/session-settings';
// @ts-expect-error 共享的测试专用 ESM 装置没有类型声明。
import { listenOnFetchLoopback } from '../../../packages/agent-node/tests/fixtures/fetch-loopback.mjs';

const availablePath = '.agents/skills/available/SKILL.md';
const missingPath = '.agents/skills/missing/SKILL.md';
const additionalPath = '.claude/skills/additional/SKILL.md';
const customPath = 'tools/quality/SKILL.md';
const initialPaths = [availablePath, missingPath, customPath];
const legacyPolicy = (paths: readonly string[]) => ({
  mode: 'legacy' as const, autoActivation: false as const,
  pins: paths.map(source => ({ kind: 'legacy' as const, path: source })), disabledIds: [],
});

interface SessionSkillsSaveFixture {
  records(): { inputs: NativeSessionSkillsSave[]; entered: boolean; invoked: number };
  release(): void;
  dispose(): Promise<void>;
}
type SaveFixtureGlobal = typeof globalThis & { sessionSkillsSaveFixture?: SessionSkillsSaveFixture };

async function workspace(configs: EngineConfig[]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-session-skills-'));
  const data = path.join(directory, 'data'), cwd = path.join(directory, 'project');
  await fs.mkdir(data); await fs.mkdir(cwd);
  for (const [source, content] of [[availablePath, 'Available project guide.'], [additionalPath, 'Additional project guide.'], [customPath, 'CUSTOM_GUIDE_LOCAL_PREVIEW_ONLY']]) {
    const file = path.join(cwd, source);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${content}\n`);
  }
  const sessionIds = configs.map(() => randomUUID()), projectId = randomUUID(), now = new Date().toISOString();
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify({
    version: 3, projects: [{ id: projectId, name: 'Skills 配置项目', path: cwd, createdAt: now }],
    sessions: configs.map((engineConfig, index) => ({ id: sessionIds[index], projectId, title: `Skills 配置会话 ${index + 1}`, kind: 'agent', cwd,
      execution: { providerId: 'native', mode: 'structured', conversationId: randomUUID() }, engineConfig,
      started: false, status: 'stopped', archived: false, createdAt: now, updatedAt: now })),
    selectedSessionId: sessionIds[0], settings: { claudePath: path.join(directory, 'missing-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000, engineDefaults: {} },
  }));
  const requests: string[] = [];
  const server = createServer((request, response) => { requests.push(`${request.method} ${request.url}`); response.writeHead(503); response.end(); });
  await listenOnFetchLoopback(server);
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    directory, data, sessionIds, requests, baseURL,
    launch: () => electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot,
      env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data } }),
    dispose: async () => {
      const stopped = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections(); await stopped;
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

async function readyWindow(app: ElectronApplication) {
  const page = await app.firstWindow();
  await expect(page.locator('main.workspace')).toBeVisible();
  return page;
}

async function savedConfig(page: Page, sessionId: string) {
  return page.evaluate(async id => (await window.desktop.snapshot()).state.sessions.find(session => session.id === id)!.engineConfig, sessionId);
}

async function migrationBackups(data: string) {
  try { return (await fs.readdir(path.join(data, 'native-session-skills'))).filter(name => /^workspace\.pre-native-skills-v2\.[a-f0-9]{64}\.json$/.test(name)).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

test('explicit legacy Skills upgrade preserves missing and custom pins, saves v2 choices separately, and retains them through MCP saves and restart without requests', async () => {
  const f = await workspace([{ schemaVersion: 1, options: { projectSkills: initialPaths, mcpConnections: ['missing-mcp'], maxSubagents: 7 } }]);
  let app = await f.launch();
  try {
    let page = await readyWindow(app);
    const configured = await page.evaluate(async ({ baseURL, sessionId }) => {
      const model = await window.desktop.nativeConnections.upsert({ name: 'Skills 配置本地模型', protocol: 'responses', baseURL: `${baseURL}/v1`, model: 'fixture-model',
        allowLoopbackHttp: true, enabled: true, auth: { mode: 'memory' } });
      await window.desktop.nativeConnections.setCredential({ id: model.id, revision: model.revision, mode: 'memory', secret: 'settings-must-not-request-model' });
      const session = (await window.desktop.snapshot()).state.sessions.find(item => item.id === sessionId)!;
      await window.desktop.updateSession({ id: sessionId, engineConfig: { ...session.engineConfig, options: { ...session.engineConfig.options, connectionId: model.id } } });
      return window.desktop.nativeMcp.upsert({ name: 'Skills 配置 MCP', endpoint: `${baseURL}/mcp`, protocolVersion: '2025-11-25',
        allowLoopbackHttp: true, enabled: true, auth: { mode: 'none' } });
    }, { baseURL: f.baseURL, sessionId: f.sessionIds[0] });
    const original = await savedConfig(page, f.sessionIds[0]);
    await openSessionSettings(page, 'tools');
    const legacy = page.getByRole('region', { name: '项目 Skills', exact: true });
    for (const source of initialPaths) await expect(legacy.getByRole('checkbox', { name: source, exact: true })).toBeChecked();
    await legacy.getByRole('button', { name: '读取项目 Skills', exact: true }).click();
    await expect(legacy.getByRole('checkbox', { name: additionalPath, exact: true })).not.toBeChecked();
    await expect(legacy.getByRole('checkbox', { name: missingPath, exact: true })).toBeChecked();
    await legacy.getByRole('button', { name: `预览 ${customPath}`, exact: true }).click();
    await expect(legacy).toContainText('CUSTOM_GUIDE_LOCAL_PREVIEW_ONLY');
    expect(await savedConfig(page, f.sessionIds[0])).toEqual(original);
    const before = await page.evaluate(sessionId => window.desktop.nativeSkills.getSessionSkills({ sessionId }), f.sessionIds[0]);
    expect(before.schemaVersion).toBe(1);
    expect(before.policy).toEqual(legacyPolicy(initialPaths));
    expect(before.runtimeEnabled).toBe(false);
    expect(before.pinDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: customPath, status: 'available' }), expect.objectContaining({ path: missingPath, status: 'unavailable' }),
    ]));
    expect(await migrationBackups(f.data)).toEqual([]);
    const originalWorkspace = await fs.readFile(path.join(f.data, 'workspace.json'), 'utf8');
    const backupName = `workspace.pre-native-skills-v2.${createHash('sha256').update(originalWorkspace).digest('hex')}.json`;
    const backupFile = path.join(f.data, 'native-session-skills', backupName);
    expect(f.requests).toEqual([]);

    await page.getByRole('button', { name: '升级技能配置', exact: true }).click();
    const skills = page.getByRole('region', { name: '会话技能配置', exact: true });
    await expect.poll(() => savedConfig(page, f.sessionIds[0])).toEqual({ ...original, schemaVersion: 2,
      options: { ...original.options, skills: legacyPolicy(initialPaths) } });
    expect(await migrationBackups(f.data)).toEqual([backupName]);
    expect(await fs.readFile(backupFile, 'utf8')).toBe(originalWorkspace);
    for (const source of initialPaths) await expect(skills.getByRole('checkbox', { name: source, exact: true })).toBeChecked();
    expect(f.requests).toEqual([]);

    await skills.getByRole('button', { name: '读取项目 Skills', exact: true }).click();
    await skills.getByRole('checkbox', { name: missingPath, exact: true }).uncheck();
    await expect(skills.getByRole('checkbox', { name: missingPath, exact: true })).toHaveCount(0);
    await skills.getByRole('checkbox', { name: additionalPath, exact: true }).check();
    const selected = [availablePath, additionalPath, customPath];
    await skills.getByRole('button', { name: '保存技能选择', exact: true }).click();
    await expect(skills).toContainText('技能选择已保存。');
    await expect(skills.getByRole('button', { name: '保存技能选择', exact: true })).toBeDisabled();
    const expectedSkills = legacyPolicy(selected);
    await expect.poll(() => savedConfig(page, f.sessionIds[0])).toEqual({ ...original, schemaVersion: 2,
      options: { ...original.options, projectSkills: selected, skills: expectedSkills } });

    const mcp = page.getByRole('region', { name: '会话 MCP 工具', exact: true });
    await mcp.getByRole('button', { name: '读取 MCP 连接', exact: true }).click();
    await mcp.getByLabel('MCP missing-mcp (missing-mcp)', { exact: true }).uncheck();
    await mcp.getByLabel(`MCP Skills 配置 MCP (${configured.id})`, { exact: true }).check();
    await page.locator('.session-config').getByRole('button', { name: '保存配置', exact: true }).click();
    const expected = { ...original, schemaVersion: 2, options: { ...original.options, projectSkills: selected, skills: expectedSkills, mcpConnections: [configured.id] } };
    await expect.poll(() => savedConfig(page, f.sessionIds[0])).toEqual(expected);
    expect(await migrationBackups(f.data)).toEqual([backupName]);
    expect(await fs.readFile(backupFile, 'utf8')).toBe(originalWorkspace);
    await closeSessionSettings(page);
    expect(f.requests).toEqual([]);

    await closeNativeApp(app); app = await f.launch(); page = await readyWindow(app);
    await openSessionSettings(page, 'tools');
    expect(await savedConfig(page, f.sessionIds[0])).toEqual(expected);
    const restored = page.getByRole('region', { name: '会话技能配置', exact: true });
    for (const source of selected) await expect(restored.getByRole('checkbox', { name: source, exact: true })).toBeChecked();
    await expect(restored.getByRole('checkbox', { name: missingPath, exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '升级技能配置', exact: true })).toHaveCount(0);
    expect((await page.evaluate(sessionId => window.desktop.nativeSkills.getSessionSkills({ sessionId }), f.sessionIds[0])).policy).toEqual(expectedSkills);
    expect(await migrationBackups(f.data)).toEqual([backupName]);
    expect(await fs.readFile(backupFile, 'utf8')).toBe(originalWorkspace);
    expect(f.requests).toEqual([]);
  } finally { try { await closeNativeApp(app); } finally { await f.dispose(); } }
});

test('a late session Skills read cannot replace another session selection or write a configuration', async () => {
  const configs: EngineConfig[] = [initialPaths, [additionalPath]].map(paths => ({ schemaVersion: 2, options: { projectSkills: paths, skills: legacyPolicy(paths) } }));
  const f = await workspace(configs), app = await f.launch();
  try {
    const page = await readyWindow(app);
    const views = await page.evaluate(async ids => Promise.all(ids.map(sessionId => window.desktop.nativeSkills.getSessionSkills({ sessionId }))), f.sessionIds);
    const original = await Promise.all(f.sessionIds.map(id => savedConfig(page, id)));
    // 本测试仅延迟已从真实 IPC 读取的元数据，配置保存入口保持真实宿主实现。
    await app.evaluate(({ ipcMain }, { firstId, secondView }) => {
      const state = globalThis as typeof globalThis & { finishSessionSkills?: (view: NativeSessionSkillsView) => void; pendingSessionSkills?: string };
      ipcMain.removeHandler('native:session-skills');
      ipcMain.handle('native:session-skills', (_event, input: { sessionId: string }) => input.sessionId === firstId
        ? new Promise<NativeSessionSkillsView>(resolve => { state.pendingSessionSkills = input.sessionId; state.finishSessionSkills = resolve; }) : secondView);
    }, { firstId: f.sessionIds[0], secondView: views[1] });
    await openSessionSettings(page, 'tools');
    await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { pendingSessionSkills?: string }).pendingSessionSkills)).toBe(f.sessionIds[0]);
    await page.evaluate(id => window.desktop.setSelection(id), f.sessionIds[1]);
    const skills = page.getByRole('region', { name: '会话技能配置', exact: true });
    await expect(skills.getByRole('checkbox', { name: additionalPath, exact: true })).toBeChecked();
    await app.evaluate((_electron, view) => {
      const state = globalThis as typeof globalThis & { finishSessionSkills?: (value: NativeSessionSkillsView) => void; pendingSessionSkills?: string };
      state.finishSessionSkills?.(view); delete state.finishSessionSkills; delete state.pendingSessionSkills;
    }, views[0]);
    await expect(skills.getByRole('checkbox', { name: additionalPath, exact: true })).toBeChecked();
    for (const source of initialPaths) await expect(skills.getByRole('checkbox', { name: source, exact: true })).toHaveCount(0);
    await expect(skills.getByRole('button', { name: '保存技能选择', exact: true })).toBeDisabled();
    expect(await Promise.all(f.sessionIds.map(id => savedConfig(page, id)))).toEqual(original);
    expect(f.requests).toEqual([]);
    await closeSessionSettings(page);
  } finally { try { await closeNativeApp(app); } finally { await f.dispose(); } }
});

test('a pending real Skills save accepts one DOM submission and acknowledges only its submitted choices while retaining newer edits', async () => {
  const f = await workspace([{ schemaVersion: 2, options: { projectSkills: [availablePath], skills: legacyPolicy([availablePath]) } }]);
  const app = await f.launch();
  try {
    const page = await readyWindow(app), original = await savedConfig(page, f.sessionIds[0]);
    await openSessionSettings(page, 'tools');
    const skills = page.getByRole('region', { name: '会话技能配置', exact: true });
    await skills.getByRole('button', { name: '读取项目 Skills', exact: true }).click();
    await skills.getByRole('checkbox', { name: additionalPath, exact: true }).check();
    const submitted = [availablePath, additionalPath];
    await app.evaluate(({ ipcMain }) => {
      type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
      const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, Handler> })._invokeHandlers;
      if (!(handlers instanceof Map)) throw new Error('Electron IPC invoke handler interception is unavailable');
      const originalSave = handlers.get('native:session-skills-save');
      if (!originalSave) throw new Error('Expected the real session Skills save IPC handler');
      const inputs: NativeSessionSkillsSave[] = [], operations: Promise<unknown>[] = [];
      let entered = false, invoked = 0, release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      ipcMain.removeHandler('native:session-skills-save');
      ipcMain.handle('native:session-skills-save', (event, input: NativeSessionSkillsSave) => {
        inputs.push(structuredClone(input));
        const operation = (async () => {
          // Delay before the original authenticated handler; its schema, CAS, disk transaction and ACK stay real.
          if (!entered) { entered = true; await pending; }
          invoked++;
          return originalSave(event, input);
        })();
        operations.push(operation);
        return operation;
      });
      (globalThis as SaveFixtureGlobal).sessionSkillsSaveFixture = {
        records: () => ({ inputs: structuredClone(inputs), entered, invoked }), release,
        dispose: async () => {
          release();
          ipcMain.removeHandler('native:session-skills-save'); ipcMain.handle('native:session-skills-save', originalSave);
          await Promise.allSettled(operations);
          delete (globalThis as SaveFixtureGlobal).sessionSkillsSaveFixture;
        },
      };
    });

    // Both DOM clicks occur before a second renderer event turn can supply a new closure.
    const nextPaint = await skills.getByRole('button', { name: '保存技能选择', exact: true }).evaluate(async button => {
      if (!(button instanceof HTMLButtonElement)) throw new Error('Expected the Skills save button');
      const started = performance.now();
      button.click(); button.click();
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const ordinarySave = button.closest('.session-config')?.querySelector<HTMLButtonElement>('button.full');
      return { elapsedMs: performance.now() - started, pending: button.textContent === '正在保存技能选择…',
        disabled: button.disabled, ordinaryDisabled: ordinarySave?.disabled };
    });
    expect(nextPaint.pending).toBe(true); expect(nextPaint.disabled).toBe(true); expect(nextPaint.ordinaryDisabled).toBe(true);
    await test.info().attach('skills-save-next-paint.json', { body: JSON.stringify(nextPaint), contentType: 'application/json' });
    await expect.poll(() => app.evaluate(() => (globalThis as SaveFixtureGlobal).sessionSkillsSaveFixture!.records().inputs.length)).toBe(1);
    await expect(skills.getByRole('button', { name: '正在保存技能选择…', exact: true })).toBeDisabled();
    await expect(page.locator('.session-config').getByRole('button', { name: '保存配置', exact: true })).toBeDisabled();
    const pending = await app.evaluate(() => (globalThis as SaveFixtureGlobal).sessionSkillsSaveFixture!.records());
    expect(pending.entered).toBe(true); expect(pending.invoked).toBe(0);
    expect(pending.inputs[0].policy).toEqual(legacyPolicy(submitted));
    expect(pending.inputs[0].mutationId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);

    await expect(skills.getByRole('checkbox', { name: availablePath, exact: true })).toBeEnabled();
    await skills.getByRole('checkbox', { name: availablePath, exact: true }).uncheck();
    await expect(skills.getByRole('checkbox', { name: additionalPath, exact: true })).toBeChecked();
    expect(await savedConfig(page, f.sessionIds[0])).toEqual(original);
    await app.evaluate(() => (globalThis as SaveFixtureGlobal).sessionSkillsSaveFixture!.release());
    await expect.poll(() => savedConfig(page, f.sessionIds[0])).toEqual({ ...original,
      options: { ...original.options, projectSkills: submitted, skills: legacyPolicy(submitted) } });
    await expect(skills).toContainText('当前还有未保存的技能选择。');
    await expect(skills.getByRole('checkbox', { name: availablePath, exact: true })).not.toBeChecked();
    await expect(skills.getByRole('checkbox', { name: additionalPath, exact: true })).toBeChecked();
    await expect(skills.getByRole('button', { name: '保存技能选择', exact: true })).toBeEnabled();
    expect((await app.evaluate(() => (globalThis as SaveFixtureGlobal).sessionSkillsSaveFixture!.records())).inputs).toHaveLength(1);

    await skills.getByRole('button', { name: '保存技能选择', exact: true }).click();
    await expect(skills.getByRole('button', { name: '保存技能选择', exact: true })).toBeDisabled();
    await expect(skills).toContainText('技能选择已保存。');
    const next = [additionalPath];
    await expect.poll(() => savedConfig(page, f.sessionIds[0])).toEqual({ ...original,
      options: { ...original.options, projectSkills: next, skills: legacyPolicy(next) } });
    const saved = await app.evaluate(() => (globalThis as SaveFixtureGlobal).sessionSkillsSaveFixture!.records());
    expect(saved.inputs).toHaveLength(2); expect(saved.invoked).toBe(2);
    expect(saved.inputs[1].policy).toEqual(legacyPolicy(next));
    expect(saved.inputs[1].mutationId).not.toBe(saved.inputs[0].mutationId);
    expect(await migrationBackups(f.data)).toEqual([]);
    expect(f.requests).toEqual([]);
    await closeSessionSettings(page);
  } finally {
    try {
      await app.evaluate(async () => { await (globalThis as SaveFixtureGlobal).sessionSkillsSaveFixture?.dispose(); });
    } finally { try { await closeNativeApp(app); } finally { await f.dispose(); } }
  }
});
