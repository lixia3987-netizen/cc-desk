import type { ClaudeRuntime, ClaudeHost, ClaudeSession, ClaudeCapabilities } from '@cc-desk/engine-claude';
import { createClaudeConfig, parseClaudeConfig } from '@cc-desk/engine-claude/config';
import { cliInvocation, type ClaudeCommandHost } from '@cc-desk/engine-claude/commands';
import { chatArguments } from '@cc-desk/engine-claude/chat-protocol';
import type { PtySubtaskEvent } from '@cc-desk/engine-claude/pty-hooks';

declare const host: ClaudeHost;
declare const commands: ClaudeCommandHost;
declare const runtime: ClaudeRuntime;
declare const session: ClaudeSession;
declare const capabilities: ClaudeCapabilities;
declare const subtask: PtySubtaskEvent;

const config = parseClaudeConfig(createClaudeConfig({ model: 'custom-model', effort: 'high' }));
host.sessions.update(session.id, config);
cliInvocation({ claudePath: 'host-claude' }, commands.environment(), commands);
chatArguments(session, capabilities, false);
if (subtask.type === 'observe') host.subtasks(() => {}).observe(session.id, subtask.observation);
void runtime;
