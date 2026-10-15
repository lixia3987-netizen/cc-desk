import fs from 'node:fs';
import type { ChatMessage } from '@cc-desk/contracts/chat';
import type { ClaudeSessions, ClaudeHistory as ChatHistory } from './host.js';
import { findClaudeTranscript } from './history.js';
import { readTranscriptPreview } from './chat-import.js';

/** 仅在本地投影保持空闲且未变更时，导入稳定的对话记录后缀。 */
export class TranscriptHydrator {
  private hydrating = new Map<string, Promise<void>>();
  private transcriptVersions = new Map<string, string>();
  constructor(private sessions: ClaudeSessions, private history: ChatHistory, private isActive: (id: string) => boolean,
    private output: { message(id: string, message: ChatMessage): void; system(id: string, text: string): void }) {}
  private session(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('会话不存在。');
    return session;
  }
  forget(id: string) { this.transcriptVersions.delete(id); }
  async hydrate(id: string): Promise<void> {
    const session = this.session(id);
    if (this.isActive(id) || !(session.execution.imported || session.execution.forkFrom || session.started)) return;
    const pending = this.hydrating.get(id); if (pending) return pending;
    const original = this.history.get(id).messages;
    const last = original.at(-1); const length = original.length;
    const operation = (async () => {
      const sourceId = session.execution.forkFrom && !session.started ? session.execution.forkFrom : session.execution.conversationId;
      if (!sourceId) return;
      const projectPath = session.projectPath;
      const source = await findClaudeTranscript(session.cwd, sourceId) ?? (projectPath && projectPath !== session.cwd ? await findClaudeTranscript(projectPath, sourceId) : undefined);
      if (!source) return;
      const before = await fs.promises.stat(source);
      const version = [source, before.dev, before.ino, before.size, before.mtimeMs].join(':');
      if (this.transcriptVersions.get(id) === version) return;
      const preview = await readTranscriptPreview(source);
      const after = await fs.promises.stat(source);
      // 仅将稳定的对话记录合并到空闲且未变更的投影。
      // 本运行时持有活跃 CLI 进程期间，以日志为准。
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return;
      if (!this.sessions.get(id) || this.isActive(id)) return;
      const snapshot = this.history.get(id);
      if (snapshot.messages !== original || snapshot.messages.length !== length || snapshot.messages.at(-1) !== last) return;
      this.transcriptVersions.set(id, version);
      let additions = preview.messages;
      if (length) {
        // 旧快照缺少来源身份。不要根据重复文本猜测身份，
        // 也不要用无关或截断的来源尾部替换有效的本地历史。
        const identity = (message: ChatMessage) => JSON.stringify([message.parentToolUseId ?? null, message.sourceId ?? message.id.replace(/^import:/, '')]);
        const known = new Set(original.map(identity));
        const tail = [...original].reverse().find(message => message.role !== 'system');
        if (!tail || tail.role === 'assistant' && tail.turnId !== 'imported' && !tail.sourceId) return;
        const tailIdentity = identity(tail);
        let anchor = -1;
        for (let index = preview.messages.length - 1; index >= 0; index--) {
          if (identity(preview.messages[index]) === tailIdentity) { anchor = index; break; }
        }
        if (anchor < 0) return;
        additions = preview.messages.slice(anchor + 1).filter(message => !known.has(identity(message)));
      }
      for (const message of additions) this.output.message(id, message);
      if (!length) {
        snapshot.truncated = preview.truncated;
        snapshot.sourceIncomplete = preview.truncated || undefined;
        if (preview.messages.length || preview.truncated) this.output.system(id, preview.truncated ? '已载入原始对话的最近部分；Claude 恢复时使用原始会话记录。' : '已载入 Claude 原始对话记录。');
      }
      if (additions.length || !length && preview.truncated) this.history.flush();
    })();
    this.hydrating.set(id, operation);
    try { await operation; } finally { this.hydrating.delete(id); }
  }
}
