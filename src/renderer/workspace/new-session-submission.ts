import type { ChatSubmission } from '../../shared/chat';
import type { Attachment, DraftAttachment, NewSession, Session } from '../../shared/types';

export interface NewSessionSubmissionPorts {
  createSession(input: NewSession): Promise<Session>;
  saveDraft(id: string, text: string): Promise<void>;
  stageDraftAttachments(id: string, files: DraftAttachment[]): Promise<Attachment[]>;
  removeAttachment(id: string, ownedPath: string): Promise<void>;
  submitChat(id: string, text: string, paths: string[], requestId: string): Promise<ChatSubmission>;
  created?(session: Session): void;
}

/** A first message can be retried without creating another session or message. */
export class NewSessionSubmission {
  private createdSession?: Session;
  private wasAccepted = false;
  private inFlight?: Promise<Session>;
  private attachmentChange?: Promise<void>;
  private readonly staged = new Map<string, { sourcePath: string; owned: Attachment }>();
  private readonly requestIds = new Map<string, string>();

  constructor(private readonly ports: NewSessionSubmissionPorts) {}

  get session(): Session | undefined { return this.createdSession; }
  get accepted(): boolean { return this.wasAccepted; }
  get pending(): boolean { return this.inFlight !== undefined; }

  submit(input: NewSession, text: string, files: DraftAttachment[]): Promise<Session> {
    if (this.inFlight) return this.inFlight;
    if (this.wasAccepted) return Promise.resolve(this.createdSession!);
    if (this.attachmentChange) return Promise.reject(new Error('正在移除附件，请稍候。'));
    if (!text.trim() && !files.length) return Promise.reject(new Error('请先输入消息或添加附件。'));
    if (text.length > 60000) return Promise.reject(new Error('单次提示词请控制在 60,000 个字符以内。'));
    if (files.length > 8 || new Set(files.map(file => file.path)).size !== files.length
      || new Set(files.map(file => file.selectionId)).size !== files.length) {
      return Promise.reject(new Error('最多发送 8 个不同附件。'));
    }
    const submittedInput: NewSession = {
      ...input, title: input.title.trim(), kind: 'agent', mode: 'structured',
      providerId: !input.providerId || input.providerId === 'shell' ? 'claude' : input.providerId,
      worktreeName: input.isolated ? input.worktreeName : undefined,
      worktreeBaseRef: input.isolated ? input.worktreeBaseRef : undefined,
    };
    const submittedFiles = files.map(file => ({ ...file }));
    // Set the gate before invoking any port, including a synchronously failing one.
    const operation = Promise.resolve().then(() => this.send(submittedInput, text, submittedFiles)).finally(() => {
      if (this.inFlight === operation) this.inFlight = undefined;
    });
    this.inFlight = operation;
    return operation;
  }

  invalidateAttachment(sourcePath: string): Promise<void> {
    if (this.inFlight) return Promise.reject(new Error('正在发送，请稍候。'));
    if (this.attachmentChange) return Promise.reject(new Error('正在移除附件，请稍候。'));
    const copies = [...this.staged].filter(([, file]) => file.sourcePath === sourcePath);
    const operation = Promise.resolve().then(async () => {
      for (const [selectionId, file] of copies) {
        // The queue checks references under its submission lock. A lost ack must
        // not let removing a chip delete a file already owned by a message.
        await this.ports.removeAttachment(this.createdSession!.id, file.owned.path);
        this.staged.delete(selectionId);
      }
    }).finally(() => { if (this.attachmentChange === operation) this.attachmentChange = undefined; });
    this.attachmentChange = operation;
    return operation;
  }

  private async send(input: NewSession, text: string, files: DraftAttachment[]): Promise<Session> {
    if (!this.createdSession) {
      this.createdSession = await this.ports.createSession(input);
      this.ports.created?.(this.createdSession);
    }
    const session = this.createdSession;
    await this.ports.saveDraft(session.id, text);
    const prepared = new Map<string, Attachment>();
    for (const file of files) {
      const staged = this.staged.get(file.selectionId);
      if (staged?.sourcePath === file.path) prepared.set(file.selectionId, staged.owned);
    }
    const missing = files.filter(file => !prepared.has(file.selectionId));
    if (missing.length) {
      const staged = await this.ports.stageDraftAttachments(session.id, missing);
      if (staged.length !== missing.length) throw new Error('附件准备未完成，请重试。');
      missing.forEach((file, index) => {
        const owned = staged[index];
        prepared.set(file.selectionId, owned);
        this.staged.set(file.selectionId, { sourcePath: file.path, owned });
      });
    }
    const paths = files.map(file => prepared.get(file.selectionId)!.path);
    const trimmed = text.trim(), key = JSON.stringify({ text: trimmed, attachments: paths });
    let requestId = this.requestIds.get(key);
    if (!requestId) { requestId = crypto.randomUUID(); this.requestIds.set(key, requestId); }
    await this.ports.submitChat(session.id, trimmed, paths, requestId);
    this.wasAccepted = true;
    return session;
  }
}
