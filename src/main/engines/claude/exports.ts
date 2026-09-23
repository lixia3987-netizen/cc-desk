import fs from 'node:fs/promises';
import type { Session } from '../../../shared/types';
import type { SessionExport } from '../../execution/ports';
import { exportClaudeTranscript, findClaudeTranscript } from '../../history';

export async function claudeExports(session: Session, journal?: () => string): Promise<SessionExport[]> {
  const conversationId = session.execution.conversationId;
  if (!conversationId) return [];
  const transcript = await findClaudeTranscript(session.cwd, conversationId);
  if (transcript) return [{ label: '完整可用 CLI 对话 JSONL', extension: 'jsonl', write: async destination => { await exportClaudeTranscript(session.cwd, conversationId, destination); } }];
  if (!journal) return [];
  return [{ label: '本工作台事件（不含导入前原文）', extension: 'jsonl', suffix: 'events', write: async destination => {
    await fs.copyFile(journal(), destination); await fs.chmod(destination, 0o600);
  } }];
}
