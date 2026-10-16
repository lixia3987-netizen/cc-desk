import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { sharedChatSnapshots } from './shared-chat-snapshot';

export function useSharedChatSnapshot(sessionId: string, conversationId?: string, enabled = true) {
  const subscribe = useCallback((listener: () => void) => sharedChatSnapshots.subscribe(sessionId, listener), [sessionId]);
  const read = useCallback(() => sharedChatSnapshots.get(sessionId), [sessionId]);
  const value = useSyncExternalStore(subscribe, read, read);
  useEffect(() => enabled ? sharedChatSnapshots.acquire(sessionId, conversationId) : undefined, [sessionId, conversationId, enabled]);
  return value;
}
