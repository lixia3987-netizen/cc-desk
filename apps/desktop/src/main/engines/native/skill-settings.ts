import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { normalizeProjectSkillPaths } from '@cc-desk/agent-node/project-skills';
import type { NativeSkillPin, NativeSkillPolicy, NativeSkillSourceSetting, NativeSkillsSettings } from '@cc-desk/contracts/native-skills';
import type { EngineConfig } from '../../../shared/execution';
import { parseNativeConfig } from './config';

export interface NativeSkillsSettingsView {
  settings: NativeSkillsSettings;
  /** 来源设置本身不授权 catalog 运行链路。 */
  runtimeEnabled: false;
  error?: string;
}
export interface NativeSkillsSettingsMutation {
  expectedRevision: number;
  sources: NativeSkillSourceSetting[];
}
export type NativeSkillSettingsErrorCode = 'settings_invalid' | 'settings_corrupt' | 'settings_future_version' | 'settings_conflict' | 'settings_write_failed' | 'migration_invalid';

export class NativeSkillSettingsError extends Error {
  constructor(readonly code: NativeSkillSettingsErrorCode, message: string) { super(message); this.name = 'NativeSkillSettingsError'; }
}

const sourceIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const enabledSourceLimitError = '用户 Skills 来源最多启用 13 项，需为当前项目的 3 个来源保留名额。请先停用其他来源。';
const controlCharacters = /[\x00-\x1f\x7f]/;
const sourceSchema = z.object({
  id: sourceIdSchema,
  kind: z.enum(['managed', 'user-agents', 'user-claude', 'custom']),
  enabled: z.boolean(),
  rootPath: z.string().min(1).max(4096).refine(value => !controlCharacters.test(value) && path.isAbsolute(value)),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();
const settingsSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sources: z.array(sourceSchema).min(3).max(16),
  retiredSourceIds: z.array(sourceIdSchema).max(1024).optional(),
}).strict().superRefine((settings, context) => {
  if (settings.sources.filter(source => source.enabled).length > 13) context.addIssue({ code: 'custom', message: enabledSourceLimitError });
  const active = new Set(settings.sources.map(source => source.id)), retired = new Set<string>();
  for (const id of settings.retiredSourceIds ?? []) {
    if (retired.has(id) || active.has(id)) context.addIssue({ code: 'custom', message: 'Retired Skills source identities must be unique and cannot be active.' });
    retired.add(id);
  }
});
const mutationSchema = z.object({
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sources: z.array(sourceSchema).min(3).max(16),
}).strict().refine(settings => settings.sources.filter(source => source.enabled).length <= 13, { message: enabledSourceLimitError });
const maximumFileBytes = 128 * 1024;
const builtInKinds = ['managed', 'user-agents', 'user-claude'] as const;
const storageError = 'Skills 来源配置损坏、版本不受支持或无法读取。原文件已保留，修复并刷新前不能保存。';
const conflictError = 'Skills 来源配置已变化，请刷新后检查修改再保存。';

/** 根路径只能来自宿主；本函数不读取、创建或扫描任何 Skills 目录。 */
export function createDefaultNativeSkillsSettings(dataDirectory: string, home = os.homedir()): NativeSkillsSettings {
  if (!path.isAbsolute(dataDirectory) || !path.isAbsolute(home) || controlCharacters.test(dataDirectory) || controlCharacters.test(home)) {
    throw new NativeSkillSettingsError('settings_invalid', 'Skills 数据目录和用户目录必须由宿主提供绝对路径。');
  }
  return { schemaVersion: 1, revision: 0, sources: [
    { id: 'managed', kind: 'managed', enabled: true, rootPath: path.join(dataDirectory, 'native', 'skills'), revision: 1 },
    { id: 'user-agents', kind: 'user-agents', enabled: false, rootPath: path.join(home, '.agents', 'skills'), revision: 1 },
    { id: 'user-claude', kind: 'user-claude', enabled: false, rootPath: path.join(home, '.claude', 'skills'), revision: 1 },
  ] };
}

/** 独立于 workspace.json；原子保存成功后才发布新快照。保存为同步操作，避免同进程多入口交错提交。 */
export class NativeSkillSettingsStore {
  readonly file: string;
  private readonly defaults: NativeSkillsSettings;
  private settings: NativeSkillsSettings;
  private loadError?: NativeSkillSettingsError;
  private observedPersistedConfiguration = false;

