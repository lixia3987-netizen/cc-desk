import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateWorkflowState, workflowStateSchema } from './workflow-schema';
import type { WorkflowState } from './workflow-schema';

const MAX_STORAGE_BYTES = 64 * 1024 * 1024;

/** Atomic workflow storage keeps the previous durable state available as a backup. */
export class WorkflowStorage {
  readonly file: string;

  constructor(directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, 'workflows.json');
  }

  load(): WorkflowState {
    if (!fs.existsSync(this.file)) return { version: 1, runs: [] };
    try {
      if (fs.statSync(this.file).size > MAX_STORAGE_BYTES) throw new Error('工作流存档过大');
      const state = workflowStateSchema.parse(JSON.parse(fs.readFileSync(this.file, 'utf8')));
      validateWorkflowState(state);
      return state;
    } catch { throw new Error(`工作流数据无法读取，原文件已保留：${this.file}。可从 workflows.json.bak 恢复。`); }
  }

  save(state: WorkflowState): void {
    validateWorkflowState(state);
    const encoded = JSON.stringify(state, null, 2);
    if (Buffer.byteLength(encoded) > MAX_STORAGE_BYTES) throw new Error('工作流存档已达到容量限制');
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, encoded); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
      fs.renameSync(temporary, this.file);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temporary, { force: true });
    }
  }
}
