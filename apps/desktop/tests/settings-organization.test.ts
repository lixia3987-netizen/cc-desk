import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EngineConfig, EngineConfigField, ExecutionDescriptor } from '../src/shared/execution';
import type { Session, Settings } from '../src/shared/types';
import { EngineConfigFields } from '../src/renderer/EngineConfiguration';
import { EngineDefaultsGroup, SettingsPanel, type SettingsPanelProps } from '../src/renderer/SettingsPanel';
import { engineFieldsForGroup, type EngineSettingsGroup } from '../src/renderer/settings-organization';

const fail = () => { throw new Error('Initial settings rendering must not read, save or generate'); };
const nativeConfig: EngineConfig = { schemaVersion: 1, options: { connectionId: 'saved-connection', model: 'saved-model',
  inputBudgetMode: 'model', maxInputTokens: 64000, maxOutputTokens: 4096, autoCompact: 'before_send', modelRetry: 'off',
  maxModelRequests: 12, maxToolCalls: 20, maxActiveMs: 300000, runtimePolicy: 'custom', mcpConnections: ['saved-service'], projectSkills: ['.agents/skills/read'] } };
const fieldLabels: Record<string, string> = { connectionId: '模型连接', model: '模型覆盖', inputBudgetMode: '输入预算模式', maxInputTokens: '输入预算', maxOutputTokens: '输出上限', autoCompact: '自动压缩', modelRetry: '模型重试', maxModelRequests: '请求上限', maxToolCalls: '工具上限', maxActiveMs: '时长上限', runtimePolicy: '内部策略', permissionMode: '权限模式', effort: '强度' };
function descriptor(providerId = 'native', keys = Object.keys(nativeConfig.options)): ExecutionDescriptor {
  const fields: EngineConfigField[] = keys.map(key => ({ key, label: fieldLabels[key] ?? key, type: key.startsWith('max') ? 'number' : 'text', apply: 'stopped' }));
  return { providerId, mode: 'structured', displayName: providerId === 'native' ? '自研 Agent' : providerId,
    capabilities: { available: true, structured: true, terminal: false, approvals: true, resume: true, fork: false, commands: false, contextUsage: true, liveConfig: false, attachments: false },
    configuration: { schemaVersion: 1, defaults: nativeConfig, fields } };
}
function settings(): Settings {
  return { claudePath: '', shellPath: '', maxSessions: 3, fontSize: 13, scrollback: 10000,
    engineDefaults: { native: structuredClone(nativeConfig), claude: { schemaVersion: 1, options: { model: 'cli-owned-model', effort: 'high', permissionMode: 'plan' } } } };
}
const executors = [descriptor(), descriptor('claude', ['model', 'effort', 'permissionMode'])];
function configControls(node: ReactNode): Array<{ value: EngineConfig; onChange(value: EngineConfig): void }> {
  if (Array.isArray(node)) return node.flatMap(configControls);
  if (!isValidElement<{ children?: ReactNode; value: EngineConfig; onChange(value: EngineConfig): void }>(node)) return [];
  return node.type === EngineConfigFields ? [node.props] : configControls(node.props.children);
}
function renderPanel(options: Partial<SettingsPanelProps> = {}): string {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { desktop: { nativeConnections: undefined, nativeMcp: undefined, claudeModelImport: { preview: fail, import: fail } } } });
  try {
    const value = settings();
    return renderToStaticMarkup(createElement(SettingsPanel, { value, saved: value, onChange: fail, page: 'models', onPage: fail,
      fonts: [], onImport: fail, onRemove: fail, busy: false, error: '', platform: 'win32', dataPath: '/isolated-fixture',
      capabilities: { available: false, executable: '', version: '', efforts: [], flags: [], error: '' }, onSave: fail, onClose: fail,
      onChooseIde: fail, onChooseWorktree: fail, cliUpdate: null, executors, onSessionError: fail, ...options }));
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

test('configuration groups separate model, budget, compaction and execution policy without exposing internal runtimePolicy', () => {
  const config = { ...nativeConfig, options: { ...nativeConfig.options, inputBudgetMode: 'custom' } };
  const groups: EngineSettingsGroup[] = ['model', 'context', 'compaction', 'limits', 'recovery', 'permissions', 'tools'];
  const keys = groups.map(group => engineFieldsForGroup(descriptor(), group, config).map(field => field.key));
  assert.deepEqual(keys, [['connectionId', 'model'], ['inputBudgetMode', 'maxInputTokens', 'maxOutputTokens'], ['autoCompact'], ['maxModelRequests', 'maxToolCalls', 'maxActiveMs'], ['modelRetry'], [], ['mcpConnections', 'projectSkills']]);
  assert.equal(new Set(keys.flat()).size, keys.flat().length);
  assert.ok(!keys.flat().includes('runtimePolicy'));
});

test('model-window mode hides the input number while custom and legacy session values retain their editor', () => {
  const fields = (mode?: string) => {
    const config = structuredClone(nativeConfig);
    if (mode === undefined) delete config.options.inputBudgetMode;
    else config.options.inputBudgetMode = mode;
    return engineFieldsForGroup(descriptor(), 'context', config).map(field => field.key);
  };
  assert.deepEqual(fields('model'), ['inputBudgetMode', 'maxOutputTokens']);
  assert.deepEqual(fields('custom'), ['inputBudgetMode', 'maxInputTokens', 'maxOutputTokens']);
  assert.deepEqual(fields(), ['inputBudgetMode', 'maxInputTokens', 'maxOutputTokens']);
  assert.equal(nativeConfig.options.maxInputTokens, 64000);
});

test('Claude model and effort stay out of global model management while plugin-specific runtime fields remain editable', () => {
  const cli = executors[1];
  for (const group of ['model', 'context', 'compaction', 'limits', 'recovery', 'tools'] as EngineSettingsGroup[]) assert.deepEqual(engineFieldsForGroup(cli, group, cli.configuration!.defaults), []);
  assert.deepEqual(engineFieldsForGroup(cli, 'permissions', cli.configuration!.defaults).map(field => field.key), ['permissionMode']);
  const plugin = descriptor('test.native', ['route', 'responseStyle', 'model', 'effort', 'runtimePolicy']);
  assert.deepEqual(engineFieldsForGroup(plugin, 'limits', plugin.configuration!.defaults).map(field => field.key), ['route', 'responseStyle']);
});

test('editing one defaults group preserves hidden Native values and the complete Claude configuration', () => {
  const original = settings();
  let changed: Settings | undefined;
  const tree = EngineDefaultsGroup({ value: original, onChange: next => { changed = next; }, executors, group: 'context', disabled: false });
  const [controls] = configControls(tree);
  assert.ok(controls);
  controls.onChange({ ...controls.value, options: { ...controls.value.options, maxOutputTokens: 2048 } });
  assert.ok(changed);
  assert.equal(changed.engineDefaults.native.options.maxOutputTokens, 2048);
  assert.equal(changed.engineDefaults.native.options.model, 'saved-model');
  assert.deepEqual(changed.engineDefaults.native.options.mcpConnections, ['saved-service']);
  assert.deepEqual(changed.engineDefaults.native.options.projectSkills, ['.agents/skills/read']);
  assert.deepEqual(changed.engineDefaults.claude, original.engineDefaults.claude);
  assert.equal(original.engineDefaults.native.options.maxOutputTokens, 4096);
});

test('settings keeps seven stable category IDs, separates global connections and context, and explains save scope', () => {
  const connections = renderPanel();
  for (const id of ['appearance', 'models', 'terminal', 'mcp', 'sessions', 'workspace', 'system']) assert.match(connections, new RegExp(`id="settings-tab-${id}"`));
  assert.match(connections, /模型与上下文/);
  assert.match(connections, /<details class="native-model-defaults"><summary>新会话默认模型<\/summary>/);
  assert.match(connections, /从 Claude 默认配置导入/);
  assert.match(connections, /全局资源/);
  assert.doesNotMatch(connections, /aria-label="默认强度"/);
  assert.doesNotMatch(connections, /aria-label="默认自动压缩"/);
  assert.match(connections, /关闭会丢弃未保存的编辑/);
  const context = renderPanel({ initialGroup: 'context' });
  assert.match(context, /id="settings-subtab-models-context"[^>]*aria-selected="true"/);
  assert.match(context, /aria-label="默认输入预算模式"/);
  assert.match(context, /窗口未知时采用 64,000 tokens 输入上限/);
  assert.doesNotMatch(context, /aria-label="默认输入预算"/);
  assert.doesNotMatch(context, /从 Claude 默认配置导入|aria-label="默认自动压缩"/);
  assert.match(context, /role="radio" aria-checked="false" disabled="">当前会话/);
});

test('current-session deep link renders only its group inside one settings form and uses saved defaults', () => {
  const saved = settings();
  saved.engineDefaults.native.options.maxOutputTokens = 2048;
  const draft = structuredClone(saved);
  draft.engineDefaults.native.options.maxOutputTokens = 8192;
  const active: Session = { id: 'isolated-session', projectId: 'isolated-project', title: '当前任务', cwd: '/isolated-fixture', kind: 'agent',
    execution: { providerId: 'native', mode: 'structured' }, engineConfig: { ...nativeConfig, options: { ...nativeConfig.options, runtimePolicy: 'defaults' } },
    started: false, status: 'idle', archived: false, createdAt: '', updatedAt: '' };
  const markup = renderPanel({ initialScope: 'session', initialGroup: 'context', activeSession: active, value: draft, saved });
  assert.equal((markup.match(/<form\b/g) ?? []).length, 1);
  assert.match(markup, /当前会话：当前任务/);
  assert.match(markup, /aria-label="会话输出上限"[^>]*value="2048"/);
  assert.doesNotMatch(markup, /aria-label="会话输出上限"[^>]*value="8192"|aria-label="会话自动压缩"|aria-label="会话模型连接"/);
  assert.match(markup, /会话配置来源/);
});

test('explicit IDE settings target renders the focusable path editor while engine-group targets take precedence', () => {
  const ide = renderPanel({ page: 'workspace', initialSubpage: 'ide' });
  assert.match(ide, /id="settings-subtab-workspace-ide"[^>]*aria-selected="true"/);
  assert.match(ide, /id="ide-application-path"/);
  assert.doesNotMatch(ide, /aria-label="Worktree 位置"/);
  const context = renderPanel({ initialGroup: 'context', initialSubpage: 'connections' });
  assert.match(context, /id="settings-subtab-models-context"[^>]*aria-selected="true"/);
  assert.doesNotMatch(context, /从 Claude 默认配置导入/);
});
