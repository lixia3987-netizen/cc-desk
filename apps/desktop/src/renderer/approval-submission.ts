export type ApprovalBehavior = 'allow' | 'deny';
export interface ApprovalSubmissionState { behavior: ApprovalBehavior; accepted: boolean }

/** 保持同步锁定，直到已处理的审批从快照中移除。 */
export class ApprovalSubmission {
  state: ApprovalSubmissionState | undefined;
  async submit(
    behavior: ApprovalBehavior,
    send: () => Promise<unknown>,
    changed: (state: ApprovalSubmissionState | undefined) => void,
    beforeSend: () => Promise<void>,
  ): Promise<boolean> {
    if (this.state) return false;
    this.state = { behavior, accepted: false };
    changed(this.state);
    try {
      // 先呈现乐观更新的界面，再让 IPC 恢复工具或模型执行。
      await beforeSend();
      await send();
      this.state = { behavior, accepted: true };
      changed(this.state);
      return true;
    } catch (error) {
      this.state = undefined;
      changed(undefined);
      throw error;
    }
  }
}

export const paintApprovalFeedback = () => new Promise<void>(resolve => {
  requestAnimationFrame(() => { setTimeout(resolve, 0); });
});
