import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@cc-desk/agent-core';
import { loadProjectSkills } from '@cc-desk/agent-node/project-skills';
import { z } from 'zod';
import type { StateStore } from '../../store';
import type { AppState, Session } from '../../../shared/types';
import type { EngineConfig } from '../../../shared/execution';
import { engineConfigSchema } from '../../../shared/schema';
import type { NativeSessionSkillsSave, NativeSessionSkillsSaved, NativeSessionSkillsView } from '../../../shared/native-skills';
import { nativeConfigDigest, normalizeNativeLegacySkillPolicy, parseNativeConfig, type NativeLegacySkillPolicy } from './config';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const policySchema = z.object({ mode: z.literal('legacy'), autoActivation: z.literal(false),
  pins: z.array(z.object({ kind: z.literal('legacy'), path: z.string().max(4096) }).strict()).max(16),
  disabledIds: z.tuple([]),
}).strict();
const receiptSchema = z.object({ schemaVersion: z.literal(1), mutationId: z.string().uuid(), scopeDigest: digestSchema,
  sourceConfigDigest: digestSchema, targetConfigDigest: digestSchema, policyDigest: digestSchema,
  sourceSessionUpdatedAtDigest: digestSchema,
  targetSessionUpdatedAt: z.string().max(32).refine(value => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  }),
  migrated: z.boolean(), backupCreated: z.boolean(),
}).strict();
type Receipt = z.infer<typeof receiptSchema>;

export interface NativeSessionSkillSettingsHost {
  store: StateStore;
  manage<T>(id: string, action: () => T | Promise<T>): Promise<T>;
  assertUnlocked(session: Session): void;
  taskOccupied(id: string): boolean;
  hasPending(id: string): boolean;
  captureAdmission(id: string): () => void;
  onState(): void;
}

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function nextUpdatedAt(source: string): string {
  const parsed = Date.parse(source), next = parsed + 1, now = Date.now();
  const timestamp = Number.isFinite(next) && Math.abs(next) <= 8_640_000_000_000_000 ? Math.max(now, next) : now;
  const target = new Date(timestamp).toISOString();
  return target === source ? new Date(now + 1).toISOString() : target;
}
class SettingsConflict extends Error {}
const conflict = () => new SettingsConflict('会话配置已变化，请重新读取 Skills 后保存。');
const scopeChanged = () => new SettingsConflict('会话或项目目录已变化，请重新读取 Skills。');

/** 独立保存只改变 legacy mirror；目录发现与 catalog 激活不参与此事务。 */
export class NativeSessionSkillSettings {
  constructor(private readonly host: NativeSessionSkillSettingsHost) {}

  private scope(sessionId: string) {
    const find = (state: AppState) => {
      const session = state.sessions.find(item => item.id === sessionId);
      const project = state.projects.find(item => item.id === session?.projectId);
      if (!session || !project || session.kind !== 'agent' || session.execution.providerId !== 'native' || session.execution.mode !== 'structured') {
        throw new Error('Skills 配置仅适用于已创建的 Native 图形会话。');
      }
      return { session, key: canonicalJson({ sessionId, projectId: session.projectId, projectPath: project.path,
        cwd: session.cwd, conversationId: session.execution.conversationId ?? null }) };
    };
    const initial = find(this.host.store.state);
    return { session: initial.session, digest: hash(initial.key), assertCurrent: (state = this.host.store.state) => {
      let current;
      try { current = find(state); } catch { throw scopeChanged(); }
      if (current.key !== initial.key) throw scopeChanged();
      return current.session;
    } };
  }

  private policy(config: EngineConfig): NativeLegacySkillPolicy {
    try {
      const options = parseNativeConfig(config);
      return options.skills ?? normalizeNativeLegacySkillPolicy(options.projectSkills);
    } catch { throw new Error('当前 Native 配置无法读取，请先检查会话配置；原配置已保留。'); }
  }

  private requestedPolicy(input: unknown): NativeLegacySkillPolicy {
    try {
      const parsed = policySchema.parse(input);
      return normalizeNativeLegacySkillPolicy(parsed.pins.map(pin => pin.path));
    } catch { throw new Error('请选择最多 16 个不重复的项目内 SKILL.md；目前仅支持兼容模式。'); }
  }

