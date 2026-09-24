import fs from 'node:fs';
import type { ChatMessage } from '../../../shared/chat';
import { StateStore } from '../../store';
import { ChatHistory } from '../../chat-history';
import { findClaudeTranscript } from '../../history';
import { readTranscriptPreview } from '../../chat-import';

/** Imports only a stable transcript suffix while the local projection remains idle and unchanged. */
export class TranscriptHydrator {
  private hydrating = new Map<string, Promise<void>>();
  private transcriptVersions = new Map<string, string>();
  constructor(private store: StateStore, private history: ChatHistory, private isActive: (id: string) => boolean,
    private output: { message(id: string, message: ChatMessage): void; system(id: string, text: string): void }) {}
  private session(id: string) {
    const session = this.store.state.sessions.find(item => item.id === id);
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
      const project = this.store.state.projects.find(item => item.id === session.projectId);
      const source = await findClaudeTranscript(session.cwd, sourceId) ?? (project && project.path !== session.cwd ? await findClaudeTranscript(project.path, sourceId) : undefined);
      if (!source) return;
      const before = await fs.promises.stat(source);
      const version = [source, before.dev, before.ino, before.size, before.mtimeMs].join(':');
      if (this.transcriptVersions.get(id) === version) return;
      const preview = await readTranscriptPreview(source);
      const after = await fs.promises.stat(source);
      // Only merge a stable transcript into an idle, unchanged projection.
      // The journal is authoritative while this runtime owns a live CLI process.
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return;
      if (!this.store.state.sessions.some(item => item.id === id) || this.isActive(id)) return;
      const snapshot = this.history.get(id);
      if (snapshot.messages !== original || snapshot.messages.length !== length || snapshot.messages.at(-1) !== last) return;
      this.transcriptVersions.set(id, version);
      let additions = preview.messages;
      if (length) {
        // Older snapshots lack source identities. Do not guess from repeated text
        // or replace valid local history with an unrelated/truncated source tail.
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
