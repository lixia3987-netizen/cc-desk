import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AppState } from '../shared/types';
import { persistedStateSchema, stateSchema } from '../shared/schema';
import { isSubtaskActive } from '../shared/subtasks';
import { DEFAULT_TYPOGRAPHY } from '../shared/fonts';
import { randomUUID } from 'node:crypto';

export class StateStore {
  state: AppState;
  readonly file: string;
  private dirty = false;
  private flushTimer?: NodeJS.Timeout;
  private writeError?: Error;
  private migrationSource?: string;
  private migrationBackup?: string;
  constructor(readonly directory: string, private options: { writeDelayMs?: number; onError?: (error: Error) => void } = {}) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, 'workspace.json');
    if (fs.existsSync(this.file)) {
      // 失败时拒绝继续：不能用空工作区替换损坏的用户数据。
      try {
        const original = fs.readFileSync(this.file, 'utf8');
        const stored = JSON.parse(original);
        if (typeof stored.version === 'number' && stored.version > 3) throw new Error('FUTURE_WORKSPACE_VERSION');
        this.state = persistedStateSchema.parse(stored);
        this.dirty = stored.version !== this.state.version;
        if (this.dirty) this.migrationSource = original;
      }
      catch (error) {
        if (error instanceof Error && error.message === 'FUTURE_WORKSPACE_VERSION') throw new Error(`工作区使用更新的数据版本，请升级应用；原文件已保留：${this.file}。`);
        throw new Error(`工作区数据无法读取，原文件已保留：${this.file}。可从备份恢复。`);
      }
      for (const session of this.state.sessions) {
        if (session.status === 'running' || session.status === 'stopping') session.status = 'stopped';
        if (session.taskState && !['idle','completed','interrupted','error'].includes(session.taskState)) session.taskState = 'interrupted';
        for(const task of session.subtasks?.tasks??[])if(isSubtaskActive(task.status)) {
          task.status='interrupted';task.endedAt=new Date().toISOString();task.updatedAt=task.endedAt;
          task.summary='上次运行已结束，未收到此子任务的完成确认。';
          this.dirty=true;
        }
      }
    } else {
      this.state = { version: 3, projects: [], sessions: [], settings: { claudePath: '', shellPath: '', idePath: '', worktreeLocation: 'project', worktreeRoot: '', maxSessions: 4, fontSize: 14, scrollback: 8000, engineDefaults: {}, ...DEFAULT_TYPOGRAPHY } };
    }
  }
  get persistenceError() { return this.writeError; }
  /** 关键变更保持同步。仅可重建的观测结果和草稿可选择批量处理。 */
  change(update: (draft: AppState) => void, options: { defer?: boolean } = {}): boolean {
    const next = structuredClone(this.state);
    update(next);
    if (isDeepStrictEqual(next, this.state)) {
      if (!options.defer) this.flush();
      return false;
    }
    const validated = stateSchema.parse(next);
    if (isDeepStrictEqual(validated, this.state)) {
      if (!options.defer) this.flush();
      return false;
    }
    if (options.defer) {
      this.state = validated;
      this.dirty = true;
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          try { this.flush(); }
          catch (error) {
            // 保留待写入状态以便显式重试；后台失败不能逃逸定时器回调。
            try { this.options.onError?.(error as Error); } catch { /* 错误报告不能使应用崩溃。 */ }
          }
        }, this.options.writeDelayMs ?? 150);
        this.flushTimer.unref();
      }
    } else {
      this.persist(validated);
      this.state = validated;
      this.finishWrite();
    }
    return true;
  }
  /** 刷新所有延迟变更；失败可被观测，且保留变更以便重试。 */
  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!this.dirty) return;
    this.persist(this.state);
    this.finishWrite();
  }
  private finishWrite() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.dirty = false;
    this.writeError = undefined;
  }
  private persist(state: AppState) {
    const temp = this.file + '.tmp';
    try {
      // 轮换的 .bak 会在后续保存时覆盖。应在首次 v3 替换前，
      // 单独保留迁移前的原始字节。
      if (this.migrationSource !== undefined && !this.migrationBackup) {
        const backup = path.join(this.directory, `workspace.pre-v3.${randomUUID()}.json`);
        const fd = fs.openSync(backup, 'wx', 0o600);
        let complete = false;
        try { fs.writeFileSync(fd, this.migrationSource); fs.fsyncSync(fd); complete = true; }
        finally { fs.closeSync(fd); if (!complete) { try { fs.unlinkSync(backup); } catch { /* 原工作区未被改动。 */ } } }
        this.migrationBackup = backup;
      }
      const fd = fs.openSync(temp, 'w', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(state, null, 2)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.bak');
      fs.renameSync(temp, this.file);
      this.migrationSource = undefined;
    } catch (error) {
      this.writeError = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }
}
