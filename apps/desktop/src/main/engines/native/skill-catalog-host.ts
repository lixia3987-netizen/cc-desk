import path from 'node:path';
import fs from 'node:fs/promises';
import { canonicalJson } from '@cc-desk/agent-core';
import { SkillRegistry, type LoadedCatalogSkill, type SkillRegistryOptions } from '@cc-desk/agent-node/skill-registry';
import { ProjectFiles, isWithin, isSensitivePath, normalizeProjectPath, type PathSnapshot } from '@cc-desk/agent-node/tools';
import type { SkillCatalogSnapshot, SkillDescriptor } from '@cc-desk/contracts/native-skills';
import type { StateStore } from '../../store';
import type { NativeSkillsCatalogResult } from '../../../shared/native-skills';
import { parseNativeConfig } from './config';
import { NativeSkillSettingsStore, type NativeSkillsSettingsMutation } from './skill-settings';

const changed = () => new Error('会话或 Skills 来源配置已变化，请重新读取目录。');
const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error('技能读取已取消。'); };
const encoded = (value: unknown): string => canonicalJson(JSON.parse(JSON.stringify(value)));

/** The host's rebind call authorizes one exact allocated child cwd, never its private ancestors. */
function privateChildProjectAccess(dataDirectory: string, projectRoot: string, excludedRoots: readonly string[], assertParentCurrent: () => void): SkillRegistryOptions['projectAccess'] {
  const data = path.resolve(dataDirectory), requested = path.resolve(projectRoot), worktrees = path.join(data, 'native', 'agent-worktrees');
  if (!isWithin(worktrees, requested) || requested === worktrees) return undefined;
  const relative = path.relative(worktrees, requested).split(path.sep).join('/');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/|$)/i.test(relative)) return undefined;
  try { normalizeProjectPath(relative); if (isSensitivePath(relative)) return undefined; } catch { return undefined; }
  let binding: Promise<{ files: ProjectFiles; snapshot: PathSnapshot }> | undefined;
  const assertCurrent = async () => {
    assertParentCurrent();
    const captured = await (binding ??= (async () => {
      // Main startup and createAgentWorktree use canonical roots. Refuse an alias or junction here
      // rather than letting the exception move to a different part of the private data directory.
      if (await fs.realpath(data) !== data || await fs.realpath(requested) !== requested) throw changed();
      const files = new ProjectFiles({ projectRoot: data });
      const snapshot = await files.snapshot(path.relative(data, requested).split(path.sep).join('/'), 'directory');
      return { files, snapshot };
    })());
    await captured.files.verify(captured.snapshot);
    if (await fs.realpath(data) !== data || await fs.realpath(requested) !== requested) throw changed();
    assertParentCurrent();
  };
  return { rootPath: requested,
    // Only the one application-data ancestor is replaced by this exact root capability.
    // All other exclusions remain, and user sources continue to use the full original list.
    excludedRoots: excludedRoots.filter(root => path.resolve(root) !== data), assertCurrent };
}

/** A registry remains bound to the host scope captured before its first I/O. */
class ScopedSkillRegistry extends SkillRegistry {
  constructor(private readonly hostOptions: SkillRegistryOptions, private readonly assertCurrent: () => void, private readonly dataDirectory: string) { super(hostOptions); }
  private async assertBoundCurrent(signal?: AbortSignal) {
    this.assertCurrent(); cancelled(signal);
    await this.hostOptions.projectAccess?.assertCurrent();
    this.assertCurrent(); cancelled(signal);
  }
  override async discover(signal?: AbortSignal): Promise<SkillCatalogSnapshot> {
    await this.assertBoundCurrent(signal);
    const catalog = await super.discover(signal);
    await this.assertBoundCurrent(signal);
    return catalog;
  }
  override async loadCatalogSkill(descriptor: SkillDescriptor, signal?: AbortSignal): Promise<LoadedCatalogSkill> {
    await this.assertBoundCurrent(signal);
    const loaded = await super.loadCatalogSkill(descriptor, signal);
    await this.assertBoundCurrent(signal);
    return loaded;
  }
  override rebindProject(projectRoot: string, excludedRoots: readonly string[] = this.hostOptions.excludedRoots ?? []): SkillRegistry {
    this.assertCurrent();
    const { projectAccess: _previousAccess, ...options } = this.hostOptions;
    const fullExclusions = [...new Set([...(this.hostOptions.excludedRoots ?? []), ...excludedRoots])];
    const projectAccess = privateChildProjectAccess(this.dataDirectory, projectRoot, fullExclusions, this.assertCurrent);
    return new ScopedSkillRegistry({ ...options, projectRoot, excludedRoots: fullExclusions,
      ...(projectAccess ? { projectAccess } : {}) }, this.assertCurrent, this.dataDirectory);
  }
}

/** Shared trusted source mapping. Constructing this host neither scans nor enables runtime activation. */
export class NativeSkillCatalogHost {
  readonly settings: NativeSkillSettingsStore;
  private readonly catalogs = new Map<string, { stamp: string; registry: SkillRegistry; catalog: NativeSkillsCatalogResult; bytes: number }>();
  private readonly discoveries = new Map<string, symbol>();

  constructor(private readonly store: StateStore, options: { settings?: NativeSkillSettingsStore } = {}) {
    this.settings = options.settings ?? new NativeSkillSettingsStore(store.directory);
    if (path.resolve(this.settings.file) !== path.resolve(store.directory, 'native', 'skill-settings.json')) {
      throw new Error('Skills 来源设置必须属于同一工作区数据目录。');
    }
  }

  assertStore(store: StateStore): void { if (store !== this.store) throw new Error('Skills 目录必须使用同一工作区宿主。'); }

