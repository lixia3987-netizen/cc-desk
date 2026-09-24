import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chatQueueWorkspace, closeQueueApp } from './fixtures/chat-queue-fixture';

const editor = (page: Page) => page.getByLabel('提示词编辑器', { exact: true });
const attachments = (page: Page, id: string) => page.evaluate(id => window.desktop.listAttachments(id), id);
const select = async (page: Page, title: string) => {
  await page.locator('.session-row').filter({ hasText: title }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
};

/** setInputFiles gives Electron real disk-backed Files, preserving webUtils paths. */
async function dropNativeFiles(page: Page, files: string[], inspectHover = false) {
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'native-drop-fixture'; input.type = 'file'; input.multiple = true; input.hidden = true;
    document.body.append(input);
  });
  const input = page.locator('#native-drop-fixture');
  await input.setInputFiles(files);
  const transfer = await input.evaluateHandle(element => {
    const data = new DataTransfer();
    for (const file of (element as HTMLInputElement).files ?? []) data.items.add(file);
    return data;
  });
  try {
    // Exercise a descendant of the pane, including the real composer, so the
    // browser's default file/text drop cannot silently alter the current draft.
    await editor(page).dispatchEvent('dragenter', { dataTransfer: transfer });
    await editor(page).dispatchEvent('dragover', { dataTransfer: transfer });
    if (inspectHover) {
      await expect(page.getByText('松开以添加附件', { exact: true })).toBeVisible();
      await page.screenshot({ path: path.join(os.tmpdir(), 'ccdesk-chat-file-drop.png') });
    }
    const prevented = await editor(page).evaluate((element, dataTransfer) => {
      const event = new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true });
      element.dispatchEvent(event); return event.defaultPrevented;
    }, transfer);
    expect(prevented).toBe(true);
    await expect(page.getByText('松开以添加附件', { exact: true })).toHaveCount(0);
  } finally { await transfer.dispose(); await input.evaluate(element => element.remove()); }
}

test('file drop: native files stay pending across session switches and restart, and reach Claude only after explicit send', async () => {
  const f = await chatQueueWorkspace(); let app = await f.launch();
  try {
    let page = await app.firstWindow(); const [session, other] = f.sessions;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 680));
    const image = path.join(path.dirname(f.attachment), '项目 参考图片.png');
    const text = path.join(path.dirname(f.attachment), '拖入说明.txt');
    await fs.copyFile(f.attachment, image); await fs.writeFile(text, 'Only attach this file when the user sends.\n');
    await expect(editor(page)).toBeVisible();
    await editor(page).fill('保持原始草稿');
    await dropNativeFiles(page, [image, text], true);
    await expect(page.locator('.attachment-chips')).toContainText('项目 参考图片.png');
    await expect(page.locator('.attachment-chips')).toContainText('拖入说明.txt');
    await expect(editor(page)).toHaveValue('保持原始草稿');
    const staged = await attachments(page, session.id);
    expect(staged.map(file => file.name)).toEqual(['项目 参考图片.png', '拖入说明.txt']);
    expect(staged.map(file => file.path)).not.toContain(image);
    expect(await f.records()).toEqual([]);

    await select(page, other.title);
    await expect(page.locator('.attachment-chips')).toHaveCount(0); await expect(editor(page)).toHaveValue('');
    await select(page, session.title);
    await expect(editor(page)).toHaveValue('保持原始草稿');
    await expect(page.locator('.attachment-chips')).toContainText('拖入说明.txt');
    await closeQueueApp(app); app = await f.launch(); page = await app.firstWindow();
    await expect(editor(page)).toHaveValue('保持原始草稿');
    await expect(page.locator('.attachment-chips')).toContainText('项目 参考图片.png');
    await expect(page.locator('.attachment-chips')).toContainText('拖入说明.txt');
    expect(await attachments(page, session.id)).toEqual(staged);
    expect(await f.records()).toEqual([]);

    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(editor(page)).toHaveValue('');
    await expect(page.locator('.attachment-chips')).toHaveCount(0);
    await expect.poll(() => f.prompts(session)).toEqual(['保持原始草稿']);
    const sent = (await f.records()).find(record => record.event === 'prompt');
    expect(sent?.content?.some(block => block.type === 'image' && block.source?.media_type === 'image/png' && block.source.data.length > 0)).toBe(true);
    const wireText = sent?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '';
    expect(wireText).toContain(JSON.stringify(staged.find(file => file.name === '拖入说明.txt')!.path));
    expect(wireText).toContain('需要内容时请使用 Read 工具读取');
    expect(wireText).not.toContain('Only attach this file when the user sends.');

    // A running turn also permits staging files without adding a queued prompt.
    await editor(page).fill('仍未发送的后续草稿');
    await dropNativeFiles(page, [text]);
    await expect(page.locator('.attachment-chips')).toContainText('拖入说明.txt');
    await expect(editor(page)).toHaveValue('仍未发送的后续草稿');
    expect(await f.prompts(session)).toEqual(['保持原始草稿']);
    expect((await page.evaluate(id => window.desktop.chatSnapshot(id), session.id)).queue?.items.filter(item => item.status === 'queued')).toEqual([]);
    await f.signal(session, 'complete');
    await expect.poll(async () => (await page.evaluate(id => window.desktop.chatSnapshot(id), session.id)).queue?.items ?? []).toEqual([]);
    await expect(editor(page)).toHaveValue('仍未发送的后续草稿');
    await expect(page.locator('.attachment-chips')).toContainText('拖入说明.txt');
    expect(await f.prompts(session)).toEqual(['保持原始草稿']);
    await page.getByRole('button', { name: '移除附件 拖入说明.txt', exact: true }).click();
    await expect.poll(() => attachments(page, session.id)).toEqual([]);
    await expect(page.locator('.attachment-chips')).toHaveCount(0);
    expect(await fs.readFile(text, 'utf8')).toBe('Only attach this file when the user sends.\n');
    expect((await f.records()).filter(record => record.event === 'violation')).toEqual([]);
  } finally { await closeQueueApp(app); await f.dispose(); }
});