  constructor(dataDirectory: string, options: { home?: string } = {}) {
    this.defaults = createDefaultNativeSkillsSettings(dataDirectory, options.home);
    this.file = path.join(dataDirectory, 'native', 'skill-settings.json');
    this.settings = structuredClone(this.defaults);
    this.refresh();
  }

  list(): NativeSkillsSettingsView {
    return { settings: structuredClone(this.settings), runtimeEnabled: false, ...(this.loadError ? { error: this.loadError.message } : {}) };
  }

  /** 失败保留最后有效快照和错误；绝不把损坏文件视为“首次使用”。 */
  refresh(): NativeSkillsSettingsView {
    try { this.settings = this.readDisk(); this.loadError = undefined; }
    catch (error) { this.loadError = this.readError(error); }
    return this.list();
  }

  save(input: NativeSkillsSettingsMutation): NativeSkillsSettingsView {
    if (this.loadError) throw this.loadError;
    const parsed = mutationSchema.safeParse(input);
    if (!parsed.success) throw new NativeSkillSettingsError('settings_invalid', parsed.error.issues.some(issue => issue.message === enabledSourceLimitError)
      ? enabledSourceLimitError : 'Skills 来源配置无效，请检查来源、路径及修订版本。');
    let current: NativeSkillsSettings;
    try { current = this.readDisk(); }
    catch (error) { this.loadError = this.readError(error); throw this.loadError; }
    // 多个设置窗口或存储实例共用实际磁盘修订，不以旧内存快照覆盖其他保存。
    if (parsed.data.expectedRevision !== current.revision || this.settings.revision !== current.revision || !isDeepStrictEqual(this.settings, current)) {
      throw new NativeSkillSettingsError('settings_conflict', conflictError);
    }
    const sources = this.validateSources(parsed.data.sources);
    const retiredSourceIds = [...(current.retiredSourceIds ?? [])];
    const nextSources = sources.map(source => {
      const previous = current.sources.find(item => item.id === source.id);
      if (previous && (source.kind !== previous.kind || source.revision !== previous.revision)) throw new NativeSkillSettingsError('settings_conflict', conflictError);
      if (!previous && retiredSourceIds.includes(source.id)) throw new NativeSkillSettingsError('settings_invalid', '此 Skills 来源 ID 已被移除，不能重新使用。请为新注册的来源使用新的 ID。');
      if (!previous && source.revision !== 1) throw new NativeSkillSettingsError('settings_invalid', '新增 Skills 来源的修订版本必须为 1。');
      const changed = previous && (source.enabled !== previous.enabled || source.rootPath !== previous.rootPath);
      if (changed && previous.revision === Number.MAX_SAFE_INTEGER) throw new NativeSkillSettingsError('settings_invalid', 'Skills 来源修订版本已达上限。');
      return { ...source, revision: changed ? previous.revision + 1 : source.revision };
    });
    if (isDeepStrictEqual(nextSources, current.sources)) return this.list();
    for (const source of current.sources) {
      if (source.kind === 'custom' && !nextSources.some(next => next.id === source.id)) retiredSourceIds.push(source.id);
    }
    if (retiredSourceIds.length > 1024) throw new NativeSkillSettingsError('settings_invalid', '已移除的 Skills 来源 ID 已达 1024 项保留上限，不能继续移除来源；可停用来源，历史 ID 不会被自动丢弃。');
    if (current.revision === Number.MAX_SAFE_INTEGER) throw new NativeSkillSettingsError('settings_invalid', 'Skills 配置修订版本已达上限。');
    const next: NativeSkillsSettings = { schemaVersion: 1, revision: current.revision + 1, sources: nextSources,
      ...(retiredSourceIds.length || current.retiredSourceIds !== undefined ? { retiredSourceIds } : {}) };
    this.persist(next);
    this.observedPersistedConfiguration = true;
    this.settings = next;
    return this.list();
  }

