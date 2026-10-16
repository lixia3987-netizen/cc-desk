import type { ChatSnapshot } from '../shared/chat';
import type { ChatActionState } from './chat-action-state';

export interface ConfirmedChatActionOptions {
  state: ChatActionState;
  key: string;
  kind: string;
  isCurrent: () => boolean;
  paint: () => Promise<void>;
  execute: () => Promise<unknown>;
  /** A scoped read that resolves only after the fresh snapshot has been applied. */
  refreshFresh: () => Promise<ChatSnapshot | undefined>;
  onError: (error: unknown) => void;
}

/** Host acceptance and a subsequent authoritative read are separate operation barriers. */
export async function runConfirmedChatAction({ state, key, kind, isCurrent, paint, execute, refreshFresh, onError }: ConfirmedChatActionOptions): Promise<boolean> {
  const operation = state.begin(key, kind);
  if (!operation) return false;
  try {
    await paint();
    if (!isCurrent() || state.getSnapshot(key)?.token !== operation.token) {
      state.clear(key, operation.token);
      return false;
    }
    await execute();
  } catch (error) {
    state.clear(key, operation.token);
    if (isCurrent()) onError(error);
    return false;
  }

  state.accepted(key, operation.token);
  if (!state.beginSync(key, operation.token)) return true;
  let fresh: ChatSnapshot | undefined;
  try {
    // This callback remains bound to the originating session even after a pane switch.
    fresh = await refreshFresh();
  } catch (error) {
    state.syncFailed(key, operation.token);
    if (isCurrent()) onError(error);
    return true;
  }
  if (fresh) state.synchronized(key, operation.token, fresh.version);
  else {
    state.syncFailed(key, operation.token);
    if (isCurrent()) onError(new Error('操作已受理，但尚未读取到最新会话状态，请核实操作结果。'));
  }
  // The caller clears this token only after its rendering reaches the fresh version.
  return true;
}
