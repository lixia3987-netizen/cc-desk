import type { NativeAgentResult, NativeAgentResultRequest, NativeAgentView } from '../shared/chat';

export const NATIVE_REVIEW_DRAFT_LIMIT = 60000;
export const NATIVE_AGENT_PATCH_PAGE_CHARACTERS = 16000;
const identityFields = ['sessionId', 'conversationId', 'runId', 'requestId', 'workerGeneration'] as const;

/** A reply is useful only for the selected host-owned child and exact requested page. */
export function validateNativeAgentResult(result: NativeAgentResult, sessionId: string, agent: NativeAgentView, request: NativeAgentResultRequest): void {
  const selected = result.agent;
  if (result.acceptance !== 'not_assessed' || selected.childId !== request.childId || selected.batchId !== agent.batchId || selected.mode !== agent.mode ||
    selected.taskId !== agent.taskId || selected.parentTaskId !== agent.parentTaskId || selected.parentIdentity.sessionId !== sessionId ||
    selected.parentIdentity.runId !== request.parentRunId || identityFields.some(field => selected.identity[field] !== agent.identity[field] || selected.parentIdentity[field] !== agent.parentIdentity[field])) {
    throw new Error('成果身份已改变，请关闭后重新读取。');
  }
  const patch = result.patch;
  if (!patch) {
    if (request.patchOffset || request.expectedPatchSha256) throw new Error('保存补丁已不可用，请重新读取成果。');
    return;
  }
  const end = patch.offset + patch.text.length;
  if (!/^[a-f0-9]{64}$/.test(patch.sha256) || !['verified', 'legacy_unverified'].includes(patch.integrity) ||
    ![patch.offset, patch.totalCharacters, patch.totalBytes].every(value => Number.isSafeInteger(value) && value >= 0) ||
    patch.offset !== (request.patchOffset ?? 0) || patch.text.length > (request.patchCharacters ?? NATIVE_AGENT_PATCH_PAGE_CHARACTERS) || end > patch.totalCharacters ||
    (request.expectedPatchSha256 && patch.sha256 !== request.expectedPatchSha256) ||
    (selected.artifact?.sha256 && selected.artifact.sha256 !== patch.sha256) ||
    /^[\uDC00-\uDFFF]/.test(patch.text) || /[\uD800-\uDBFF]$/.test(patch.text) ||
    (patch.nextOffset === null ? end !== patch.totalCharacters : patch.nextOffset !== end || end >= patch.totalCharacters || !patch.text.length)) {
    throw new Error('补丁分页或版本无法确认，请重新读取成果。');
  }
}

/** Closing a viewer or starting another read invalidates late replies and errors. */
export class NativeAgentResultReader {
  private generation = 0;
  constructor(private sessionId: string, private agent: NativeAgentView,
    private load: (request: NativeAgentResultRequest) => Promise<NativeAgentResult>) {}
  cancel(): void { this.generation++; }
  async read(patchOffset = 0, expectedPatchSha256?: string): Promise<NativeAgentResult | undefined> {
    const generation = ++this.generation;
    const request: NativeAgentResultRequest = { parentRunId: this.agent.parentIdentity.runId, childId: this.agent.childId,
      ...(this.agent.artifact || patchOffset || expectedPatchSha256 ? { patchOffset, patchCharacters: NATIVE_AGENT_PATCH_PAGE_CHARACTERS } : {}),
      ...(expectedPatchSha256 ? { expectedPatchSha256 } : {}) };
    try {
      const result = await this.load(request);
      if (generation !== this.generation) return;
      validateNativeAgentResult(result, this.sessionId, this.agent, request);
      return result;
    } catch (error) {
      if (generation === this.generation) throw error;
    }
  }
}

export function nativeAgentReviewPrompt(result: NativeAgentResult, opinion: string, action: 'review' | 'revise'): string {
  if (opinion.length > 2000) throw new Error('审阅意见请控制在 2,000 个字符以内。');
  const { agent, patch } = result;
  const uncertain = agent.status === 'unknown' || agent.missingTerminal;
  const intent = action === 'revise' ? '请检查这份子 Agent 保存成果，并根据我的意见安排修改。重新委派时创建新的子任务，保留原有成果和记录。' :
    uncertain ? '请核查这份子 Agent 保存成果和执行状态，先确认终局与已发生的操作，再讨论后续处理。' :
      agent.mode === 'implement' ? '请先审阅这份子 Agent 保存成果与验证证据。若适合整合，请核对父工作区当前版本，准备明确的文件差异，并通过父回合工具审批执行。' :
        '请审阅这份子 Agent 保存结果与验证证据，结合当前任务给出判断和后续建议。';
  // Model titles and arbitrary request IDs stay in the read-only viewer, never in user instructions.
  return [intent, `父任务 ID：${agent.parentTaskId}`, `父会话：${agent.parentIdentity.sessionId}；conversation：${agent.parentIdentity.conversationId}`,
    `父执行回合：${agent.parentIdentity.runId}`,
    `委派批次：${agent.batchId}`, `子 Agent：${agent.childId}`, `子任务 ID：${agent.taskId}`,
    `子会话：${agent.identity.sessionId}；conversation：${agent.identity.conversationId}`, `子执行回合：${agent.identity.runId}`,
    `保存的执行状态：${agent.status}`,
    patch ? `保存补丁 SHA-256：${patch.sha256}；完整性：${patch.integrity === 'verified' ? '已校验' : '旧记录未建立原始哈希绑定'}` : '本次读取未提供保存补丁。',
    ...(agent.worktree ? [`基线：${agent.worktree.baseCommit}（${agent.worktree.baseline}）`] : []),
    '请使用 read_agent_result 按父执行回合与 childId 读取保存成果。保存补丁反映记录时版本，隔离分支不代表改动已提交或已合入。',
    '子任务结束和本次交接均不代表父任务验收通过。结果未知时不要自动采纳或重放已经执行的操作。',
    `我的审阅意见：\n${opinion.trim() || '请先检查实际改动、验证证据和未解决问题，再提出下一步建议。'}`].join('\n');
}

/** Preserve every character of the existing draft; refuse overflow without truncating it. */
export function appendNativeAgentReviewDraft(draft: string, prompt: string): string {
  const next = draft + (draft ? '\n\n' : '') + prompt;
  if (next.length > NATIVE_REVIEW_DRAFT_LIMIT) throw new Error('追加后将超过输入框 60,000 个字符上限。请先缩短现有草稿或审阅意见。');
  return next;
}
