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
      // Fail closed: never replace corrupt user data with an empty workspace.
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
  /** Critical changes remain synchronous. Only reproducible observations/drafts may opt into batching. */
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
            // Retain dirty state for explicit retry; background failures never escape a timer.
            try { this.options.onError?.(error as Error); } catch { /* Reporting must not crash the app. */ }
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
  /** Flush all deferred changes; a failure is observable and leaves them available for retry. */
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
      // A rolling .bak is overwritten on subsequent saves. Preserve the exact
      // pre-migration bytes separately before the first v3 replacement.
      if (this.migrationSource !== undefined && !this.migrationBackup) {
        const backup = path.join(this.directory, `workspace.pre-v3.${randomUUID()}.json`);
        const fd = fs.openSync(backup, 'wx', 0o600);
        let complete = false;
        try { fs.writeFileSync(fd, this.migrationSource); fs.fsyncSync(fd); complete = true; }
        finally { fs.closeSync(fd); if (!complete) { try { fs.unlinkSync(backup); } catch { /* Original workspace is untouched. */ } } }
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
