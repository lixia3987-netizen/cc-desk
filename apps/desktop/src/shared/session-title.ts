import type { NewSession, Session } from './types';

/** Missing provenance belongs to an older record and must never imply consent to rename. */
export type SessionTitleSource = 'default' | 'auto' | 'manual';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const TITLE_CHARACTERS = 48;
const TITLE_CODE_UNITS = 120;

/** Empty names opt new agent conversations into naming; imported/forked names are preserved. */
export function initialSessionTitle(input: Pick<NewSession, 'title' | 'kind' | 'conversationId' | 'fork'>):
  { title: string; titleSource: SessionTitleSource } {
  const title = input.title.trim();
  return {
    title: title || (input.kind === 'shell' ? '项目终端' : '新的开发会话'),
    titleSource: !title && input.kind === 'agent' && !input.conversationId && !input.fork ? 'default' : 'manual'
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

/** Validate a model-generated label only; never derive a label from the user's message. */
export function normalizeGeneratedSessionTitle(output: string): string | undefined {
  let title = output.slice(0, 4096)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .normalize('NFC').trim();
  // Explanations, fenced blocks and multi-line responses are not session labels.
  if (!title || /[\r\n]/.test(title) || title.startsWith('```')) return undefined;
  title = title.replace(/^(?:标题|会话名称|title)\s*[:：]\s*/i, '').trim()
    .replace(/^["“「『](.*)["”」』]$/u, '$1').replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(title)) return undefined;
  return shortenTitle(title) || undefined;
}

export function canAutomaticallyNameSession(session: Pick<Session, 'kind' | 'titleSource' | 'execution'>): boolean {
  return session.kind === 'agent' && session.titleSource === 'default' && !session.execution.imported && !session.execution.forkFrom;
}

/** Apply a generated label against current state to respect concurrent manual renames. */
export function automaticSessionTitlePatch(
  session: Pick<Session, 'kind' | 'titleSource' | 'execution'>,
  generatedTitle: string
): { title: string; titleSource: 'auto' } | undefined {
  if (!canAutomaticallyNameSession(session)) return undefined;
  const title = normalizeGeneratedSessionTitle(generatedTitle);
  return title ? { title, titleSource: 'auto' } : undefined;
}
