import type { SessionCommand } from './execution';

export function invokedCommand(prompt: string): string | undefined {
  return /^\/([^\s/]+)(?:\s|$)/u.exec(prompt.trimStart())?.[1];
}

/** A slash at the beginning of the prompt, with the caret in its command name. */
export function slashQuery(value: string, start: number, end: number): string | undefined {
  if (start !== end) return;
  const match = /^\s*\/([^\s/]*)/u.exec(value);
  if (!match || start < match[0].length - match[1].length || start > match[0].length) return;
  return match[1];
}
export function insertCommand(value: string, name: string): { value: string; caret: number } {
  const match = /^(\s*)\/[^\s/]*/u.exec(value);
  if (!match) return { value, caret: value.length };
  const prefix = match[1] + '/' + name + ' ';
  return { value: prefix + value.slice(match[0].length).replace(/^\s/, ''), caret: prefix.length };
}

export function matchingCommands(commands: SessionCommand[], query: string): SessionCommand[] {
  const needle = query.toLocaleLowerCase();
  return commands.filter(command => [command.name, command.description, ...command.aliases].some(value => value.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => Number(b.name.toLocaleLowerCase().startsWith(needle)) - Number(a.name.toLocaleLowerCase().startsWith(needle)) || a.name.localeCompare(b.name));
}
