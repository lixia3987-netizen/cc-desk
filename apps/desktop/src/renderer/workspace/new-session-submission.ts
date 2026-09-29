import type { ChatSubmission } from '../../shared/chat';
import { NATIVE_IMAGE_MAX_BYTES, NATIVE_IMAGE_MAX_COUNT, type NativePastedImage } from '../../shared/native-images';
import type { Attachment, DraftAttachment, NewSession, Session } from '../../shared/types';

export interface NativePastedDraftAttachment extends Attachment {
  kind: 'native-paste';
  selectionId: string;
  image: NativePastedImage;
}
export type NewSessionAttachment = DraftAttachment | NativePastedDraftAttachment;
export const isPastedDraftAttachment = (file: NewSessionAttachment): file is NativePastedDraftAttachment => 'kind' in file && file.kind === 'native-paste';

export interface NewSessionSubmissionPorts {
  createSession(input: NewSession): Promise<Session>;
  saveDraft(id: string, text: string): Promise<void>;
  stageDraftAttachments(id: string, files: DraftAttachment[]): Promise<Attachment[]>;
  addPastedNativeImages(id: string, images: NativePastedImage[]): Promise<Attachment[]>;
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

  submit(input: NewSession, text: string, files: NewSessionAttachment[]): Promise<Session> {
    if (this.inFlight) return this.inFlight;
    if (this.wasAccepted) return Promise.resolve(this.createdSession!);
    if (this.attachmentChange) return Promise.reject(new Error('正在移除附件，请稍候。'));
    if (!text.trim() && !files.length) return Promise.reject(new Error('请先输入消息或添加附件。'));
    if (text.length > 60000) return Promise.reject(new Error('单次提示词请控制在 60,000 个字符以内。'));
    if (files.length > 8 || new Set(files.map(file => file.path)).size !== files.length
      || new Set(files.map(file => file.selectionId)).size !== files.length) {
      return Promise.reject(new Error('最多发送 8 个不同附件。'));
    }
    if (input.continuation) return Promise.reject(new Error('续接会话应先创建未发送草稿，不能自动提交首条消息。'));
    if (input.kind !== 'agent' || input.mode && input.mode !== 'structured' || input.providerId === 'shell') {
      return Promise.reject(new Error('首条消息只支持明确选择的结构化 Agent 引擎。'));
    }
    const providerId = this.createdSession?.execution.providerId ?? input.providerId ?? 'claude';
    if (files.some(isPastedDraftAttachment) && providerId !== 'native') return Promise.reject(new Error('粘贴图片只能交给 Native 引擎，请先移除图片再切换引擎。'));
    if (providerId === 'native' && (files.length > NATIVE_IMAGE_MAX_COUNT || files.reduce((sum, file) => sum + file.bytes, 0) > NATIVE_IMAGE_MAX_BYTES)) {
      return Promise.reject(new Error('Native 待发送图片最多 4 张，合计不能超过 1 MiB。'));
    }
    const submittedInput: NewSession = {
      ...structuredClone(input), title: input.title.trim(), kind: 'agent', mode: 'structured',
      providerId: input.providerId ?? 'claude',
      worktreeName: input.isolated ? input.worktreeName : undefined,
      worktreeBaseRef: input.isolated ? input.worktreeBaseRef : undefined,
    };
    const submittedFiles = structuredClone(files);
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

  private async send(input: NewSession, text: string, files: NewSessionAttachment[]): Promise<Session> {
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
    const remember = (sources: NewSessionAttachment[], copies: Attachment[]) => {
      if (copies.length !== sources.length) throw new Error('附件准备未完成，请重试。');
      sources.forEach((file, index) => {
        const owned = copies[index];
        prepared.set(file.selectionId, owned);
        this.staged.set(file.selectionId, { sourcePath: file.path, owned });
      });
    };
    const diskFiles = missing.filter((file): file is DraftAttachment => !isPastedDraftAttachment(file));
    const pastedImages = missing.filter(isPastedDraftAttachment);
    // Keep each successful batch before starting the next. A failed paste must
    // neither submit a partial message nor duplicate already staged disk files.
    if (diskFiles.length) remember(diskFiles, await this.ports.stageDraftAttachments(session.id, diskFiles));
    if (pastedImages.length) remember(pastedImages, await this.ports.addPastedNativeImages(session.id, pastedImages.map(file => file.image)));
    const paths = files.map(file => prepared.get(file.selectionId)!.path);
    const trimmed = text.trim(), key = JSON.stringify({ text: trimmed, attachments: paths });
    let requestId = this.requestIds.get(key);
    if (!requestId) { requestId = crypto.randomUUID(); this.requestIds.set(key, requestId); }
    await this.ports.submitChat(session.id, trimmed, paths, requestId);
    this.wasAccepted = true;
    return session;
  }
}
