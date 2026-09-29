import { useCallback, useRef, useState, type RefObject } from 'react';
import { emptyGitReviewDraft, emptyWorkflowDraft, type PanelDrafts } from '../../shared/panel-drafts';
import type { AppState } from '../../shared/types';
import { ApprovalDrafts } from '../approval-drafts';
import type { ChatReadingPosition } from '../chat-scroll';
import type { ReportError } from './types';

/** Per-session UI memory survives tab switches without being attached to an execution process. */
export function useSessionMemory(latestState: RefObject<AppState | undefined>, report: ReportError) {
  const approvalDrafts = useRef(new ApprovalDrafts());
  const panelDrafts = useRef(new Map<string, PanelDrafts>());
  const readingPositions = useRef(new Map<string, ChatReadingPosition>());
  const [, setRevision] = useState(0);
  const retainSessions = useCallback((ids: string[]) => {
    approvalDrafts.current.retainSessions(ids);
    const keep = new Set(ids);
    for (const id of panelDrafts.current.keys()) if (!keep.has(id)) panelDrafts.current.delete(id);
    for (const id of readingPositions.current.keys()) if (!keep.has(id)) readingPositions.current.delete(id);
  }, []);
  const updatePanel = <K extends keyof PanelDrafts>(id: string, key: K,
    update: (current: NonNullable<PanelDrafts[K]>) => NonNullable<PanelDrafts[K]>) => {
    const session = latestState.current?.sessions.find(session => session.id === id);
    if (!session) return;
    const current = panelDrafts.current.get(id) ?? session.panelDrafts ?? {};
    const initial = current[key] ?? (key === 'workflow' ? emptyWorkflowDraft() : emptyGitReviewDraft());
    const value = update(initial as NonNullable<PanelDrafts[K]>);
    if (value === initial) return;
    panelDrafts.current.set(id, { ...current, [key]: value });
    setRevision(revision => revision + 1);
    // Send edits immediately; the main store batches disk writes and flushes on exit.
    void window.desktop.savePanelDrafts(id, { [key]: value }).catch(report);
  };
  return { approvalDrafts, panelDrafts, readingPositions, retainSessions, updatePanel };
}