  private async view(scope: ReturnType<NativeSessionSkillSettings['scope']>, config: EngineConfig): Promise<NativeSessionSkillsView> {
    const configDigest = nativeConfigDigest(config), policy = this.policy(config);
    const pinDiagnostics: NativeSessionSkillsView['pinDiagnostics'] = [];
    // 每项最多 32 KiB，总读取量最多 128 KiB；缺失或拒绝项保持在原 policy 中。
    let remaining = 128 * 1024;
    for (const pin of policy.pins) {
      const readLimit = Math.min(32 * 1024, remaining);
      if (readLimit === 0) {
        pinDiagnostics.push({ path: pin.path, status: 'unverified', message: '诊断读取预算已达上限，尚未检查此项；已保留固定路径。' });
        continue;
      }
      try {
        const loaded = await loadProjectSkills({ projectRoot: scope.session.cwd, excludedRoots: [this.host.store.directory],
          paths: [pin.path], maxFileBytes: readLimit, maxTotalBytes: readLimit });
        remaining -= loaded.bytes;
        pinDiagnostics.push({ path: pin.path, status: 'available' });
      } catch {
        remaining -= readLimit;
        pinDiagnostics.push({ path: pin.path, status: 'unavailable', message: '文件不可用或超过读取限制，请检查路径、权限和大小。' });
      }
      if (nativeConfigDigest(scope.assertCurrent().engineConfig) !== configDigest) throw conflict();
    }
    if (nativeConfigDigest(scope.assertCurrent().engineConfig) !== configDigest) throw conflict();
    return { schemaVersion: config.schemaVersion as 1 | 2, configDigest, policy, pinDiagnostics, runtimeEnabled: false };
  }

  async get(sessionId: string): Promise<NativeSessionSkillsView> {
    const scope = this.scope(sessionId);
    return this.view(scope, structuredClone(scope.session.engineConfig));
  }

