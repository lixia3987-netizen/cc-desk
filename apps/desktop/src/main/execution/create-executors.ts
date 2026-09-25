import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { getSessionIdentity, type EngineConfig, type EngineConfiguration, type ExecutionCapabilities } from '../../shared/execution';
import { createClaudeConfig, parseClaudeConfig } from '@cc-desk/engine-claude/config';
import { PERMISSION_MODES, PERMISSION_LABELS } from '@cc-desk/engine-claude/permissions';
import type { Capabilities, Session } from '../../shared/types';
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
  commands: false, contextUsage: false, liveConfig: false, attachments: false, export: true,
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
      providerId: 'claude', displayName: 'Claude Code', history: true,
      capabilities: () => claudeCapabilities(capabilities(), mode), validateSession: validateClaudeSession,
      validateConfig: (config: EngineConfig) => createClaudeConfig(parseClaudeConfig(config)),
      defaultWorkflowError: (session: Session) => parseClaudeConfig(session.engineConfig).permissionMode === 'plan'
        ? '默认工作流包含实现阶段，请先手动将权限切换为默认审批，或创建仅规划的自定义阶段。' : undefined,
      configuration: (): EngineConfiguration => ({
        schemaVersion: 1, defaults: createClaudeConfig(), fields: [
          { key: 'model', label: '模型', type: 'text', placeholder: '默认 / opus / sonnet', apply: 'live' },
          { key: 'effort', label: '推理强度', type: 'select', apply: 'stopped', options: capabilities().efforts.map(value => ({ value, label: value === 'default' ? '跟随 CLI 设置' : value })) },
          { key: 'permissionMode', label: '权限模式', type: 'select', apply: 'restart', options: PERMISSION_MODES.map(value => ({ value, label: PERMISSION_LABELS[value] })), description: '切换绕过审批需要重启会话；其它模式由 CLI 应用。Bypass 下工具可直接修改文件和执行命令，CLI 的强制限制与交互提问仍会生效。' },
        ],
      }),
      createIdentity: (input: { conversationId?: string; fork?: boolean }) => ({
        providerId: 'claude', mode, conversationId: input.conversationId && !input.fork ? input.conversationId : randomUUID(),
        forkFrom: input.fork ? input.conversationId : undefined, imported: !!input.conversationId && !input.fork,
      }),
    };
    registry.register(mode === 'structured' ? { ...common, mode, executor: structured } : { ...common, mode, executor: pty });
  }
  registry.register({ providerId: 'shell', displayName: 'Shell 终端', mode: 'terminal', executor: pty,
    capabilities: () => ({ ...shellCapabilities }),
    configuration: () => ({ schemaVersion: 1, defaults: { schemaVersion: 1, options: {} }, fields: [] }),
    validateConfig: config => {
      if (config.schemaVersion !== 1 || Object.keys(config.options).some(key => key !== 'legacy')) throw new Error('Shell 配置包含不支持的选项。');
      return config;
    },
    createIdentity: () => ({ providerId: 'shell', mode: 'terminal' }) });
  return registry;
}