test('file drop: an invalid native batch rolls back every new copy and preserves existing attachments and the draft', async () => {
  const f = await chatQueueWorkspace(), app = await f.launch();
  try {
    const page = await app.firstWindow(), [session] = f.sessions;
    const valid = path.join(path.dirname(f.attachment), 'valid-in-invalid-batch.txt');
    const invalid = path.join(path.dirname(f.attachment), 'unsupported.exe');
    await fs.writeFile(valid, 'Keep this original text file.'); await fs.writeFile(invalid, 'Unsupported fixture, never execute.');
    await expect(editor(page)).toBeVisible(); await editor(page).fill('不应被拖放覆盖的草稿');
    await dropNativeFiles(page, [f.attachment]);
    await expect(page.locator('.attachment-chips')).toContainText('queue-image.png');
    const before = await attachments(page, session.id);
    await dropNativeFiles(page, [valid, invalid]);
    await expect(page.locator('.error-banner')).toContainText('附件类型不受支持');
    expect(await attachments(page, session.id)).toEqual(before);
    await expect(page.locator('.attachment-chips')).not.toContainText('valid-in-invalid-batch.txt');
    await expect(editor(page)).toHaveValue('不应被拖放覆盖的草稿');
    expect((await fs.readdir(path.dirname(before[0].path))).filter(name => name.startsWith('.staged-'))).toEqual([path.basename(before[0].path)]);
    expect(await fs.readFile(valid, 'utf8')).toBe('Keep this original text file.');
    expect(await fs.readFile(invalid, 'utf8')).toBe('Unsupported fixture, never execute.');
    expect(await f.records()).toEqual([]);
  } finally { await closeQueueApp(app); await f.dispose(); }
});

test('file drop: virtual files are rejected and an archived chat suppresses native drops without navigation or submission', async () => {
  const f = await chatQueueWorkspace(), app = await f.launch();
  try {
    const page = await app.firstWindow(), [session] = f.sessions;
    await expect(editor(page)).toBeVisible(); await editor(page).fill('保留只读草稿');
    const url = page.url();
    const virtual = await page.evaluateHandle(() => {
      const transfer = new DataTransfer(); transfer.items.add(new File(['virtual contents'], 'virtual.txt', { type: 'text/plain' }));
      return transfer;
    });
    try { await editor(page).dispatchEvent('drop', { dataTransfer: virtual }); }
    finally { await virtual.dispose(); }
    await expect(page.locator('.error-banner')).toContainText('本机路径');
    expect(await attachments(page, session.id)).toEqual([]);
    await expect(editor(page)).toHaveValue('保留只读草稿');
    await page.evaluate(id => window.desktop.updateSession({ id, archived: true }), session.id);
    await expect(editor(page)).toBeDisabled();
    await dropNativeFiles(page, [f.attachment]);
    expect(page.url()).toBe(url);
    expect(await attachments(page, session.id)).toEqual([]);
    await expect(page.locator('.attachment-chips')).toHaveCount(0);
    await expect(editor(page)).toHaveValue('保留只读草稿');
    expect(await f.records()).toEqual([]);
  } finally { await closeQueueApp(app); await f.dispose(); }
});
