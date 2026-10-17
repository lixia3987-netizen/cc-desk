import { z } from 'zod';
import { discoverProjectSkills, loadProjectSkills } from '@cc-desk/agent-node/project-skills';
import { loadProjectInstructions } from '@cc-desk/agent-node/project-instructions';
import path from 'node:path';
import { SkillRegistry } from '@cc-desk/agent-node/skill-registry';
import { parseNativeConfig } from '../engines/native/config';
import { NativeSkillSettingsStore, previewNativeSkillMigration } from '../engines/native/skill-settings';
import type { Register } from './registration';
import type { StateStore } from '../store';
import type { NativeInstructionsPreview, NativeSkillPreview, NativeSkillsListResult, NativeSkillsCatalogResult } from '../../shared/native-skills';

/** 可信渲染进程提供身份，不提供文件系统根路径。 */
export function registerNativeSkillHandlers(handle: Register, store: StateStore, options: { settings?: NativeSkillSettingsStore } = {}): void {
  const settings = options.settings ?? new NativeSkillSettingsStore(store.directory);
  const catalogs = new Map<string, { stamp: string; registry: SkillRegistry; catalog: NativeSkillsCatalogResult; bytes: number }>();
  const discoveries = new Map<string, symbol>();
  const sessionIdSchema = z.string().min(1).max(100);
  const pathSchema = z.string().min(1).max(4096);
  const scope = (sessionId: string) => {
    const session = store.state.sessions.find(item => item.id === sessionId);
    if (!session || session.kind !== 'agent' || session.execution.providerId !== 'native' || session.execution.mode !== 'structured') {
      throw new Error('项目 Skills 仅适用于已创建的 Native 图形会话。');
    }
    const cwd = session.cwd, conversationId = session.execution.conversationId;
    return { session, options: { projectRoot: cwd, excludedRoots: [store.directory] }, assertCurrent: () => {
      const current = store.state.sessions.find(item => item.id === sessionId);
      if (!current || current.kind !== 'agent' || current.cwd !== cwd || current.execution.providerId !== 'native' || current.execution.mode !== 'structured' || current.execution.conversationId !== conversationId) {
        throw new Error('会话或项目目录已变化，请重新读取来源。');
      }
    } };
  };
  const sourceSchema = z.object({ id: z.string().min(1).max(100), kind: z.enum(['managed', 'user-agents', 'user-claude', 'custom']),
    enabled: z.boolean(), rootPath: pathSchema, revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict();
  handle('native:skills-settings', z.undefined(), () => settings.refresh());
  handle('native:skills-settings-save', z.object({ expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), sources: z.array(sourceSchema).min(3).max(16) }).strict(), input => {
    const result = settings.save(input); catalogs.clear(); return result;
  });
  handle('native:skills-migration-preview', z.object({ sessionId: sessionIdSchema }).strict(), ({ sessionId }) => {
    const current = scope(sessionId);
    return previewNativeSkillMigration(current.session.engineConfig);
  });
  const stamp = (sessionId: string) => {
    const current = scope(sessionId), view = settings.refresh();
    if (view.error) throw new Error(view.error);
    return { current, view, key: JSON.stringify([current.session.projectId, current.session.cwd, current.session.execution.conversationId,
      current.session.engineConfig, view.settings]) };
  };
  handle('native:skills-catalog', z.object({ sessionId: sessionIdSchema, refresh: z.boolean().optional() }).strict(), async ({ sessionId, refresh }): Promise<NativeSkillsCatalogResult> => {
    const initial = stamp(sessionId), cached = catalogs.get(sessionId);
    if (!refresh && cached?.stamp === initial.key) {
      catalogs.delete(sessionId); catalogs.set(sessionId, cached);
      return structuredClone(cached.catalog);
    }
    const request = Symbol('skill-discovery'); discoveries.set(sessionId, request);
    try {
      const selected = parseNativeConfig(initial.current.session.engineConfig).projectSkills;
      const registry = new SkillRegistry({ projectId: initial.current.session.projectId, projectRoot: initial.current.options.projectRoot,
        excludedRoots: initial.current.options.excludedRoots, managedRoot: path.join(store.directory, 'native', 'skills'), sources: [
          { id: 'project-agents', scope: 'project', kind: 'project-agents', rootPath: '.agents/skills', enabled: true, revision: 1 },
          { id: 'project-claude', scope: 'project', kind: 'project-claude', rootPath: '.claude/skills', enabled: true, revision: 1 },
          ...(selected.length ? [{ id: 'project-explicit', scope: 'project' as const, kind: 'project-explicit' as const, rootPath: '.', enabled: true, revision: 1,
            explicitPaths: selected.filter(file => !/^\.(?:agents|claude)\/skills\/[^/]+\/SKILL\.md$/.test(file)) }] : []),
          ...initial.view.settings.sources.map(source => ({ ...source, id: `user-${source.id}`, scope: 'user' as const })),
        ] });
      const catalog: NativeSkillsCatalogResult = { ...await registry.discover(), runtimeEnabled: false };
      initial.current.assertCurrent();
      if (stamp(sessionId).key !== initial.key || discoveries.get(sessionId) !== request) throw new Error('会话或 Skills 来源配置已变化，请重新读取目录。');
      // Bound both metadata copies (catalog + registry) across all retained sessions.
      const bytes = Buffer.byteLength(JSON.stringify(catalog)) * 2 + Buffer.byteLength(initial.key);
      if (bytes > 8 * 1024 * 1024) throw new Error('Skills 目录超过内存上限，请减少启用来源后重试。');
      catalogs.delete(sessionId); catalogs.set(sessionId, { stamp: initial.key, registry, catalog, bytes });
      while (catalogs.size > 8 || [...catalogs.values()].reduce((total, item) => total + item.bytes, 0) > 8 * 1024 * 1024) catalogs.delete(catalogs.keys().next().value!);
      return structuredClone(catalog);
    } finally { if (discoveries.get(sessionId) === request) discoveries.delete(sessionId); }
  });
  handle('native:skills-catalog-inspect', z.object({ sessionId: sessionIdSchema, skillId: z.string().min(1).max(256), catalogRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict(), async ({ sessionId, skillId, catalogRevision }) => {
    const initial = stamp(sessionId), cached = catalogs.get(sessionId);
    if (!cached || cached.stamp !== initial.key || cached.catalog.revision !== catalogRevision) throw new Error('Skills 目录已变化，请刷新目录后重新预览。');
    const descriptor = cached.catalog.entries.find(entry => entry.skillId === skillId);
    if (!descriptor) throw new Error('该 Skill 不在当前目录中。');
    let result;
    try { result = await cached.registry.loadCatalogSkill(descriptor); }
    catch { throw new Error('Skill 来源、内容或访问权限已变化，请刷新目录后重试。'); }
    initial.current.assertCurrent();
    if (stamp(sessionId).key !== initial.key || catalogs.get(sessionId) !== cached) throw new Error('会话或 Skills 目录已变化，请重新预览。');
    return result;
  });
  handle('native:skills-list', z.object({ sessionId: sessionIdSchema }).strict(), async ({ sessionId }): Promise<NativeSkillsListResult> => {
    const current = scope(sessionId);
    let result: NativeSkillsListResult;
    try { result = await discoverProjectSkills(current.options); }
    catch { throw new Error('无法读取项目 Skills，请检查会话目录和访问权限。'); }
    current.assertCurrent();
    return result;
  });
  handle('native:skills-inspect', z.object({ sessionId: sessionIdSchema, path: pathSchema }).strict(), async ({ sessionId, path }): Promise<NativeSkillPreview> => {
    const current = scope(sessionId);
    let result: NativeSkillPreview;
    try { result = (await loadProjectSkills({ ...current.options, paths: [path] })).sources[0]; }
    catch { throw new Error('无法预览此 Skill。请使用项目内普通目录中的 SKILL.md，并检查文件权限、编码和大小。'); }
    current.assertCurrent();
    return result;
  });
  handle('native:instructions-inspect', z.object({ sessionId: sessionIdSchema, targetPath: pathSchema }).strict(), async ({ sessionId, targetPath }): Promise<NativeInstructionsPreview> => {
    const current = scope(sessionId);
    let result: NativeInstructionsPreview;
    try {
      const instructions = await loadProjectInstructions({ ...current.options, targetPath, targetKind: 'directory' });
      result = { targetPath, digest: instructions.digest, sources: instructions.sources.map(source => ({ ...source, bytes: Buffer.byteLength(source.content) })) };
    } catch { throw new Error('无法检查项目指令。请使用项目内普通目录，并检查指令文件权限、编码和大小。'); }
    current.assertCurrent();
    return result;
  });
}
