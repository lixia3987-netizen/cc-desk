interface SessionReads {
  generation: number;
  state: 'ready' | 'deleting' | 'deleted';
  listeners: Set<() => void>;
  pending: number;
}

/** A deletion invalidates passive reads before its IPC or workspace broadcast settles. */
export class SessionReadLifecycle {
  private sessions = new Map<string, SessionReads>();
  private retained?: Set<string>;
  private session(id: string): SessionReads {
    let reads = this.sessions.get(id);
    if (!reads) { reads = { generation: 0, state: 'ready', listeners: new Set(), pending: 0 }; this.sessions.set(id, reads); }
    return reads;
  }
  private release(id: string, reads: SessionReads) {
    if (this.sessions.get(id) === reads && !reads.pending && !reads.listeners.size && reads.state !== 'deleting' &&
        (reads.state === 'ready' || this.retained && !this.retained.has(id))) this.sessions.delete(id);
  }
  retain(ids: string[]) {
    this.retained = new Set(ids);
    for (const [id, reads] of this.sessions) if (!this.retained.has(id)) {
      reads.generation++;
      if (reads.state === 'ready') reads.state = 'deleted';
      this.release(id, reads);
    }
  }
  async read<T>(id: string, action: () => Promise<T>): Promise<T | undefined> {
    if (this.retained && !this.retained.has(id)) return;
    const reads = this.session(id), generation = reads.generation;
    if (reads.state !== 'ready') return;
    reads.pending++;
    const current = () => reads.state === 'ready' && reads.generation === generation;
    try { const value = await action(); return current() ? value : undefined; }
    catch (error) { if (current()) throw error; }
    finally { reads.pending--; this.release(id, reads); }
  }
  subscribe(id: string, refresh: () => void): () => void {
    const reads = this.session(id); reads.listeners.add(refresh);
    return () => { reads.listeners.delete(refresh); this.release(id, reads); };
  }
  async remove<T>(id: string, action: () => Promise<T>): Promise<T> {
    const reads = this.session(id);
    if (reads.state !== 'ready') throw new Error('此会话正在删除或已经删除。');
    reads.generation++; reads.state = 'deleting';
    try {
      const value = await action();
      reads.generation++; reads.state = 'deleted';
      return value;
    } catch (error) {
      reads.generation++; reads.state = this.retained && !this.retained.has(id) ? 'deleted' : 'ready';
      // A failed deletion keeps the session usable, including automatic refresh.
      for (const refresh of reads.state === 'ready' ? reads.listeners : []) {
        try { refresh(); } catch { /* An observer must not replace the deletion error. */ }
      }
      throw error;
    } finally { this.release(id, reads); }
  }
}

export const sessionReadLifecycle = new SessionReadLifecycle();
