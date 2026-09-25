import type { HistoryPage } from '../../shared/types';

export interface HistoryQuery { providerId?: string; query?: string; offset?: number; limit?: number }
type Source = (cwd: string, options: Omit<HistoryQuery, 'providerId'>) => Promise<{ entries: { id: string; title: string; cwd: string; modifiedAt: string }[]; total: number; nextOffset: number | null }>;

/** External transcripts have provider namespaces independent of local display journals. */
export class HistorySources {
  private sources = new Map<string, Source>();
  register(providerId: string, source: Source) {
    if (this.sources.has(providerId)) throw new Error(`历史来源已注册：${providerId}`);
    this.sources.set(providerId, source);
  }
  async query(cwd: string, input: HistoryQuery = {}): Promise<HistoryPage> {
    const { providerId = 'claude', ...options } = input;
    const source = this.sources.get(providerId);
    if (!source) throw new Error(`此引擎不支持外部历史导入：${providerId}。`);
    const page = await source(cwd, options);
    return { ...page, entries: page.entries.map(entry => ({ ...entry, providerId })) };
  }
}
