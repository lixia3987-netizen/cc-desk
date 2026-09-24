import { electronLaunchArgs } from './helpers/electron-launch';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppState, Session } from '../src/shared/types';
import type { ChatSnapshot } from '../src/shared/chat';

const fence = (source: string, language = 'mermaid') => '```' + language + '\n' + source + '```';

async function workspace(texts: string[], toolIndexes: number[] = []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-desk-mermaid-'));
  const data = path.join(directory, 'data'), projectPath = path.join(directory, 'project');
  const now = new Date().toISOString(), projectId = randomUUID(), sessionId = randomUUID();
  await fs.mkdir(projectPath);
  await fs.mkdir(path.join(data, 'chat'), { recursive: true });
  const canonicalPath = await fs.realpath(projectPath);
  const session: Session = { execution: { providerId: 'claude', mode: 'structured', conversationId: randomUUID() },
    id: sessionId, projectId, cwd: canonicalPath,  title: 'Mermaid 会话',
    kind: 'agent',  started: false, model: '', effort: 'default',
    permissionMode: 'default', status: 'idle', taskState: 'completed', archived: false,
    createdAt: now, updatedAt: now,
  };
  const state: AppState = {
    version: 2, projects: [{ id: projectId, name: 'Mermaid 测试项目', path: canonicalPath, createdAt: now }],
    sessions: [session], selectedSessionId: sessionId,
    settings: { claudePath: path.join(directory, 'unavailable-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000, theme: 'forest' },
  };
  const snapshot: ChatSnapshot = {
    sessionId, taskState: 'completed', pending: [],
    messages: texts.map((text, index) => ({
      id: 'message-' + index, turnId: 'turn-' + index, role: toolIndexes.includes(index) ? 'tool' : 'assistant',
      ...(toolIndexes.includes(index) ? { toolName: 'Read', toolUseId: 'tool-' + index } : {}), createdAt: now, text,
    })),
  };
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify(state));
  await fs.writeFile(path.join(data, 'chat', sessionId + '.json'), JSON.stringify(snapshot));
  const launch = () => electron.launch({
    args: electronLaunchArgs(),
    env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data },
  });
  return { snapshot, launch, dispose: () => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

/** Exercise real renderer updates without starting a CLI or depending on a provider. */
async function updateSnapshot(app: ElectronApplication, snapshot: ChatSnapshot) {
  await app.evaluate(({ ipcMain, BrowserWindow }, value) => {
    ipcMain.removeHandler('chat:snapshot');
    ipcMain.handle('chat:snapshot', () => value);
    BrowserWindow.getAllWindows()[0].webContents.send('chat:changed', value.sessionId, value.taskState);
  }, snapshot);
}

test('mermaid: render real diagrams, switch individual blocks and copy the original source', async ({}, testInfo) => {
  const source = 'flowchart LR\n  A["开始"] --> B["读取项目"]\n\n  B --> C["完成"]\n';
  const sequence = 'sequenceDiagram\n  participant U as 用户\n  participant C as 客户端\n  U->>C: 打开会话\n  C-->>U: 展示结果\n';
  const ordinary = 'const plainCode = "unchanged";\n';
  const f = await workspace([fence(source) + '\n\n' + fence(sequence) + '\n\n' + fence(ordinary, 'typescript')]);
  const app = await f.launch();
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: 'Mermaid 会话', exact: true })).toBeVisible();
    const blocks = page.locator('.mermaid-block'), first = blocks.nth(0), second = blocks.nth(1);
    await expect(blocks).toHaveCount(2);
    await first.scrollIntoViewIfNeeded();
    await expect(first.locator('.mermaid-preview .mermaid-svg > svg')).toBeVisible({ timeout: 15_000 });
    await expect(first.locator('.mermaid-preview')).toContainText('读取项目');
    await second.scrollIntoViewIfNeeded();
    await expect(second.locator('.mermaid-preview .mermaid-svg > svg')).toBeVisible({ timeout: 15_000 });
    await expect(second.locator('.mermaid-preview')).toContainText('打开会话');
    await expect(first.getByRole('button', { name: '预览', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await first.getByRole('button', { name: '源码', exact: true }).click();
    await expect(first.getByRole('button', { name: '源码', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(first.locator('.mermaid-preview')).toBeHidden();
    expect(await first.locator('pre').textContent()).toBe(source);
    await expect(second.locator('.mermaid-preview .mermaid-svg > svg')).toBeVisible();
    await first.getByRole('button', { name: '复制代码', exact: true }).click();
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(source);
    await first.getByRole('button', { name: '预览', exact: true }).click();
    await expect(first.locator('.mermaid-preview .mermaid-svg > svg')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('mermaid-preview.png') });
    // Preview copies the input, never the generated SVG or visible labels.
    await app.evaluate(({ clipboard }) => clipboard.writeText('replace this'));
    await first.getByRole('button', { name: '复制代码', exact: true }).click();
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(source);
    const plain = page.locator('.message-code').filter({ has: page.locator('code.language-typescript') });
    expect(await plain.locator('pre').textContent()).toBe(ordinary);
    await expect(plain.getByRole('button', { name: '预览', exact: true })).toHaveCount(0);
    await plain.getByRole('button', { name: '复制代码', exact: true }).click();
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(ordinary);
    // The desktop clipboard bridge accepts bounded plain text only; rejected input cannot overwrite it.
    await expect(page.evaluate(() => window.desktop.copyText({ text: 'not a string' } as never))).rejects.toThrow();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(ordinary);
    // UTF-8 size, rather than JavaScript string length, must enforce the 4 MiB limit.
    await expect(page.evaluate(() => window.desktop.copyText('你'.repeat(1_400_000)))).rejects.toThrow();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(ordinary);
    expect(errors).toEqual([]);
  } finally { await app.close(); await f.dispose(); }
});

test('mermaid: an incomplete diagram stays readable, does not break siblings and recovers after a stream update', async () => {
  const incomplete = 'flowchart TD\n  A["unfinished\n';
  const complete = 'flowchart TD\n  A["Recovered"] --> B["Complete"]\n';
  const valid = 'flowchart LR\n  X["Other diagram"] --> Y["Still works"]\n';
  const f = await workspace([fence(incomplete), fence(valid)]), app = await f.launch();
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const first = page.locator('.mermaid-block').nth(0), second = page.locator('.mermaid-block').nth(1);
    await expect(first.locator('.mermaid-error')).toBeVisible({ timeout: 15_000 });
    await expect(second.locator('.mermaid-preview .mermaid-svg > svg')).toBeVisible({ timeout: 15_000 });
    await first.getByRole('button', { name: '源码', exact: true }).click();
    expect(await first.locator('pre').textContent()).toBe(incomplete);
    await first.getByRole('button', { name: '复制代码', exact: true }).click();
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(incomplete);
    // Retry the same source explicitly; cached errors must not disable the preview switch.
    await first.getByRole('button', { name: '预览', exact: true }).click();
    await expect(first.locator('.mermaid-loading')).toBeVisible();
    await expect(first.locator('.mermaid-error')).toBeVisible({ timeout: 15_000 });
    await first.getByRole('button', { name: '源码', exact: true }).click();
    f.snapshot.messages[0].text = fence(complete);
    await updateSnapshot(app, f.snapshot);
    await expect.poll(() => first.locator('pre').textContent()).toBe(complete);
    await first.getByRole('button', { name: '预览', exact: true }).click();
    await expect(first.locator('.mermaid-preview .mermaid-svg > svg')).toBeVisible({ timeout: 15_000 });
    await expect(first.locator('.mermaid-preview')).toContainText('Recovered');
    await expect(first.locator('.mermaid-error')).toHaveCount(0);
    await expect(second.locator('.mermaid-preview')).toContainText('Other diagram');
    // A stale successful render must not remain visible after subsequent invalid input.
    f.snapshot.messages[0].text = fence(incomplete);
    await updateSnapshot(app, f.snapshot);
    await expect(first.locator('.mermaid-error')).toBeVisible({ timeout: 15_000 });
    await expect(first.locator('.mermaid-preview .mermaid-svg > svg')).toHaveCount(0);
    await expect(second.locator('.mermaid-preview .mermaid-svg > svg')).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await app.close(); await f.dispose(); }
});

test('mermaid: identical diagrams keep independent IDs and a collapsed tool result renders when opened', async () => {
  const source = 'flowchart LR\n  A["Shared source"] --> B["Separate diagram"]\n';
  const f = await workspace([fence(source), fence(source), fence(source)], [2]), app = await f.launch();
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const blocks = page.locator('.mermaid-block'), tool = page.locator('.tool-card');
    await expect(blocks).toHaveCount(3);
    await expect(tool).not.toHaveAttribute('open', '');
    for (let index = 0; index < 2; index++) {
      await blocks.nth(index).scrollIntoViewIfNeeded();
      await expect(blocks.nth(index).locator('.mermaid-preview .mermaid-svg > svg')).toBeVisible({ timeout: 15_000 });
    }
    await expect(tool.locator('.mermaid-preview')).toBeHidden();
    await expect(tool.locator('.mermaid-preview .mermaid-svg > svg')).toHaveCount(0);
    await tool.locator('summary').click();
    await expect(tool).toHaveAttribute('open', '');
    await tool.locator('.mermaid-block').scrollIntoViewIfNeeded();
    await expect(tool.locator('.mermaid-preview .mermaid-svg > svg')).toBeVisible({ timeout: 15_000 });
    // Mermaid may split a wrapped label into adjacent tspans without a literal space.
    await expect(tool.locator('.mermaid-preview .mermaid-svg > svg .node').filter({ hasText: /Separate\s*diagram/ })).toHaveCount(1);
    const svgIds = await blocks.locator('.mermaid-preview .mermaid-svg > svg').evaluateAll(elements => elements.map(element => element.id));
    expect(svgIds).toHaveLength(3);
    expect(svgIds.every(Boolean)).toBe(true);
    expect(new Set(svgIds).size).toBe(3);
    // Arrow references belong to their own SVG; duplicate diagrams must not borrow another diagram's markers.
    const markers = await blocks.locator('.mermaid-preview .mermaid-svg > svg').evaluateAll(elements => elements.map(svg => {
      const arrows = Array.from(svg.querySelectorAll('[marker-end]'));
      return {
        count: arrows.length,
        targets: arrows.map(arrow => {
          const target = /url\(["']?#([^"')]+)["']?\)/.exec(arrow.getAttribute('marker-end') ?? '')?.[1];
          return target && svg.querySelector('#' + CSS.escape(target)) ? target : null;
        }),
      };
    }));
    expect(markers.every(value => value.count > 0 && value.targets.every(Boolean))).toBe(true);
    expect(new Set(markers.flatMap(value => value.targets)).size).toBe(3);
    await tool.locator('summary').click();
    await expect(tool.locator('.mermaid-preview')).toBeHidden();
    await tool.locator('summary').click();
    await expect(tool.locator('.mermaid-preview .mermaid-svg > svg')).toHaveAttribute('id', svgIds[2]);
    await tool.getByRole('button', { name: '源码', exact: true }).click();
    expect(await tool.locator('.mermaid-source').textContent()).toBe(source);
    expect(errors).toEqual([]);
  } finally { await app.close(); await f.dispose(); }
});

test('mermaid: themes update diagrams and source configuration cannot enable active HTML or links', async () => {
  const safe = 'flowchart LR\n  A["Theme preview"] --> B["Readable labels"]\n';
  const hostile = [
    '---', 'config:', '  securityLevel: loose', '  flowchart:', '    htmlLabels: true', '---',
    '%%{init: {"securityLevel":"loose","flowchart":{"htmlLabels":true}}}%%',
    'flowchart LR', '  A["<img src=x onerror=window.__mermaidExecuted=true>"] --> B["Safe target"]',
    '  click B "javascript:window.__mermaidExecuted=true"', '',
  ].join('\n');
  const f = await workspace([fence(safe), fence(hostile)]), app = await f.launch();
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const first = page.locator('.mermaid-block').nth(0), second = page.locator('.mermaid-block').nth(1);
    await expect(first.locator('.mermaid-preview .mermaid-svg > svg')).toBeVisible({ timeout: 15_000 });
    await expect(second.locator('.mermaid-preview .mermaid-svg > svg')).toBeVisible({ timeout: 15_000 });
    const node = first.locator('.mermaid-preview .mermaid-svg > svg .node rect').first();
    const darkFill = await node.evaluate(element => getComputedStyle(element).fill);
    await page.evaluate(async () => { const { state } = await window.desktop.snapshot(); await window.desktop.saveSettings({ ...state.settings, theme: 'cloud' }); });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'cloud');
    await expect(first.locator('.mermaid-preview')).toHaveAttribute('data-theme', 'cloud');
    await expect.poll(() => node.evaluate(element => getComputedStyle(element).fill)).not.toBe(darkFill);
    const lightFill = await node.evaluate(element => getComputedStyle(element).fill);
    await page.evaluate(async () => { const { state } = await window.desktop.snapshot(); await window.desktop.saveSettings({ ...state.settings, theme: 'midnight' }); });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight');
    await expect(first.locator('.mermaid-preview')).toHaveAttribute('data-theme', 'midnight');
    await expect.poll(() => node.evaluate(element => getComputedStyle(element).fill)).not.toBe(lightFill);
    await expect(second.locator('.mermaid-preview .mermaid-svg > svg')).toBeVisible();
    const activeContent = await page.locator('.mermaid-preview').evaluateAll(previews => previews.flatMap(preview => Array.from(preview.querySelectorAll('*')).flatMap(element => {
      const violations: string[] = [];
      if (['script', 'iframe', 'object', 'embed', 'img', 'foreignObject', 'a'].includes(element.localName)) violations.push(element.localName);
      for (const attribute of Array.from(element.attributes)) {
        if (/^on/i.test(attribute.name) || /^(?:javascript|data|vbscript):/i.test(attribute.value.trim())) violations.push(attribute.name + '=' + attribute.value);
      }
      return violations;
    })));
    expect(activeContent).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __mermaidExecuted?: boolean }).__mermaidExecuted)).toBeUndefined();
    await second.getByRole('button', { name: '源码', exact: true }).click();
    expect(await second.locator('pre').textContent()).toBe(hostile);
    await second.getByRole('button', { name: '复制代码', exact: true }).click();
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(hostile);
    expect(errors).toEqual([]);
  } finally { await app.close(); await f.dispose(); }
});
