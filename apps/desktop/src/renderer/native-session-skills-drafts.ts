import type { EngineConfig } from '../shared/execution';
import type { NativeSessionSkillsSave, NativeSessionSkillsSaved, NativeSessionSkillsView, NativeSkillsAPI } from '../shared/native-skills';

export interface NativeSessionSkillsDraft {
  readonly config: EngineConfig;
  readonly view?: NativeSessionSkillsView;
  readonly selected: readonly string[];
  readonly baseDigest?: string;
  readonly dirty: boolean;
  readonly conflict: boolean;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly error: string;
  readonly notice: string;
  readonly attempt?: NativeSessionSkillsSave;
}
const encode = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
const samePaths = (left: readonly string[], right: readonly string[]) => encode([...left].sort()) === encode([...right].sort());
/** This local settings endpoint returns actionable Chinese messages; never copy raw filesystem errors or stacks. */
export function nativeSessionSkillsError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.replace(/^Error invoking remote method 'native:session-skills(?:-save)?': (?:Error: )?/, '').replace(/^Error: /, '');
  return message.length > 0 && message.length <= 400 && /^(?:[\u3400-\u9fff]|Skills )/.test(message)
    && /请|需要|无法|尚未|已保存|已变化/.test(message) && !/[\\/\x00-\x1f\x7f]|[a-f0-9]{64}|https?:|\bat\s+\S+\(/i.test(message) ? message : fallback;
}
export function legacySkillPaths(view: Pick<NativeSessionSkillsView, 'policy'>): string[] | undefined {
  const policy = view.policy;
  return policy.mode === 'legacy' && !policy.autoActivation && policy.disabledIds.length === 0 && policy.pins.every(pin => pin.kind === 'legacy')
    ? policy.pins.map(pin => (pin as { kind: 'legacy'; path: string }).path) : undefined;
}
export function savedLegacySkillPaths(config: EngineConfig): string[] {
  if (config.schemaVersion === 1) return Array.isArray(config.options.projectSkills) ? config.options.projectSkills.filter((path): path is string => typeof path === 'string') : [];
  const policy = config.options.skills;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || !Array.isArray(policy.pins)) return [];
  return policy.pins.flatMap(pin => pin && typeof pin === 'object' && !Array.isArray(pin) && pin.kind === 'legacy' && typeof pin.path === 'string' ? [pin.path] : []);
}
const clean = (config: EngineConfig): NativeSessionSkillsDraft => ({ config: structuredClone(config), selected: savedLegacySkillPaths(config), dirty: false,
  conflict: false, loading: false, saving: false, error: '', notice: '' });

