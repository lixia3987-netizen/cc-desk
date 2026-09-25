import { useEffect, useRef, useState } from 'react';
import type { HistoryEntry } from '../../shared/types';
import type { Perform, ReportError } from './types';

export function useHistorySearch(projectId: string, providerId: string, open: boolean, perform: Perform, report: ReportError) {
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyNext, setHistoryNext] = useState<number | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const sequence = useRef(0);
  useEffect(() => {
    if (!open || !projectId || !providerId) return;
    const request = ++sequence.current;
    setHistoryBusy(true); setHistory([]); setHistoryNext(null);
    const timer = setTimeout(() => {
      void window.desktop.queryHistory(projectId, { providerId, query: historyQuery, limit: 50 }).then(page => {
        if (request === sequence.current) { setHistory(page.entries); setHistoryNext(page.nextOffset); }
      }).catch(error => { if (request === sequence.current) report(error); }).finally(() => { if (request === sequence.current) setHistoryBusy(false); });
    }, 200);
    return () => { clearTimeout(timer); sequence.current++; };
  }, [open, projectId, providerId, historyQuery, report]);
  const resetHistory = () => { sequence.current++; setHistory([]); setHistoryNext(null); setHistoryQuery(''); };
  const moreHistory = () => perform(async () => {
    if (historyNext === null || historyBusy) return;
    const request = sequence.current;
    setHistoryBusy(true);
    try {
      const page = await window.desktop.queryHistory(projectId, { providerId, query: historyQuery, offset: historyNext, limit: 50 });
      if (request === sequence.current) {
        setHistory(items => [...items, ...page.entries]); setHistoryNext(page.nextOffset);
      }
    } catch (error) { if (request === sequence.current) throw error; }
    finally { if (request === sequence.current) setHistoryBusy(false); }
  });
  return { historyQuery, setHistoryQuery, historyNext, history, historyBusy, resetHistory, moreHistory };
}
