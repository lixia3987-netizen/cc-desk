import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Project } from '../shared/types';
import type { StateStore } from './store';

const directoryKey = (directory: string) => process.platform === 'win32' ? directory.toLowerCase() : directory;

/** 选择目录时复用其工作区身份；不能隐式迁移旧记录。 */
export class ProjectDirectoryRegistry {
  private pending: Promise<void> = Promise.resolve();
  constructor(private store: StateStore, private notify: () => void) {}

  add(directory: string): Promise<Project> {
    // 解析旧版别名为异步操作。串行查询和插入，避免
    // 并发选择器或 IPC 请求重复注册同一目录。
    const result = this.pending.then(() => this.register(directory));
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private async register(directory: string): Promise<Project> {
    if (!path.isAbsolute(directory)) throw new Error('请选择绝对路径。');
    const canonical = await fs.realpath(directory);
    if (!(await fs.stat(canonical)).isDirectory()) throw new Error('请选择文件夹。');
    const key = directoryKey(canonical);
    for (;;) {
      const previous = this.store.state.projects.map(project => ({ id: project.id, path: project.path }));
      const keys = await Promise.all(previous.map(async project => {
        if (!path.isAbsolute(project.path)) return undefined;
        // 旧工作区缺失或无法访问时，必须保留其记录和历史。
        return fs.realpath(project.path).then(directoryKey, () => undefined);
      }));
      const projects = this.store.state.projects;
      // realpath 等待期间可能移除项目。不能返回过期
      // 身份，也不能向已变化的项目列表注册。
      if (projects.length !== previous.length || projects.some((project, index) => project.id !== previous[index].id || project.path !== previous[index].path)) continue;
      const existing = projects.find((_, index) => keys[index] === key);
      if (existing) return existing;
      const project: Project = { id: randomUUID(), name: path.basename(canonical) || canonical, path: canonical, createdAt: new Date().toISOString() };
      this.store.change(state => state.projects.push(project));
      this.notify();
      return project;
    }
  }
}
