export interface ComposerKey {
  key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean;
  isComposing?: boolean; keyCode?: number; repeat?: boolean;
}

export function composerKeyAction(event: ComposerKey, composing = false): 'send' | 'newline' | 'consume' | undefined {
  if (event.key !== 'Enter' || composing || event.isComposing || event.keyCode === 229) return;
  if (event.ctrlKey || event.metaKey || event.shiftKey) return 'newline';
  if (event.altKey) return;
  return event.repeat ? 'consume' : 'send';
}

export function insertComposerNewline(value: string, start: number, end: number) {
  return { value: value.slice(0, start) + '\n' + value.slice(end), caret: start + 1 };
}

/** Keep pasted newlines inside a single CLI prompt and submit only after the paste has ended. */
export function terminalPromptPacket(text: string): string {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)) {
    throw new Error('提示词包含终端控制字符，请移除后重试。');
  }
  return '\x1b[200~' + text.replace(/\r\n?|\n/g, '\r') + '\x1b[201~\r';
}
