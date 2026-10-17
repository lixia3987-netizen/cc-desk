import { useCallback, useEffect, useRef, type RefObject, type WheelEvent } from 'react';
import type { ChatDisplayPage } from '../shared/chat';
import { ChatPagingGuard, chatPagingDirection, type ChatPagingDirection } from './chat-auto-paging';

/** Passive pagination only reads display pages; authority and operation gates stay separate. */
export function useChatPaging({ scope, page, loading, error, scroll, content, earlier, later }: {
  scope: string; page?: ChatDisplayPage; loading: boolean; error: string;
  scroll: RefObject<HTMLDivElement | null>; content: RefObject<HTMLDivElement | null>;
  earlier: () => Promise<ChatDisplayPage | undefined>; later: () => Promise<ChatDisplayPage | undefined>;
}) {
  const guard = useRef({ scope, value: new ChatPagingGuard() });
  if (guard.current.scope !== scope) guard.current = { scope, value: new ChatPagingGuard() };
  const current = useRef({ page, loading, error, earlier, later }); current.current = { page, loading, error, earlier, later };
  const frame = useRef(0), pending = useRef<{ direction?: ChatPagingDirection; user: boolean }>({ user: false });
  const lastTop = useRef(0), busy = useRef(false);

  const request = useCallback(async (direction: ChatPagingDirection, user: boolean) => {
    const state = current.current, owner = guard.current;
    if (owner.scope !== scope || busy.current || state.loading || !state.page || !owner.value.claim(state.page, direction, user)) return;
    busy.current = true;
    try {
      const next = await (direction === 'before' ? state.earlier() : state.later());
      if (guard.current === owner) owner.value.complete(state.page, next, direction);
      return next;
    } finally { if (guard.current === owner) busy.current = false; }
  }, [scope]);

  const schedule = useCallback((direction?: ChatPagingDirection, user = false) => {
    if (direction) pending.current = { direction, user };
    if (frame.current) return;
    // Virtual rows and the scroll anchor must settle before capturing the next
    // reading position. The second frame also coalesces resize/scroll bursts.
    frame.current = requestAnimationFrame(() => { frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const intent = pending.current; pending.current = { user: false };
      const state = current.current, element = scroll.current;
      if (!element || !state.page || state.loading || state.error || guard.current.scope !== scope) return;
      const direction = chatPagingDirection(state.page, { top: element.scrollTop, height: element.clientHeight, scrollHeight: element.scrollHeight }, intent.direction, guard.current.value.direction);
      if (direction) void request(direction, intent.user);
    }); });
  }, [request, scope, scroll]);

  useEffect(() => {
    busy.current = false; lastTop.current = scroll.current?.scrollTop ?? 0;
    const observer = new ResizeObserver(() => schedule());
    if (scroll.current) observer.observe(scroll.current);
    if (content.current) observer.observe(content.current);
    schedule();
    return () => { observer.disconnect(); cancelAnimationFrame(frame.current); frame.current = 0; pending.current = { user: false }; };
  }, [scope, scroll, content, schedule]);
  useEffect(() => { schedule(); }, [page, loading, error, schedule]);

  const onScroll = useCallback((accepted: boolean) => {
    const top = scroll.current?.scrollTop ?? 0, delta = top - lastTop.current; lastTop.current = top;
    if (accepted && delta) schedule(delta < 0 ? 'before' : 'after', true);
  }, [schedule, scroll]);
  const onWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY) schedule(event.deltaY < 0 ? 'before' : 'after', true);
  }, [schedule]);
  return { onScroll, onWheel, earlier: useCallback(() => request('before', true), [request]), later: useCallback(() => request('after', true), [request]) };
}
