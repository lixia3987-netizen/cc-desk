import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { AppState } from '../../shared/types';
import type { ReportError } from './types';

/** 后端会话变化时，文本草稿仍按本地会话标识保存。 */
export function useSessionDrafts(latestState: RefObject<AppState | undefined>, report: ReportError) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const current = useRef<Record<string, string>>({});
  const pending = useRef(new Map<string, string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const saveDraftFor = useCallback((id: string, value: string) => {
    current.current[id] = value;
    setDrafts(old => ({ ...old, [id]: value }));
    pending.current.set(id, value);
    clearTimeout(timers.current.get(id));
    timers.current.set(id, setTimeout(() => {
      const text = pending.current.get(id);
      pending.current.delete(id);
      timers.current.delete(id);
      if (text !== undefined) void window.desktop.saveDraft(id, text).catch(report);
    }, 300));
  }, [report]);
  const readDraft = useCallback((id: string) => current.current[id]
    ?? latestState.current?.sessions.find(session => session.id === id)?.draft ?? '', [latestState]);
  const clearSentDraft = useCallback((id: string, expected: string) => {
    if (readDraft(id) === expected) saveDraftFor(id, '');
  }, [readDraft, saveDraftFor]);
  const flushDrafts = useCallback(() => {
    for (const [id, text] of pending.current) {
      clearTimeout(timers.current.get(id));
      void window.desktop.saveDraft(id, text).catch(report);
    }
    pending.current.clear();
    timers.current.clear();
  }, [report]);
  const persistDrafts = useCallback(async () => {
    // 更新确认必须等到文本持久化完成，包括未发生变化的定时条目。
    await Promise.all([...pending.current].map(([id, text]) => window.desktop.saveDraft(id, text)));
  }, []);
  const appendDraft = (id: string, text: string) => {
    const value = readDraft(id);
    const next = (value ? value + '\n\n' : '') + text;
    if (next.length > 128 * 1024) {
      report(new Error('草稿过长，请先整理现有内容后再添加。原草稿已保留。'));
      return false;
    }
    saveDraftFor(id, next);
    return true;
  };
  useEffect(() => {
    window.addEventListener('beforeunload', flushDrafts);
    return () => { window.removeEventListener('beforeunload', flushDrafts); flushDrafts(); };
  }, [flushDrafts]);
  return { drafts, saveDraftFor, clearSentDraft, flushDrafts, persistDrafts, appendDraft };
}
