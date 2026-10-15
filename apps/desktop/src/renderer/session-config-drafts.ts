import type { EngineConfig, JsonValue } from '../shared/execution';

export interface SessionConfigDraft {
  readonly value: EngineConfig;
  readonly base: EngineConfig;
  readonly persisted: EngineConfig;
  readonly dirty: boolean;
  readonly conflict: boolean;
  readonly busy: boolean;
  readonly saved: boolean;
}

function sameValue(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  if (Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

function sameConfig(left: EngineConfig, right: EngineConfig): boolean {
  return left.schemaVersion === right.schemaVersion && sameValue(left.options, right.options);
}

function cleanDraft(config: EngineConfig): SessionConfigDraft {
  return { value: structuredClone(config), base: structuredClone(config), persisted: structuredClone(config), dirty: false, conflict: false, busy: false, saved: false };
}

/** 由一个设置对话框持有，所有区域编辑同一份完整的会话草稿。 */
export class SessionConfigDraftStore {
  private readonly entries = new Map<string, SessionConfigDraft>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getRevision = (): number => this.revision;
  get(sessionId: string): SessionConfigDraft | undefined { return this.entries.get(sessionId); }
  hasDirty(): boolean { return [...this.entries.values()].some(draft => draft.dirty); }
  dirtySessionIds(): string[] { return [...this.entries].filter(([, draft]) => draft.dirty).map(([id]) => id); }

  private publish(sessionId: string, draft: SessionConfigDraft): void {
    this.entries.set(sessionId, draft);
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }

  observe(sessionId: string, config: EngineConfig): void {
    const current = this.entries.get(sessionId);
    if (!current) { this.publish(sessionId, cleanDraft(config)); return; }
    if (sameConfig(current.persisted, config)) return;
    if (!current.dirty && !current.busy) { this.publish(sessionId, cleanDraft(config)); return; }
    const persisted = structuredClone(config);
    if (sameConfig(current.value, persisted)) {
      this.publish(sessionId, { ...current, base: persisted, persisted, dirty: false, conflict: false });
    } else {
      this.publish(sessionId, { ...current, persisted, dirty: !sameConfig(current.value, persisted), conflict: !sameConfig(current.base, persisted), saved: false });
    }
  }

  change(sessionId: string, value: EngineConfig): void {
    const current = this.entries.get(sessionId);
    if (!current || current.busy) return;
    const next = structuredClone(value);
    if (sameConfig(next, current.persisted)) this.publish(sessionId, cleanDraft(current.persisted));
    else this.publish(sessionId, { ...current, value: next, dirty: true, saved: false });
  }

  discard(sessionId: string): void {
    const current = this.entries.get(sessionId);
    if (!current || current.busy) return;
    this.publish(sessionId, cleanDraft(current.persisted));
  }

  /** 明确解决冲突时，保留已编辑的键，以及其他新保存的键。 */
  keepChanges(sessionId: string): void {
    const current = this.entries.get(sessionId);
    if (!current || current.busy || current.base.schemaVersion !== current.persisted.schemaVersion) return;
    const value = structuredClone(current.persisted);
    const keys = new Set([...Object.keys(current.base.options), ...Object.keys(current.value.options)]);
    for (const key of keys) {
      if (Object.hasOwn(current.base.options, key) === Object.hasOwn(current.value.options, key) && sameValue(current.base.options[key], current.value.options[key])) continue;
      if (Object.hasOwn(current.value.options, key)) value.options[key] = structuredClone(current.value.options[key]);
      else delete value.options[key];
    }
    this.publish(sessionId, { ...current, value, base: structuredClone(current.persisted), dirty: !sameConfig(value, current.persisted), conflict: false, saved: false });
  }

  async save(sessionId: string, write: (config: EngineConfig) => Promise<void>): Promise<void> {
    const current = this.entries.get(sessionId);
    if (!current || !current.dirty || current.busy || current.conflict) return;
    const submitted = structuredClone(current.value);
    this.publish(sessionId, { ...current, busy: true, saved: false });
    try {
      await write(submitted);
      const latest = this.entries.get(sessionId)!;
      if (latest.conflict && !sameConfig(latest.persisted, submitted)) {
        this.publish(sessionId, { ...latest, busy: false });
      } else {
        this.publish(sessionId, { ...latest, base: structuredClone(submitted), persisted: structuredClone(submitted), dirty: !sameConfig(latest.value, submitted), conflict: false, busy: false, saved: true });
      }
    } catch (error) {
      const latest = this.entries.get(sessionId)!;
      this.publish(sessionId, { ...latest, busy: false, saved: false });
      throw error;
    }
  }
}
