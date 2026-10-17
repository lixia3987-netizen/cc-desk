import type { ChatDisplayPage } from '../shared/chat';

export type ChatPagingDirection = 'before' | 'after';
export interface ChatViewport { top: number; height: number; scrollHeight: number }

/** Fill a short viewport in one direction; only a new reading gesture can reverse it. */
export function chatPagingDirection(page: ChatDisplayPage, viewport: ChatViewport, intent?: ChatPagingDirection, continuing?: ChatPagingDirection): ChatPagingDirection | undefined {
  if (!page.messages.length || viewport.height <= 0) return;
  const short = viewport.scrollHeight <= viewport.height + 2;
  const direction = intent ?? (short ? continuing ?? (page.before ? 'before' : 'after') : undefined);
  if (!direction || !page[direction]) return;
  if (short || direction === 'before' && viewport.top < 180 || direction === 'after' && viewport.scrollHeight - viewport.top - viewport.height < 180) return direction;
}

/** Bound automatic work, including collapsed rows that remain short at the byte cap. */
export class ChatPagingGuard {
  direction?: ChatPagingDirection;
  private paused = false;
  private reads = 0;
  private tried = new Set<string>();

  claim(page: ChatDisplayPage, direction: ChatPagingDirection, userInitiated = false): boolean {
    const cursor = direction === 'before' ? page.messages[0]?.id : page.messages.at(-1)?.id;
    if (!page[direction] || !cursor) return false;
    if (userInitiated) {
      this.paused = false; this.reads = 0; this.tried.clear(); this.direction = direction;
    }
    if (this.paused || this.reads >= 8 || this.direction && this.direction !== direction) return false;
    const key = JSON.stringify([direction, cursor]);
    if (this.tried.has(key)) return false;
    this.direction = direction; this.reads++; this.tried.add(key); return true;
  }

  complete(previous: ChatDisplayPage, next: ChatDisplayPage | undefined, direction: ChatPagingDirection): void {
    if (!next) { this.paused = true; return; }
    const progressed = direction === 'before' ? previous.messages[0]?.id !== next.messages[0]?.id : previous.messages.at(-1)?.id !== next.messages.at(-1)?.id;
    // Reaching the capacity cap can discard the other edge. Automatically
    // reversing at that point would alternately discard and reload both ends.
    const trimmed = direction === 'before' ? previous.after !== next.after : previous.before !== next.before;
    if (!progressed || trimmed) this.paused = true;
  }
}
