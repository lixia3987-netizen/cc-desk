import {
  queryHistory as queryClaudeHistory,
  readHistory as readClaudeHistory,
  type HistoryQuery,
} from '@cc-desk/engine-claude/history';
import type { HistoryEntry, HistoryPage } from '../shared/types';

export {
  claudeProjects, historyCacheStats, transcriptExists, findClaudeTranscript, exportClaudeTranscript,
  type HistoryQuery, type TranscriptExportSummary,
} from '@cc-desk/engine-claude/history';
export type { HistoryEntry, HistoryPage } from '../shared/types';

/** 结果进入桌面历史界面时，仍携带外部对话记录身份。 */
export async function queryHistory(cwd: string, options: HistoryQuery = {}): Promise<HistoryPage> {
  const page = await queryClaudeHistory(cwd, options);
  return { ...page, entries: page.entries.map(entry => ({ ...entry, providerId: 'claude' })) };
}

export async function readHistory(cwd: string): Promise<HistoryEntry[]> {
  return (await readClaudeHistory(cwd)).map(entry => ({ ...entry, providerId: 'claude' }));
}
