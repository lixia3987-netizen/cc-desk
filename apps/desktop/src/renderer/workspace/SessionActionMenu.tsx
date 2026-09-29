import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface SessionActionMenuAnchor {
  x: number;
  y: number;
  opener: HTMLElement;
  sessionId: string;
}

export interface SessionActionMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
}

export interface SessionActionMenuProps {
  anchor: SessionActionMenuAnchor;
  title: string;
  items: SessionActionMenuItem[];
  onClose: () => void;
}

const viewportMargin = 8;

export function SessionActionMenu({ anchor, title, items, onClose }: SessionActionMenuProps) {
  const menu = useRef<HTMLDivElement>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const closed = useRef(false);
  const closeCallback = useRef(onClose);
  closeCallback.current = onClose;
  const [position, setPosition] = useState({ left: anchor.x, top: anchor.y });

  const close = (restoreFocus: boolean) => {
    if (closed.current) return;
    closed.current = true;
    closeCallback.current();
    if (restoreFocus && anchor.opener.isConnected && !anchor.opener.closest('[inert]')) {
      anchor.opener.focus({ preventScroll: true });
    }
  };

  useLayoutEffect(() => {
    closed.current = false;
    const element = menu.current;
    if (!element) return;
    (element.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? element).focus({ preventScroll: true });

    const pointerdown = (event: PointerEvent) => {
      if (!event.composedPath().includes(element)) close(false);
    };
    const resize = () => close(true);
    const scroll = (event: Event) => {
      if (event.target instanceof Node && element.contains(event.target)) return;
      if (event.target === window || event.target instanceof Node && event.target.contains(anchor.opener)) close(true);
    };
    document.addEventListener('pointerdown', pointerdown, true);
    window.addEventListener('resize', resize);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', pointerdown, true);
      window.removeEventListener('resize', resize);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [anchor]);

  useLayoutEffect(() => {
    const element = menu.current;
    if (!element || closed.current) return;
    const bounds = element.getBoundingClientRect();
    const left = Math.max(viewportMargin, Math.min(anchor.x, window.innerWidth - bounds.width - viewportMargin));
    const top = Math.max(viewportMargin, Math.min(anchor.y, window.innerHeight - bounds.height - viewportMargin));
    setPosition(previous => previous.left === left && previous.top === top ? previous : { left, top });

    const active = document.activeElement;
    const previous = lastFocused.current;
    const previousInvalid = previous && (!element.contains(previous) || previous instanceof HTMLButtonElement && previous.disabled);
    const focusLost = (!active || active === document.body) && previousInvalid;
    const focusDisabled = active instanceof HTMLButtonElement && element.contains(active) && active.disabled;
    if (focusLost || focusDisabled || active === element) {
      const next = element.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? element;
      if (next !== active) {
        next.focus({ preventScroll: true });
        if (next !== element) next.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [anchor, items, title]);

  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === 'Tab') {
      // Start normal tab navigation at the opener, rather than a removed portal.
      close(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const enabled = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? []);
    if (!enabled.length) return;
    const current = enabled.findIndex(item => item === document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
      : event.key === 'ArrowDown' ? (current + 1) % enabled.length
        : (current < 0 ? enabled.length - 1 : (current + enabled.length - 1) % enabled.length);
    enabled[next].focus({ preventScroll: true });
    enabled[next].scrollIntoView({ block: 'nearest' });
  };

  return createPortal(
    <div ref={menu} className="session-context-menu" role="menu" aria-label={`${title}的会话操作`}
      data-session-id={anchor.sessionId} tabIndex={-1} onKeyDown={keydown}
      onFocus={event => { if (event.target instanceof HTMLElement) lastFocused.current = event.target; }}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
      style={{ position: 'fixed', ...position, boxSizing: 'border-box', maxWidth: `calc(100vw - ${viewportMargin * 2}px)`, maxHeight: `calc(100vh - ${viewportMargin * 2}px)`, overflowY: 'auto' }}>
      <div className="session-context-menu-title" role="presentation">{title}</div>
      {items.map(item => <button key={item.id} type="button" role="menuitem" tabIndex={-1}
        className={`session-context-menu-item${item.danger ? ' is-danger' : ''}${item.separatorBefore ? ' has-separator' : ''}`}
        disabled={item.disabled} onClick={event => {
          event.stopPropagation();
          if (closed.current || item.disabled) return;
          close(true);
          item.onSelect();
        }}>
        {item.icon !== undefined && <span aria-hidden="true">{item.icon}</span>}
        <span>{item.label}</span>
      </button>)}
    </div>,
    document.body
  );
}
