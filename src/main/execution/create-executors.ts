import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { getSessionIdentity, type ExecutionCapabilities } from '../../shared/execution';
import type { Capabilities } from '../../shared/types';
import { ClaudeStructuredExecutor } from '../engines/claude/structured-executor';
import { ClaudeTerminalLauncher } from '../engines/claude/terminal-launcher';
import { claudeCapabilities, validateClaudeSession } from '../engines/claude/capabilities';
import { claudeExports } from '../engines/claude/exports';
import { ShellTerminalLauncher } from '../engines/shell/terminal-launcher';
import { Runtime } from '../runtime';
import type { StateStore } from '../store';
import { ExecutionStatePublisher } from './events';
import { ExecutionRegistry } from './registry';
import { PtyExecutor } from './terminal-executor';
import type { SessionExport } from './ports';
import type { TerminalLauncher } from './terminal-launch';

const shellCapabilities: ExecutionCapabilities = {
  available: true, structured: false, terminal: true, approvals: false, resume: false, fork: false,
  commands: false, contextUsage: false, liveConfig: false, attachments: false,
};

/** The only place that chooses and wires concrete execution providers. */
export function createExecutors(store: StateStore, capabilities: () => Capabilities, onError: (error: Error) => void) {
  const registry = new ExecutionRegistry(id => {
    const session = store.state.sessions.find(session => session.id === id);
    if (!session) throw new Error('会话不存在。');
    return session;
  });
  const publisher = new ExecutionStatePublisher(registry.events);
  const terminalSessions = () => store.state.sessions.filter(session => session.execution.mode === 'terminal');
  publisher.publish(terminalSessions());
  const launchers = new Map<string, TerminalLauncher>([
    ['claude', new ClaudeTerminalLauncher(store, capabilities)],
    ['shell', new ShellTerminalLauncher(store)],
  ]);
  const runtime = new Runtime(store, () => publisher.publish(terminalSessions()), chunk => {
    registry.events.emit({ type: 'terminal.data', identity: getSessionIdentity(registry.getSession(chunk.sessionId)), chunk });
  }, { prepare: (session, callbacks) => {
    const launcher = launchers.get(session.execution.providerId);
    if (!launcher) throw new Error('未安装此终端会话的启动器。');
    return launcher.prepare(session, callbacks);
  } }, { onError });
  const pty = new PtyExecutor(runtime, async id => {
    const session = registry.getSession(id);
    const sources = session.execution.providerId === 'claude' ? await claudeExports(session) : [];
    const logs: SessionExport = { label: '保留的终端日志', extension: 'txt', write: destination => fs.writeFile(destination, stripVTControlCharacters(runtime.exportLogs(id)), { mode: 0o600 }) };
    return [...sources, logs];
  });
  const structured = new ClaudeStructuredExecutor(store, capabilities, registry.events);
  for (const mode of ['structured', 'terminal'] as const) {
    const common = {
      providerId: 'claude', capabilities: () => claudeCapabilities(capabilities(), mode), validateSession: validateClaudeSession,
      createIdentity: (input: { conversationId?: string; fork?: boolean }) => ({
        providerId: 'claude', mode, conversationId: input.conversationId && !input.fork ? input.conversationId : randomUUID(),
        forkFrom: input.fork ? input.conversationId : undefined, imported: !!input.conversationId && !input.fork,
      }),
    };
    registry.register(mode === 'structured' ? { ...common, mode, executor: structured } : { ...common, mode, executor: pty });
  }
  registry.register({ providerId: 'shell', mode: 'terminal', executor: pty, capabilities: () => ({ ...shellCapabilities }), createIdentity: () => ({ providerId: 'shell', mode: 'terminal' }) });
  return registry;
}