  /** 不覆盖已有元数据。完整同内容文件可再次同步，部分/异内容文件拒绝复用。 */
  private durableFile(file: string, bytes: Buffer): void {
    let fd: number | undefined, created = false, complete = false;
    try {
      try { fd = fs.openSync(file, 'wx', 0o600); created = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes.length || !fs.readFileSync(file).equals(bytes)) throw new Error('IMMUTABLE_FILE_CONFLICT');
        // FlushFileBuffers 在 Windows 需要可写句柄；同内容复用仍不改动任何字节。
        fd = fs.openSync(file, 'r+');
      }
      if (created) fs.writeFileSync(fd, bytes);
      complete = true;
      fs.fsyncSync(fd);
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); }
        finally { if (created && !complete) { try { fs.unlinkSync(file); } catch { /* 原 workspace 未改动。 */ } } }
      }
    }
  }

  private readReceipt(file: string): Receipt | undefined {
    try {
      const directory = fs.lstatSync(path.dirname(file));
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('INVALID_METADATA_DIRECTORY');
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) throw new Error('INVALID_RECEIPT');
      return receiptSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('Skills 保存凭据无法读取，请检查数据目录；原配置已保留。');
    }
  }

  private syncDirectory(directory: string): void {
    // Windows 不支持用普通目录句柄 fsync；文件本身在所有平台均已 fsync。
    if (process.platform === 'win32') return;
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  async save(input: NativeSessionSkillsSave): Promise<NativeSessionSkillsSaved> {
    if (!z.string().uuid().safeParse(input.mutationId).success) throw new Error('保存请求标识无效，请重新读取 Skills 后保存。');
    if (!digestSchema.safeParse(input.expectedConfigDigest).success) throw conflict();
    const policy = this.requestedPolicy(input.policy), policyDigest = hash(canonicalJson(policy));
    const scope = this.scope(input.sessionId);
    this.host.assertUnlocked(scope.session);
    const checkAdmission = this.host.captureAdmission(input.sessionId);
    const guard = () => {
      checkAdmission();
      const session = scope.assertCurrent();
      if (session.archived) throw new Error('请先取消会话归档，再保存 Skills。');
      if (this.host.taskOccupied(input.sessionId) || this.host.hasPending(input.sessionId)) {
        throw new Error('请先停止任务、处理恢复状态并清空待发送队列，再保存 Skills。');
      }
      return session;
    };
    const finish = async (config: EngineConfig, migrated: boolean, backupCreated: boolean): Promise<NativeSessionSkillsSaved> => {
      const view = await this.view(scope, config);
      guard();
      return { ...view, config, migrated, backupCreated };
    };
    guard();
    return this.host.manage(input.sessionId, async () => {
      const sourceSession = guard(), sourceSessionUpdatedAt = sourceSession.updatedAt;
      const sourceSessionUpdatedAtDigest = hash(sourceSessionUpdatedAt);
      const original = structuredClone(sourceSession.engineConfig);
      const currentDigest = nativeConfigDigest(original);
      const directory = path.join(this.host.store.directory, 'native-session-skills');
      // 使用稳定会话身份定位；凭据内部绑定完整 scope，目录漂移后也不能重用旧标识。
      const receiptFile = path.join(directory, `${hash(canonicalJson([input.sessionId, input.mutationId]))}.receipt.json`);
      const existing = this.readReceipt(receiptFile);
      if (existing && (existing.mutationId !== input.mutationId || existing.scopeDigest !== scope.digest || existing.sourceConfigDigest !== input.expectedConfigDigest || existing.policyDigest !== policyDigest)) {
        throw new SettingsConflict('保存请求标识已被使用或会话已变化，请重新读取 Skills 后保存。');
      }
      if (existing?.scopeDigest === scope.digest && existing.sourceConfigDigest === input.expectedConfigDigest && existing.policyDigest === policyDigest && existing.targetConfigDigest === currentDigest) {
        return finish(original, existing.migrated, existing.backupCreated);
      }
      if (currentDigest !== input.expectedConfigDigest) {
        throw conflict();
      }
      // prepared 凭据允许未发布的原请求重试；已经发布后发生的 A→B→A 不能重放。
      if (existing && (existing.scopeDigest !== scope.digest || existing.sourceConfigDigest !== currentDigest || existing.policyDigest !== policyDigest || existing.sourceSessionUpdatedAtDigest !== sourceSessionUpdatedAtDigest)) throw conflict();
      const oldPolicy = this.policy(original), migrated = original.schemaVersion === 1;
      if (migrated && canonicalJson(policy) !== canonicalJson(oldPolicy)) {
        throw new Error('首次迁移必须保留全部旧版 Skills 路径；请先迁移，再单独编辑。');
      }
      const config: EngineConfig = { schemaVersion: 2, options: { ...structuredClone(original.options),
        projectSkills: policy.pins.map(pin => pin.path), skills: policy } };
      this.policy(config);
      if (!engineConfigSchema.safeParse(config).success) {
        throw new Error('升级后的技能配置超过安全大小限制，请先减少过长的固定路径后重试；原配置已保留。');
      }
      const targetConfigDigest = nativeConfigDigest(config);
      const unchanged = targetConfigDigest === currentDigest;
      if (existing && existing.targetConfigDigest !== targetConfigDigest) throw conflict();
      const targetSessionUpdatedAt = existing?.targetSessionUpdatedAt ?? nextUpdatedAt(sourceSessionUpdatedAt);
      const assertOriginal = () => {
        const current = guard();
        if (nativeConfigDigest(current.engineConfig) !== currentDigest || current.updatedAt !== sourceSessionUpdatedAt) throw conflict();
      };
      let receipt: Receipt;
      // 待提交草稿/观测先落盘，备份取得完整且当前的 workspace 原始字节。
      try { this.host.store.flush(); }
      catch { throw new Error('无法刷新工作区，请检查磁盘空间和权限后重试；原 Skills 配置已保留。'); }
      assertOriginal();
      try {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const directoryStat = fs.lstatSync(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('INVALID_METADATA_DIRECTORY');
        if (migrated) {
          const workspace = fs.readFileSync(this.host.store.file);
          const backupDigest = hash(workspace);
          this.durableFile(path.join(directory, `workspace.pre-native-skills-v2.${backupDigest}.json`), workspace);
        }
        receipt = { schemaVersion: 1, mutationId: input.mutationId, scopeDigest: scope.digest, sourceConfigDigest: currentDigest,
          targetConfigDigest, policyDigest, sourceSessionUpdatedAtDigest, targetSessionUpdatedAt, migrated, backupCreated: migrated };
        this.durableFile(receiptFile, Buffer.from(JSON.stringify(receipt)));
        this.syncDirectory(directory);
        this.syncDirectory(this.host.store.directory);
      } catch {
        throw new Error('无法同步 Skills 备份或保存凭据，请检查磁盘空间和权限后重试；原配置已保留。');
      }
      assertOriginal();
      if (unchanged) return finish(original, false, false);
      try {
        this.host.store.change(state => {
          const current = scope.assertCurrent(state);
          if (nativeConfigDigest(current.engineConfig) !== currentDigest || current.updatedAt !== sourceSessionUpdatedAt) throw conflict();
          current.engineConfig = config;
          current.updatedAt = targetSessionUpdatedAt;
        });
      } catch (error) {
        if (error instanceof SettingsConflict) throw error;
        throw new Error('Skills 配置未能保存，请检查磁盘空间和权限后用原请求重试。');
      }
      guard();
      try { this.host.onState(); }
      catch { throw new Error('Skills 配置已保存，状态刷新失败；请用原请求重试确认。'); }
      return finish(config, migrated, receipt.backupCreated);
    });
  }
}
