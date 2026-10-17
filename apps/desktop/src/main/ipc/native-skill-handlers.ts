import { z } from 'zod';
import { discoverProjectSkills, loadProjectSkills } from '@cc-desk/agent-node/project-skills';
import { loadProjectInstructions } from '@cc-desk/agent-node/project-instructions';
import { NativeSkillCatalogHost } from '../engines/native/skill-catalog-host';
import { NativeSkillSettingsStore, previewNativeSkillMigration } from '../engines/native/skill-settings';
import type { Register } from './registration';
import type { StateStore } from '../store';
import type { NativeInstructionsPreview, NativeSkillPreview, NativeSkillsListResult, NativeSkillsCatalogResult } from '../../shared/native-skills';

/** 可信渲染进程提供身份，不提供文件系统根路径。 */
export function registerNativeSkillHandlers(handle: Register, store: StateStore, options: { settings?: NativeSkillSettingsStore; catalog?: NativeSkillCatalogHost } = {}): void {
  const catalog = options.catalog ?? new NativeSkillCatalogHost(store, { settings: options.settings });
  if (options.settings && catalog.settings !== options.settings) throw new Error('Skills 目录和来源设置必须使用同一宿主实例。');
  catalog.assertStore(store);
  const settings = catalog.settings;
  const sessionIdSchema = z.string().min(1).max(100);
  const pathSchema = z.string().min(1).max(4096);
  const scope = (sessionId: string) => catalog.scope(sessionId);
  const sourceSchema = z.object({ id: z.string().min(1).max(100), kind: z.enum(['managed', 'user-agents', 'user-claude', 'custom']),
    enabled: z.boolean(), rootPath: pathSchema, revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict();
  handle('native:skills-settings', z.undefined(), () => settings.refresh());
  handle('native:skills-settings-save', z.object({ expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), sources: z.array(sourceSchema).min(3).max(16) }).strict(), input => {
    return catalog.saveSettings(input);
  });
  handle('native:skills-migration-preview', z.object({ sessionId: sessionIdSchema }).strict(), ({ sessionId }) => {
    const current = scope(sessionId);
    return previewNativeSkillMigration(current.session.engineConfig);
  });
  handle('native:skills-catalog', z.object({ sessionId: sessionIdSchema, refresh: z.boolean().optional() }).strict(),
    ({ sessionId, refresh }): Promise<NativeSkillsCatalogResult> => catalog.catalog(sessionId, refresh));
  handle('native:skills-catalog-inspect', z.object({ sessionId: sessionIdSchema, skillId: z.string().min(1).max(256), catalogRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    ({ sessionId, skillId, catalogRevision }) => catalog.inspect(sessionId, skillId, catalogRevision));
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
