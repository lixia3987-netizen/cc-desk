import type { NewSession, Session } from './types';

/** 缺少来源信息意味着这是旧记录，不能视为同意重命名。 */
export type SessionTitleSource = 'default' | 'auto' | 'manual';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const TITLE_CHARACTERS = 48;
const TITLE_CODE_UNITS = 120;

/** 名称为空的新 Agent 会话会启用自动命名，导入或分叉的名称保持不变。 */
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
  // 截断位置接近末尾时保留完整单词，中文无需依赖空格。
  const boundary = title.lastIndexOf(' ');
  if (boundary > title.length * 0.65 && /^[\p{L}\p{N}]/u.test(text.slice(title.length))) title = title.slice(0, boundary);
  return title.trimEnd() ? title.trimEnd() + '…' : '';
}

/** 仅校验模型生成的名称，不能从用户消息推导名称。 */
export function normalizeGeneratedSessionTitle(output: string): string | undefined {
  let title = output.slice(0, 4096)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .normalize('NFC').trim();
  // 说明文本、代码围栏和多行响应不能用作会话名称。
  if (!title || /[\r\n]/.test(title) || title.startsWith('```')) return undefined;
  title = title.replace(/^(?:标题|会话名称|title)\s*[:：]\s*/i, '').trim()
    .replace(/^["“「『](.*)["”」』]$/u, '$1').replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(title)) return undefined;
  return shortenTitle(title) || undefined;
}

export function canAutomaticallyNameSession(session: Pick<Session, 'kind' | 'titleSource' | 'execution'>): boolean {
  return session.kind === 'agent' && session.titleSource === 'default' && !session.execution.imported && !session.execution.forkFrom;
}

/** 依据当前状态应用生成的名称，以保留同时进行的手动重命名。 */
export function automaticSessionTitlePatch(
  session: Pick<Session, 'kind' | 'titleSource' | 'execution'>,
  generatedTitle: string
): { title: string; titleSource: 'auto' } | undefined {
  if (!canAutomaticallyNameSession(session)) return undefined;
  const title = normalizeGeneratedSessionTitle(generatedTitle);
  return title ? { title, titleSource: 'auto' } : undefined;
}
