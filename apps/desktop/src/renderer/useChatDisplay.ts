import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatDisplayPage, ChatPageOptions, ChatSnapshot } from '../shared/chat';
import type { ChatReadingPosition } from './chat-scroll';
import { chatDisplayCache, chatDisplayScope, mergeDisplayPage, mergeDisplaySnapshot } from './chat-display-state';
import { sessionReadLifecycle } from './session-read-lifecycle';

export function useChatDisplay(sessionId: string, conversationId: string | undefined, snapshot: ChatSnapshot | undefined, saved?: ChatReadingPosition, protectHistory = false) {
  const scope = chatDisplayScope(sessionId, conversationId);
  const [value, setValue] = useState(() => ({ scope, page: chatDisplayCache.get(sessionId, conversationId) }));
  const [loading, setLoading] = useState(true), [paging, setPaging] = useState(false), [error, setError] = useState('');
  const current = useRef(scope); current.current = scope;
  const request = useRef(0), pageRef = useRef(value.scope === scope ? value.page : chatDisplayCache.get(sessionId, conversationId));
  const authority = useRef(snapshot); authority.current = snapshot;
  const history = useRef(protectHistory); history.current = protectHistory;
  const loadingPage = useRef(false);
  const lastRead = useRef<{ options: ChatPageOptions; direction: 'replace' | 'before' | 'after' }>({ options: {}, direction: 'replace' });
  const publish = useCallback((page: ChatDisplayPage) => {
    pageRef.current = page; chatDisplayCache.set(page); setValue({ scope, page });
  }, [scope]);
  const read = useCallback(async (options: ChatPageOptions = {}, direction: 'replace' | 'before' | 'after' = 'replace') => {
    const seq = ++request.current;
    lastRead.current = { options, direction };
    loadingPage.current = true;
    setLoading(true);
    if (direction !== 'replace') setPaging(true);
    setError('');
    try {
      const page = await sessionReadLifecycle.read(sessionId, () => window.desktop.chatDisplay(sessionId, options));
      if (seq !== request.current || current.current !== scope) return undefined;
      if (!page) { setError('会话记录尚未确认，请重试读取。'); return undefined; }
      if (page.sessionId !== sessionId || (page.conversationId ?? '') !== (conversationId ?? '')) throw new Error('会话上下文已变化，请重新读取记录。');
      let next = mergeDisplayPage(pageRef.current, page, direction);
      if (authority.current) next = mergeDisplaySnapshot(next, authority.current.messages, history.current, authority.current.sourceIncomplete);
      publish(next); setLoading(false);
      return next;
    } catch (reason) {
      if (seq === request.current && current.current === scope) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false); }
      return undefined;
    } finally {
      if (seq === request.current && current.current === scope) { loadingPage.current = false; setPaging(false); setLoading(false); }
    }
  }, [sessionId, conversationId, scope, publish]);
  const stored = value.scope === scope ? value.page : chatDisplayCache.get(sessionId, conversationId);
  const page = useMemo(() => {
    if (!snapshot) return stored;
    if (stored) return mergeDisplaySnapshot(stored, snapshot.messages, protectHistory, snapshot.sourceIncomplete);
    if (!snapshot.messages.length) return stored;
    const messages = snapshot.messages.slice(-50);
    return { sessionId, conversationId, messages, before: snapshot.truncated || snapshot.messages.length > messages.length ? messages[0].id : null,
      after: null, incomplete: !!snapshot.sourceIncomplete } satisfies ChatDisplayPage;
  }, [stored, snapshot, sessionId, conversationId, protectHistory]);
  useEffect(() => {
    pageRef.current = chatDisplayCache.get(sessionId, conversationId);
    setValue({ scope, page: pageRef.current }); setLoading(true); setPaging(false); loadingPage.current = false;
    void read(saved && !saved.follow && saved.messageId ? { around: saved.messageId } : {});
    return () => { request.current++; };
  }, [scope, read]);
  useEffect(() => sessionReadLifecycle.subscribe(sessionId, () => {
    if (current.current === scope) void read(lastRead.current.options, lastRead.current.direction);
  }), [sessionId, scope, read]);
  useEffect(() => {
    // The same render that retires submission/queue feedback already shows its canonical row.
    if (page && page !== stored) publish(page);
  }, [page, stored, publish]);
  const earlier = useCallback(() => {
    const page = pageRef.current;
    if (loadingPage.current || !page?.before || !page.messages.length) return Promise.resolve(undefined);
    return read({ before: page.messages[0].id }, 'before');
  }, [read]);
  return { page, loading, paging, error, read, earlier };
}
