import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { ChatMessage } from '../shared/chat';
import { VirtualChatLayout } from './virtual-chat-layout';

export interface VirtualChatMessagesHandle {
  /** Mount the row before a caller performs its existing DOM-based scroll restoration. */
  ensureMessage(id: string): Promise<boolean>;
}

export interface VirtualChatMessagesProps {
  items: readonly ChatMessage[];
  renderMessage: (message: ChatMessage) => ReactNode;
  scrollRef: RefObject<HTMLDivElement | null>;
  initialAnchorId?: string;
  initialFollow?: boolean;
}

interface ReadingWindow {
  ready: boolean;
  top: number;
  height: number;
  anchorId?: string;
  inside: number;
}

const MeasuredMessage = memo(function MeasuredMessage({ message, renderMessage, register }: {
  message: ChatMessage;
  renderMessage: (message: ChatMessage) => ReactNode;
  register: (id: string, element: HTMLDivElement | null) => void;
}) {
  const ref = useCallback((element: HTMLDivElement | null) => register(message.id, element), [message.id, register]);
  // A flow root contains the message's margins, making the measured row and spacer agree.
  return <div ref={ref} data-virtual-message-id={message.id} style={{ display: 'flow-root', minWidth: 0 }}>{renderMessage(message)}</div>;
});

