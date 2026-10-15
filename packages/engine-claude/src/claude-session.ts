import type { ContextUsage, SessionCommand } from '@cc-desk/contracts/execution';
export type { ContextUsage, SessionCommand, SessionCommand as ClaudeCommand } from '@cc-desk/contracts/execution';

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const tokenCount = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const text = (value: unknown, limit: number) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, limit) : '';
const commandName = (value: unknown) => typeof value === 'string' && /^\/?[^\s/\x00-\x1f\x7f]{1,200}$/u.test(value) ? value.replace(/^\//, '') : '';

// 这些命令会替换或退出进程，或切换其工作目录。
// 工作台必须保留自身的会话锁及目录锁，请使用其现有界面。
const managedCommands = new Set(['resume', 'fork', 'exit', 'quit', 'worktree', 'add-dir']);
export function normalizeCommands(value: unknown, previous: SessionCommand[] = [], skills: unknown = []): SessionCommand[] {
  if (!Array.isArray(value)) return previous;
  const skillNames = new Set(Array.isArray(skills) ? skills.map(item => commandName(typeof item === 'string' ? item : record(item).name)).filter(Boolean) : []);
  const old = new Map(previous.map(command => [command.name, command]));
  const hasBuiltinMetadata = value.some(item => typeof record(item).builtin === 'boolean') || previous.some(command => command.kind === 'builtin');
  const commands = new Map<string, SessionCommand>();
  for (const item of value.slice(0, 2048)) {
    const data = record(item), name = commandName(typeof item === 'string' ? item : data.name);
    if (!name) continue;
    const saved = old.get(name);
    const kind = data.builtin === true ? 'builtin' : skillNames.has(name) || data.builtin === false || typeof item !== 'string' && hasBuiltinMetadata ? 'skill' : saved?.kind ?? 'command';
    commands.set(name, {
      name, kind,
      description: text(data.description, 1000) || saved?.description || '',
      argumentHint: text(data.argumentHint ?? data.argument_hint, 240) || saved?.argumentHint || '',
      aliases: Array.isArray(data.aliases) ? [...new Set(data.aliases.map(commandName).filter(Boolean))].slice(0, 30) : saved?.aliases ?? [],
      ...(kind !== 'skill' && managedCommands.has(name) ? { disabledReason: '请使用工作台的会话或目录管理入口' } : {}),
    });
  }
  return [...commands.values()];
}

/** 最近一次主 Agent 输入用量，并非跨请求累计的 result.usage。 */
export function requestContext(previous: ContextUsage | undefined, usage: unknown, model: unknown, at: string): ContextUsage | undefined {
  // 调用方提供交互轮次开始时绑定的模型，绝不使用响应路由
  // 名称。起始模型变更后，即使没有新元数据，用量也会失效。
  const knownModel = previous?.requestModel ?? (previous?.source === 'request' ? previous.model : undefined);
  const nextModel = typeof model === 'string' && model ? model : knownModel;
  const changed = knownModel && nextModel && knownModel !== nextModel;
  const invalidated: ContextUsage | undefined = changed ? { status: 'unknown', model: nextModel, requestModel: nextModel, selectionModel: previous?.selectionModel } : undefined;
  const identityOnly = invalidated ?? (!knownModel && nextModel ? { status: 'unknown' as const, ...previous, requestModel: nextModel } : undefined);
  const data = record(usage), input = tokenCount(data.input_tokens);
  if (input === undefined) return identityOnly;
  const cacheRead = data.cache_read_input_tokens === undefined ? 0 : tokenCount(data.cache_read_input_tokens);
  const cacheWrite = data.cache_creation_input_tokens === undefined ? 0 : tokenCount(data.cache_creation_input_tokens);
  if (cacheRead === undefined || cacheWrite === undefined) return identityOnly;
  const inputTokens = tokenCount(input + cacheRead + cacheWrite);
  if (inputTokens === undefined) return identityOnly;
  return { ...(invalidated ?? previous), model: nextModel, requestModel: nextModel,
    inputTokens, measuredAt: at, source: 'request', status: 'ready' };
}

export function reportedContext(value: unknown, previous: ContextUsage | undefined, at: string): ContextUsage | undefined {
  const data = record(value), inputTokens = tokenCount(data.total_tokens), contextWindow = tokenCount(data.raw_max_tokens);
  if (inputTokens === undefined || !contextWindow) return;
  // 调用方可以将这份新报告绑定到当前进程中观测到的请求；
  // 先前进程的 API 身份不必与当前别名一致。
  return { ...previous, model: text(data.model, 240) || previous?.model, requestModel: undefined, inputTokens, contextWindow, measuredAt: at, source: 'context-command', status: 'ready' };
}

export function contextCapacity(value: unknown, model: string | undefined): number | undefined {
  if (!model) return;
  const models = record(value);
  const exact = record(models[model]);
  const data = Object.keys(exact).length ? exact : Object.values(models).map(record).find(item => item.canonicalModel === model);
  const capacity = tokenCount(data?.contextWindow);
  return capacity && capacity > 0 ? capacity : undefined;
}

/** 来自主会话提示词的 Claude 斜杠命令名称。 */
export function invokedCommand(prompt: string): string | undefined {
  return /^\/([^\s/]+)(?:\s|$)/u.exec(prompt.trimStart())?.[1];
}
