export const MISSING_TRANSCRIPT_ERROR = '无法恢复会话：未找到原会话记录。请检查 Claude 配置目录或从历史记录重新导入；不会自动创建空白会话。';

/** IPC may prefix the original error; unrelated execution errors must not offer a reset. */
export function isMissingTranscriptError(error: string | undefined): boolean {
  return typeof error === 'string' && error.includes(MISSING_TRANSCRIPT_ERROR);
}
