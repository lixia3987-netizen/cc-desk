import { chatArguments as buildChatArguments } from '@cc-desk/engine-claude/chat-protocol';
import type { ClaudeSession } from '@cc-desk/engine-claude';
import type { Capabilities, Session } from '../shared/types';
import { projectClaudeSession } from './engines/claude/session';

export { JsonLineDecoder, object, string, userContent, type WireObject } from '@cc-desk/engine-claude/chat-protocol';

export function chatArguments(session: Session | ClaudeSession, capabilities: Capabilities, hasTranscript: boolean) {
  return buildChatArguments('engineConfig' in session ? projectClaudeSession(session) : session, capabilities, hasTranscript);
}