  private validateSources(sources: NativeSkillSourceSetting[]): NativeSkillSourceSetting[] {
    const ids = new Set<string>(), roots = new Set<string>();
    const result = sources.map(source => {
      const normalized = { ...source, rootPath: path.resolve(source.rootPath) };
      const rootKey = process.platform === 'win32' ? normalized.rootPath.toLowerCase() : normalized.rootPath;
      if (ids.has(source.id) || roots.has(rootKey)) throw new NativeSkillSettingsError('settings_invalid', 'Skills 来源 ID 或根目录重复。');
      ids.add(source.id); roots.add(rootKey);
      const builtin = this.defaults.sources.find(item => item.id === source.id || item.kind === source.kind && source.kind !== 'custom');
      if (source.kind !== 'custom' || builtin) {
        if (!builtin || source.id !== builtin.id || source.kind !== builtin.kind || normalized.rootPath !== builtin.rootPath) {
          throw new NativeSkillSettingsError('settings_invalid', '内置 Skills 来源路径必须由宿主推导，不能通过配置改写。');
        }
      }
      return normalized;
    });
    if (builtInKinds.some(kind => !result.some(source => source.id === kind && source.kind === kind))) {
      throw new NativeSkillSettingsError('settings_invalid', '内置 Skills 来源必须保留；可关闭来源，不能移除或改写。');
    }
    return result;
  }

  private readDisk(): NativeSkillsSettings {
    let raw: string;
    try {
      const info = fs.lstatSync(this.file);
      // 曾存在的配置消失不能被当成首次使用；否则刷新会抹掉 revision 和退休 ID。
      this.observedPersistedConfiguration = true;
      if (!info.isFile() || info.isSymbolicLink() || info.size > maximumFileBytes) throw new Error();
      raw = fs.readFileSync(this.file, 'utf8');
      if (Buffer.byteLength(raw) > maximumFileBytes) throw new Error();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !this.observedPersistedConfiguration) return structuredClone(this.defaults);
      throw error;
    }
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && 'schemaVersion' in value && typeof value.schemaVersion === 'number' && value.schemaVersion > 1) {
      throw new NativeSkillSettingsError('settings_future_version', 'Skills 来源配置来自更新版本，请升级应用；原文件已保留。');
    }
    const parsed = settingsSchema.parse(value);
    return { ...parsed, sources: this.validateSources(parsed.sources) };
  }

  private readError(error: unknown): NativeSkillSettingsError {
    return error instanceof NativeSkillSettingsError && error.code === 'settings_future_version'
      ? error : new NativeSkillSettingsError('settings_corrupt', storageError);
  }

  private persist(next: NativeSkillsSettings): void {
    const directory = path.dirname(this.file), temporary = path.join(directory, `.skill-settings-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      const raw = JSON.stringify(settingsSchema.parse(next), null, 2);
      if (Buffer.byteLength(raw) > maximumFileBytes) throw new Error();
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, raw); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, this.file);
    } catch { throw new NativeSkillSettingsError('settings_write_failed', 'Skills 来源保存失败，原配置已保留，请检查磁盘空间与目录权限后重试。'); }
    finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 写入失败仍继续清理临时文件。 */ } }
      try { fs.unlinkSync(temporary); } catch { /* 成功重命名后临时文件已不存在。 */ }
    }
  }
}

export interface NativeSkillMigrationPreview {
  runtimeEnabled: false;
  original: EngineConfig;
  proposed: EngineConfig;
  legacyPins: Array<Extract<NativeSkillPin, { kind: 'legacy' }>>;
}

/** 纯预览：不读取项目文件、不检查缺失、不写回工作区；实际迁移必须另经 CAS 和备份保存。 */
export function previewNativeSkillMigration(config: EngineConfig): NativeSkillMigrationPreview {
  if (config.schemaVersion !== 1 || !config.options || typeof config.options !== 'object' || Array.isArray(config.options) || Object.hasOwn(config.options, 'skills')) {
    throw new NativeSkillSettingsError('migration_invalid', '仅可预览有效 Native v1 会话的 Skills 迁移。');
  }
  const supplied = config.options.projectSkills;
  let paths: string[];
  try {
    // 只验证生产 v1 的合法性；不使用带默认值/规范化后的结果改写原始配置。
    parseNativeConfig(config);
    paths = normalizeProjectSkillPaths(supplied === undefined ? [] : supplied as string[]);
  }
  catch { throw new NativeSkillSettingsError('migration_invalid', '旧项目 Skills 配置无法安全迁移，原始值已保留。'); }
  const original = structuredClone(config);
  const legacyPins: NativeSkillMigrationPreview['legacyPins'] = paths.map(source => ({ kind: 'legacy', path: source }));
  const skills: NativeSkillPolicy = { mode: 'legacy', autoActivation: false, pins: structuredClone(legacyPins), disabledIds: [] };
  const proposed: EngineConfig = { ...structuredClone(config), schemaVersion: 2, options: { ...structuredClone(config.options),
    skills: { ...skills } } };
  return { runtimeEnabled: false, original, proposed, legacyPins };
}
