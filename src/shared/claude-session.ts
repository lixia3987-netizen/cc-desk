import type { ContextUsage, SessionCommand } from './execution';
export type { ContextUsage, SessionCommand, SessionCommand as ClaudeCommand } from './execution';

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const tokenCount = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const text = (value: unknown, limit: number) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, limit) : '';
const commandName = (value: unknown) => typeof value === 'string' && /^\/?[^\s/\x00-\x1f\x7f]{1,200}$/u.test(value) ? value.replace(/^\//, '') : '';

// These commands replace/exit the process or switch its working directory. The
// workbench must retain its own session/directory locks; use its existing UI.
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

/** Latest main-agent input, not result.usage (a sum across requests). */
export function requestContext(previous: ContextUsage | undefined, usage: unknown, model: unknown, at: string): ContextUsage | undefined {
  const data = record(usage), input = tokenCount(data.input_tokens);
  if (input === undefined) return;
  const cacheRead = data.cache_read_input_tokens === undefined ? 0 : tokenCount(data.cache_read_input_tokens);
  const cacheWrite = data.cache_creation_input_tokens === undefined ? 0 : tokenCount(data.cache_creation_input_tokens);
  if (cacheRead === undefined || cacheWrite === undefined) return;
  const inputTokens = tokenCount(input + cacheRead + cacheWrite);
  if (inputTokens === undefined) return;
  const nextModel = typeof model === 'string' && model ? model : previous?.model;
  return { ...previous, model: nextModel, contextWindow: nextModel === previous?.model ? previous?.contextWindow : undefined,
    inputTokens, measuredAt: at, source: 'request', status: 'ready' };
}

export function reportedContext(value: unknown, previous: ContextUsage | undefined, at: string): ContextUsage | undefined {
  const data = record(value), inputTokens = tokenCount(data.total_tokens), contextWindow = tokenCount(data.raw_max_tokens);
  if (inputTokens === undefined || !contextWindow) return;
  return { ...previous, model: text(data.model, 240) || previous?.model, inputTokens, contextWindow, measuredAt: at, source: 'context-command', status: 'ready' };
}

export function contextCapacity(value: unknown, model: string | undefined): number | undefined {
  if (!model) return;
  const models = record(value);
  const exact = record(models[model]);
  const data = Object.keys(exact).length ? exact : Object.values(models).map(record).find(item => item.canonicalModel === model);
  const capacity = tokenCount(data?.contextWindow);
  return capacity && capacity > 0 ? capacity : undefined;
}

export { invokedCommand, slashQuery, insertCommand, matchingCommands } from './session-commands';