/** Virtualizes only canonical messages; approvals and submission feedback stay outside it. */
export const VirtualChatMessages = memo(forwardRef<VirtualChatMessagesHandle, VirtualChatMessagesProps>(function VirtualChatMessages({ items, renderMessage, scrollRef, initialAnchorId, initialFollow = true }, ref) {
  const layout = useRef(new VirtualChatLayout()).current;
  layout.setItems(items.map(message => message.id));
  const root = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const rowObserver = useRef<ResizeObserver | undefined>(undefined);
  const reading = useRef<ReadingWindow>({ ready: false, top: 0, height: 800, inside: 0 });
  const forced = useRef<string | undefined>(undefined);
  const mounted = useRef(false);
  const frame = useRef(0), resolutionFrame = useRef(0);
  const needsScrollRead = useRef(false), needsRender = useRef(false), userInteracted = useRef(false);
  const waiters = useRef(new Map<string, Set<(mounted: boolean) => void>>());
  const scheduleLatest = useRef<(readScroll?: boolean) => void>(() => {});
  const current = useRef({ items, initialAnchorId, initialFollow });
  current.current = { items, initialAnchorId, initialFollow };
  const [, redraw] = useState(0);

  const settleMounted = useCallback(() => {
    if (resolutionFrame.current) return;
    resolutionFrame.current = requestAnimationFrame(() => {
      resolutionFrame.current = 0;
      for (const [id, callbacks] of waiters.current) {
        const exists = layout.indexOf(id) >= 0;
        const ready = exists && !!rows.current.get(id)?.isConnected;
        const active = forced.current === id;
        if (ready || !exists || !active) {
          waiters.current.delete(id);
          if (active) {
            // Mounting is a temporary lease for the caller's scroll restore,
            // not a permanent viewport lock. Its promise continuation runs
            // before the next frame reads the resulting programmatic scroll.
            forced.current = undefined;
            if (ready) {
              reading.current.ready = true;
              reading.current.top = Math.max(0, layout.offset(layout.indexOf(id)) - reading.current.height / 3);
              // Measurements may change before an already queued redraw commits.
              // Keep the mounted target by identity until the actual scroll is read.
              reading.current.anchorId = id;
              reading.current.inside = 0;
            }
            scheduleLatest.current(true);
          }
          for (const resolve of callbacks) resolve(ready && active);
        }
      }
      if (waiters.current.size) settleMounted();
    });
  }, [layout]);

  const schedule = useCallback((readScroll = false) => {
    needsScrollRead.current ||= readScroll;
    needsRender.current = true;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const element = scrollRef.current, list = root.current;
      const view = reading.current;
      if (element && list) {
        view.height = element.clientHeight || view.height;
        if (needsScrollRead.current) {
          // The list may follow history notices or other always-mounted content.
          const listOffset = list.getBoundingClientRect().top - element.getBoundingClientRect().top - element.clientTop + element.scrollTop;
          const top = Math.max(0, element.scrollTop - listOffset);
          const { items: latestItems, initialAnchorId: anchor, initialFollow: follow } = current.current;
          const initialIndex = anchor ? layout.indexOf(anchor) : follow ? layout.length - 1 : 0;
          const initialScroll = !view.ready && initialIndex > 0 && element.scrollTop === 0 && !userInteracted.current;
          const target = forced.current === undefined ? undefined : rows.current.get(forced.current);
          const bounds = target?.getBoundingClientRect(), viewport = element.getBoundingClientRect();
          const targetVisible = !!bounds && bounds.bottom > viewport.top + element.clientTop && bounds.top < viewport.top + element.clientTop + element.clientHeight;
          if (!initialScroll && (!forced.current || targetVisible || userInteracted.current)) {
            forced.current = undefined;
            view.ready = true;
            view.top = top;
            const index = layout.indexAt(top);
            view.anchorId = latestItems[index]?.id;
            view.inside = top - layout.offset(index);
          }
        }
      }
      needsScrollRead.current = false;
      userInteracted.current = false;
      if (needsRender.current && mounted.current) { needsRender.current = false; redraw(value => value + 1); }
    });
  }, [layout, scrollRef]);
  scheduleLatest.current = schedule;

  const register = useCallback((id: string, element: HTMLDivElement | null) => {
    const old = rows.current.get(id);
    if (old && old !== element) rowObserver.current?.unobserve(old);
    if (element) {
      rows.current.set(id, element);
      rowObserver.current?.observe(element);
    } else rows.current.delete(id);
  }, []);

  useImperativeHandle(ref, () => ({
    ensureMessage(id) {
      if (!mounted.current || layout.indexOf(id) < 0) return Promise.resolve(false);
      forced.current = id;
      const promise = new Promise<boolean>(resolve => {
        let callbacks = waiters.current.get(id);
        if (!callbacks) waiters.current.set(id, callbacks = new Set());
        callbacks.add(resolve);
      });
      redraw(value => value + 1);
      settleMounted();
      return promise;
    },
  }), [layout, settleMounted]);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelAnimationFrame(frame.current); cancelAnimationFrame(resolutionFrame.current);
      frame.current = 0; resolutionFrame.current = 0;
      for (const callbacks of waiters.current.values()) for (const resolve of callbacks) resolve(false);
      waiters.current.clear();
    };
  }, []);

  // The scroll element belongs to a parent host node. Child layout effects may
  // run before that parent's ref is attached; a passive effect sees both refs
  // and must not silently skip binding the only scroll/measurement observers.
  useEffect(() => {
    const element = scrollRef.current, list = root.current;
    if (!element || !list) return;
    reading.current.height = element.clientHeight || reading.current.height;
    const onScroll = () => schedule(true);
    const onInteraction = () => { userInteracted.current = true; schedule(true); };
    element.addEventListener('scroll', onScroll, { passive: true });
    element.addEventListener('wheel', onInteraction, { passive: true });
    element.addEventListener('touchstart', onInteraction, { passive: true });
    element.addEventListener('pointerdown', onInteraction, { passive: true });
    element.addEventListener('keydown', onInteraction);
    const observer = new ResizeObserver(entries => {
      let changed = false;
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.virtualMessageId;
        if (id) changed = layout.measure(id, entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height) || changed;
      }
      if (changed) schedule();
    });
    rowObserver.current = observer;
    for (const row of rows.current.values()) observer.observe(row);
    let width = list.getBoundingClientRect().width;
    const sizeObserver = new ResizeObserver(() => {
      const nextWidth = list.getBoundingClientRect().width;
      if (Math.abs(nextWidth - width) >= 0.5) {
        width = nextWidth;
        layout.resetMeasurements();
        for (const [id, row] of rows.current) layout.measure(id, row.getBoundingClientRect().height);
      }
      schedule();
    });
    sizeObserver.observe(element); sizeObserver.observe(list);
    schedule();
    return () => {
      element.removeEventListener('scroll', onScroll);
      element.removeEventListener('wheel', onInteraction);
      element.removeEventListener('touchstart', onInteraction);
      element.removeEventListener('pointerdown', onInteraction);
      element.removeEventListener('keydown', onInteraction);
      observer.disconnect(); sizeObserver.disconnect();
      if (rowObserver.current === observer) rowObserver.current = undefined;
    };
  }, [layout, schedule, scrollRef]);

  // Prepending/cropping can keep scrollTop unchanged, so no native scroll event
  // is guaranteed. Read the actual viewport after the parent's anchor restore.
  useLayoutEffect(() => { schedule(true); }, [items, schedule]);

  useLayoutEffect(() => { if (waiters.current.size) settleMounted(); });

  const view = reading.current;
  const forcedIndex = forced.current ? layout.indexOf(forced.current) : -1;
  const anchorIndex = view.anchorId ? layout.indexOf(view.anchorId) : -1;
  const initialIndex = initialAnchorId ? layout.indexOf(initialAnchorId) : -1;
  let top = view.top;
  if (forcedIndex >= 0) top = Math.max(0, layout.offset(forcedIndex) - view.height / 3);
  else if (!view.ready) top = initialIndex >= 0 ? Math.max(0, layout.offset(initialIndex) - view.height / 3) : initialFollow ? Math.max(0, layout.totalHeight - view.height) : 0;
  else if (anchorIndex >= 0) top = layout.offset(anchorIndex) + Math.min(Math.max(0, view.inside), Math.max(0, layout.size(anchorIndex) - 1));
  const range = layout.range(top, view.height, 400);

  return <div ref={root} className="virtual-chat-messages" data-virtual-chat-list="" data-message-count={items.length} data-virtual-start={range.start} data-virtual-end={range.end} style={{ display: 'flow-root', minWidth: 0, overflowAnchor: 'none' }}>
    <div aria-hidden="true" data-virtual-spacer="before" style={{ height: range.before }} />
    {items.slice(range.start, range.end).map(message => <MeasuredMessage key={message.id} message={message} renderMessage={renderMessage} register={register} />)}
    <div aria-hidden="true" data-virtual-spacer="after" style={{ height: range.after }} />
  </div>;
}));
