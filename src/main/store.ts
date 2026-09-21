import fs from 'node:fs';
import path from 'node:path';
import type { AppState } from '../shared/types';
import { stateSchema } from '../shared/schema';

export class StateStore {
  state: AppState;
  readonly file: string;
  constructor(readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, 'workspace.json');
    if (fs.existsSync(this.file)) {
      // Fail closed: never replace corrupt user data with an empty workspace.
      try { this.state = stateSchema.parse(JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
      catch { throw new Error(`工作区数据无法读取，原文件已保留：${this.file}。可从 workspace.json.bak 恢复。`); }
      for (const session of this.state.sessions) {
        if (session.status === 'running' || session.status === 'stopping') session.status = 'stopped';
        if (session.taskState && !['idle','completed','interrupted','error'].includes(session.taskState)) session.taskState = 'interrupted';
      }
    } else {
      this.state = { version: 1, projects: [], sessions: [], settings: { claudePath: '', shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000 } };
    }
  }
  change(update: (draft: AppState) => void): void {
    const next = structuredClone(this.state);
    update(next);
    const validated = stateSchema.parse(next);
    const temp = this.file + '.tmp';
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(validated, null, 2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.bak');
    fs.renameSync(temp, this.file);
    this.state = validated;
  }
}
