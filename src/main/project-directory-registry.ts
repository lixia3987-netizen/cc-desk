import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Project } from '../shared/types';
import type { StateStore } from './store';

const directoryKey = (directory: string) => process.platform === 'win32' ? directory.toLowerCase() : directory;

/** Selecting a directory reuses its workspace identity; old records are never migrated implicitly. */
export class ProjectDirectoryRegistry {
  private pending: Promise<void> = Promise.resolve();
  constructor(private store: StateStore, private notify: () => void) {}

  add(directory: string): Promise<Project> {
    // Resolving legacy aliases is asynchronous. Serialize lookup and insertion so
    // simultaneous picker/IPC requests cannot register the same directory twice.
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
        // Missing/inaccessible old workspaces must keep their records and history.
        return fs.realpath(project.path).then(directoryKey, () => undefined);
      }));
      const projects = this.store.state.projects;
      // Project removal may run while realpath is pending. Do not return a stale
      // identity or register against a project list that has since changed.
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
