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

/** External transcript identity stays attached when results enter the desktop history UI. */
export async function queryHistory(cwd: string, options: HistoryQuery = {}): Promise<HistoryPage> {
  const page = await queryClaudeHistory(cwd, options);
  return { ...page, entries: page.entries.map(entry => ({ ...entry, providerId: 'claude' })) };
}

export async function readHistory(cwd: string): Promise<HistoryEntry[]> {
  return (await readClaudeHistory(cwd)).map(entry => ({ ...entry, providerId: 'claude' }));
}
