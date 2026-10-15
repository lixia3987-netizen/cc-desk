export type ApprovalBehavior = 'allow' | 'deny';
export interface ApprovalSubmissionState { behavior: ApprovalBehavior; accepted: boolean }

/** Keep a synchronous lock until the resolved approval leaves the snapshot. */
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
      // Let the optimistic UI paint before IPC can resume tool/model work.
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