  /** Identity is provided by the renderer; roots and project ownership come only from the host. */
  scope(sessionId: string) {
    const read = () => {
      const session = this.store.state.sessions.find(item => item.id === sessionId);
      const project = this.store.state.projects.find(item => item.id === session?.projectId);
      if (!session || !project || session.kind !== 'agent' || session.execution.providerId !== 'native' || session.execution.mode !== 'structured') {
        throw new Error('项目 Skills 仅适用于已创建的 Native 图形会话。');
      }
      // A cached registry must not retain an old session's draft or unrelated display/history data.
      return { session: { projectId: session.projectId, cwd: session.cwd, engineConfig: session.engineConfig }, key: encoded({ sessionId, projectId: session.projectId, projectPath: project.path,
        cwd: session.cwd, conversationId: session.execution.conversationId ?? null, engineConfig: session.engineConfig }) };
    };
    const initial = read();
    return { session: initial.session, key: initial.key,
      options: { projectRoot: initial.session.cwd, excludedRoots: [this.store.directory] },
      assertCurrent: () => { let current; try { current = read(); } catch { throw changed(); } if (current.key !== initial.key) throw changed(); } };
  }

  /** Full source contents participate in the stamp, including external edits at an unchanged revision. */
  capture(sessionId: string) {
    const scope = this.scope(sessionId), view = this.settings.refresh();
    if (view.error) throw new Error(view.error);
    const settingsStamp = encoded(view.settings), key = encoded([scope.key, settingsStamp]);
    return { scope, settings: view.settings, key, assertCurrent: () => {
      scope.assertCurrent();
      const current = this.settings.refresh();
      if (current.error || encoded(current.settings) !== settingsStamp) throw changed();
    } };
  }

  saveSettings(input: NativeSkillsSettingsMutation) {
    const result = this.settings.save(input);
    this.catalogs.clear();
    return result;
  }

  private boundRegistry(capture: ReturnType<NativeSkillCatalogHost['capture']>): SkillRegistry {
    const selected = parseNativeConfig(capture.scope.session.engineConfig).projectSkills;
    return new ScopedSkillRegistry({ projectId: capture.scope.session.projectId, projectRoot: capture.scope.options.projectRoot,
      excludedRoots: capture.scope.options.excludedRoots, managedRoot: path.join(this.store.directory, 'native', 'skills'), sources: [
        { id: 'project-agents', scope: 'project', kind: 'project-agents', rootPath: '.agents/skills', enabled: true, revision: 1 },
        { id: 'project-claude', scope: 'project', kind: 'project-claude', rootPath: '.claude/skills', enabled: true, revision: 1 },
        ...(selected.length ? [{ id: 'project-explicit', scope: 'project' as const, kind: 'project-explicit' as const, rootPath: '.', enabled: true, revision: 1,
          explicitPaths: selected.filter(file => !/^\.(?:agents|claude)\/skills\/[^/]+\/SKILL\.md$/.test(file)) }] : []),
        ...capture.settings.sources.map(source => ({ ...source, id: `user-${source.id}`, scope: 'user' as const })),
      ] }, capture.assertCurrent, this.store.directory);
  }

  /** Fresh registry for a runtime operation; no global runtime registry cache can outlive its scope. */
  registry(sessionId: string): SkillRegistry { return this.boundRegistry(this.capture(sessionId)); }

  async catalog(sessionId: string, refresh = false): Promise<NativeSkillsCatalogResult> {
    const initial = this.capture(sessionId), cached = this.catalogs.get(sessionId);
    if (!refresh && cached?.stamp === initial.key) {
      this.catalogs.delete(sessionId); this.catalogs.set(sessionId, cached);
      return structuredClone(cached.catalog);
    }
    const request = Symbol('skill-discovery'); this.discoveries.set(sessionId, request);
    try {
      const registry = this.boundRegistry(initial);
      const catalog: NativeSkillsCatalogResult = { ...await registry.discover(), runtimeEnabled: false };
      initial.assertCurrent();
      if (this.discoveries.get(sessionId) !== request) throw changed();
      // Bound metadata retained by the host and registry across all sessions.
      const bytes = Buffer.byteLength(JSON.stringify(catalog)) * 2 + Buffer.byteLength(initial.key);
      if (bytes > 8 * 1024 * 1024) throw new Error('Skills 目录超过内存上限，请减少启用来源后重试。');
      this.catalogs.delete(sessionId); this.catalogs.set(sessionId, { stamp: initial.key, registry, catalog, bytes });
      while (this.catalogs.size > 8 || [...this.catalogs.values()].reduce((total, item) => total + item.bytes, 0) > 8 * 1024 * 1024) this.catalogs.delete(this.catalogs.keys().next().value!);
      return structuredClone(catalog);
    } finally { if (this.discoveries.get(sessionId) === request) this.discoveries.delete(sessionId); }
  }

  async inspect(sessionId: string, skillId: string, catalogRevision: string): Promise<LoadedCatalogSkill> {
    const initial = this.capture(sessionId), cached = this.catalogs.get(sessionId);
    if (!cached || cached.stamp !== initial.key || cached.catalog.revision !== catalogRevision) throw new Error('Skills 目录已变化，请刷新目录后重新预览。');
    const descriptor = cached.catalog.entries.find(entry => entry.skillId === skillId);
    if (!descriptor) throw new Error('该 Skill 不在当前目录中。');
    let result;
    try { result = await cached.registry.loadCatalogSkill(descriptor); }
    catch { initial.assertCurrent(); throw new Error('Skill 来源、内容或访问权限已变化，请刷新目录后重试。'); }
    initial.assertCurrent();
    if (this.catalogs.get(sessionId) !== cached) throw changed();
    return result;
  }
}
