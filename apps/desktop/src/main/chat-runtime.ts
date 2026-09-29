import { ClaudeRuntime, type ClaudeRuntimeOptions } from '@cc-desk/engine-claude';
import type { SessionTitleGenerator } from './session-titles';
import type { StateStore } from './store';
import { createClaudeHost } from './engines/claude/host';

export type ChatRuntimeOptions = ClaudeRuntimeOptions & { titleGenerator?: SessionTitleGenerator };
/** Compatibility composition for desktop callers and existing Claude protocol fixtures. */
export class ChatRuntime extends ClaudeRuntime {
  constructor(store: StateStore, onState: () => void, onEvents: (sessionId: string) => void, options: ChatRuntimeOptions = {}) {
    super(createClaudeHost(store, onState, onEvents, options.titleGenerator), options);
  }
}