/** Session-scoped selections outlive settings sections. A failed write retains its exact retry input. */
export class NativeSessionSkillsDraftStore {
  private entries = new Map<string, NativeSessionSkillsDraft>();
  private epochs = new Map<string, number>();
  constructor(private readonly changed: () => void = () => {}) {}
  get(id: string): NativeSessionSkillsDraft | undefined { return this.entries.get(id); }
  dirtySessionIds(): string[] { return [...this.entries].filter(([, entry]) => entry.dirty || entry.saving || Boolean(entry.attempt)).map(([id]) => id); }
  private publish(id: string, entry: NativeSessionSkillsDraft) { this.entries.set(id, entry); this.changed(); }
  observeConfig(id: string, config: EngineConfig) {
    const entry = this.entries.get(id);
    if (!entry) { this.publish(id, clean(config)); return; }
    if (encode(entry.config) === encode(config)) return;
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
    if (!entry.dirty && !entry.saving && !entry.attempt) this.publish(id, clean(config));
    else this.publish(id, { ...entry, config: structuredClone(config), view: undefined, loading: false, conflict: true, notice: '' });
  }
  change(id: string, selected: readonly string[]) {
    const entry = this.entries.get(id); if (!entry) return;
    const saved = entry.view && legacySkillPaths(entry.view);
    this.publish(id, { ...entry, selected: [...selected].sort(), dirty: !saved || !samePaths(selected, saved), notice: '' });
  }
  async read(id: string, api: Pick<NativeSkillsAPI, 'getSessionSkills'>): Promise<void> {
    const entry = this.entries.get(id); if (!entry || entry.loading || entry.saving) return;
    const epoch = (this.epochs.get(id) ?? 0) + 1; this.epochs.set(id, epoch);
    this.publish(id, { ...entry, loading: true, error: '' });
    try {
      const view = await api.getSessionSkills({ sessionId: id });
      if (this.epochs.get(id) !== epoch) return;
      const latest = this.entries.get(id)!, paths = legacySkillPaths(view);
      if (!paths) {
        this.publish(id, { ...latest, view: undefined, loading: false, conflict: true, error: '当前技能配置尚不支持在此编辑，原配置已保留。' });
        return;
      }
      const preserve = latest.dirty || Boolean(latest.attempt);
      this.publish(id, { ...latest, view: structuredClone(view), selected: preserve ? latest.selected : paths,
        baseDigest: preserve ? latest.baseDigest : view.configDigest,
        dirty: preserve ? !samePaths(latest.selected, paths) : false,
        conflict: preserve && (latest.conflict || latest.baseDigest !== view.configDigest), loading: false, error: '' });
    } catch (error) {
      if (this.epochs.get(id) === epoch) this.publish(id, { ...this.entries.get(id)!, loading: false, error: nativeSessionSkillsError(error, '读取技能配置失败，请重试；已有选择已保留。') });
    }
  }
  resolve(id: string, retain: boolean) {
    const entry = this.entries.get(id), paths = entry?.view && legacySkillPaths(entry.view);
    if (!entry || !paths || entry.loading || entry.saving) return;
    this.publish(id, { ...entry, selected: retain ? entry.selected : paths, baseDigest: entry.view!.configDigest,
      dirty: retain && !samePaths(entry.selected, paths), conflict: false, attempt: undefined, error: '', notice: '' });
  }
  async save(id: string, api: Pick<NativeSkillsAPI, 'saveSessionSkills'>): Promise<NativeSessionSkillsSaved | undefined> {
    const entry = this.entries.get(id);
    if (!entry || entry.loading || entry.saving || !entry.attempt && (!entry.view || entry.conflict || !entry.baseDigest || entry.view.schemaVersion === 2 && !entry.dirty)) return;
    // First migration always reflects the saved legacy paths, never an unsaved picker draft.
    const selected = entry.view?.schemaVersion === 1 ? legacySkillPaths(entry.view)! : [...entry.selected];
    const input = entry.attempt ?? { sessionId: id, mutationId: globalThis.crypto.randomUUID(), expectedConfigDigest: entry.baseDigest!,
      policy: { mode: 'legacy', autoActivation: false, pins: selected.map(path => ({ kind: 'legacy' as const, path })), disabledIds: [] } };
    const sourceConfig = encode(entry.config), sourceEpoch = this.epochs.get(id) ?? 0;
    this.publish(id, { ...entry, saving: true, error: '', notice: '', attempt: structuredClone(input) });
    try {
      const result = await api.saveSessionSkills(structuredClone(input));
      const latest = this.entries.get(id)!, paths = legacySkillPaths(result);
      if (!paths) throw new Error('Unsupported saved policy');
      const latestConfig = encode(latest.config), resultConfig = encode(result.config);
      const external = latestConfig !== resultConfig && (latestConfig !== sourceConfig || (this.epochs.get(id) ?? 0) !== sourceEpoch);
      if (external) this.publish(id, { ...latest, view: undefined, saving: false, conflict: true, attempt: undefined,
        notice: '', error: '技能保存已返回，但此会话的配置又发生变化。当前选择已保留，请先核对最新配置。' });
      else {
        const chosen = latest.selected;
        this.publish(id, { ...latest, config: structuredClone(result.config), view: structuredClone(result), selected: chosen, baseDigest: result.configDigest,
          dirty: !samePaths(chosen, paths), conflict: false, saving: false, attempt: undefined, error: '',
          notice: result.migrated ? '技能配置已升级，原配置已备份。已有项目技能保持原来的读取方式。' : '技能选择已保存。' });
      }
      return result;
    } catch (error) {
      const latest = this.entries.get(id)!;
      this.publish(id, { ...latest, saving: false, error: nativeSessionSkillsError(error, '保存技能配置失败或尚未确认。已有选择已保留，可重试核对本次保存。') });
    }
  }
}
