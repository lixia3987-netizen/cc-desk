import type { NewSession, Session } from './types';

/** Missing provenance belongs to an older record and must never imply consent to rename. */
export type SessionTitleSource = 'default' | 'auto' | 'manual';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const TITLE_CHARACTERS = 48;
const TITLE_CODE_UNITS = 120;

/** Empty names opt new Claude conversations into naming; imported/forked names are preserved. */
export function initialSessionTitle(input: Pick<NewSession, 'title' | 'kind' | 'resumeFrom' | 'fork'>):
  { title: string; titleSource: SessionTitleSource } {
  const title = input.title.trim();
  return {
    title: title || (input.kind === 'shell' ? '项目终端' : '新的开发会话'),
    titleSource: !title && input.kind === 'claude' && !input.resumeFrom && !input.fork ? 'default' : 'manual'
  };
}

function shortenTitle(text: string): string {
  const characters: string[] = [];
  let units = 0;
  let truncated = false;
  for (const { segment } of segmenter.segment(text)) {
    if (characters.length === TITLE_CHARACTERS || units + segment.length > TITLE_CODE_UNITS) { truncated = true; break; }
    characters.push(segment); units += segment.length;
  }
  if (!truncated) return text;
  while (characters.length && (characters.length >= TITLE_CHARACTERS || units >= TITLE_CODE_UNITS)) units -= characters.pop()!.length;
  let title = characters.join('');
  // Keep whole words when the boundary is near the end; Chinese does not need spaces.
  const boundary = title.lastIndexOf(' ');
  if (boundary > title.length * 0.65 && /^[\p{L}\p{N}]/u.test(text.slice(title.length))) title = title.slice(0, boundary);
  return title.trimEnd() ? title.trimEnd() + '…' : '';
}

/** Derive a display label locally, without changing a prompt or making another model request. */
export function titleFromPrompt(prompt: string): string | undefined {
  // Bound work for HTTP hooks too. Scan lines so a pasted code block is never used as the title.
  const text = prompt.slice(0, 128 * 1024)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\r\n?/g, '\n').normalize('NFC');
  let fence: { character: string; length: number } | undefined;
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    const delimiter = line.match(/^(`{3,}|~{3,})/);
    if (delimiter) {
      if (!fence) fence = { character: delimiter[1][0], length: delimiter[1].length };
      else if (delimiter[1][0] === fence.character && delimiter[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (fence || !line || /^(?:<\/?pasted_content\b|<\/?[\w-]+(?:\s[^>]*)?>\s*$)/i.test(line)) continue;
    // Preserve prose around pasted context; strip common Markdown presentation, not its content.
    line = line.replace(/^(?:>\s*)+/, '').replace(/^#{1,6}\s+/, '')
      .replace(/^(?:[-+*]|\d+[.)、])\s+(?:\[[ xX]\]\s*)?/, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/(`+)(.*?)\1/g, '$2')
      .replace(/(\*\*|__|~~)(.*?)\1/g, '$2').replace(/\s+/g, ' ').trim();
    if (!line || !/[\p{L}\p{N}]/u.test(line)) continue;
    if (/^(?:\/\S+|https?:\/\/\S+|[A-Za-z]:[\\/].*|\.{0,2}[\\/]\S+)\s*$/i.test(line)) continue;
    // Slash commands and shell commands are not the topic of a new conversation.
    if (/^[!/][\w:.-]+(?:\s|$)/.test(line) || /^(?:\$|PS>)\s/.test(line)) continue;
    // Obvious pasted source, JSON fields and stack frames should not become sidebar labels.
    if (/^(?:[{}[\]]|["'][^"']+["']\s*:|(?:const|let|var|import|export|function|class|def|from|return|package|public|private)\b.*[=;{}():]|at\s+\S+\s*\(|Traceback\b|File\s+["'])/.test(line)) continue;
    if (/^(?:背景|需求|任务|问题|代码|日志|说明|context|request|task|code|logs?|hello|hi|你好|请帮我)[：:！!。.]?$/i.test(line)) continue;
    const sentence = line.match(/^(.+?)(?:[。！？!?]|\.(?:\s|$))/)?.[1]?.trim();
    if (sentence && sentence.length >= 8) line = sentence;
    const title = shortenTitle(line);
    if (title) return title;
  }
  return undefined;
}

/** Apply beside the accepted user message, using the current session to respect a concurrent rename. */
export function automaticSessionTitlePatch(
  session: Pick<Session, 'kind' | 'titleSource' | 'imported' | 'resumeFrom'>,
  prompt: string
): { title: string; titleSource: 'auto' } | undefined {
  if (session.kind !== 'claude' || session.titleSource !== 'default' || session.imported || session.resumeFrom) return undefined;
  const title = titleFromPrompt(prompt);
  return title ? { title, titleSource: 'auto' } : undefined;
}
