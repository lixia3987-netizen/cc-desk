import { dialog, type BrowserWindow } from 'electron';
import path from 'node:path';
import type { ExecutionRegistry } from './registry';

export async function exportSession(registry: ExecutionRegistry, id: string, window: BrowserWindow | null) {
  const registration = registry.registration(registry.getSession(id));
  // Reading records remains possible during maintenance or CLI discovery failure.
  if (!registration.capabilities().export) throw new Error('此会话执行器不支持导出。');
  const sources = await registration.executor.exports(id);
  if (!sources.length) throw new Error('此会话没有可导出的记录。');
  const first = sources[0];
  const target = await dialog.showSaveDialog(window!, {
    title: first.suffix === 'events' ? '未找到原始 CLI 对话，导出本工作台记录的事件' : '导出可用会话记录',
    defaultPath: `session-${id.slice(0,8)}.${first.suffix ? first.suffix + '.' : ''}${first.extension}`,
    filters: sources.map(source => ({ name: source.label, extensions: [source.extension] })),
  });
  if (target.canceled || !target.filePath) return null;
  const extension = path.extname(target.filePath).slice(1).toLowerCase();
  const selected = sources.find(source => source.extension === extension) ?? first;
  await selected.write(target.filePath);
  return target.filePath;
}
