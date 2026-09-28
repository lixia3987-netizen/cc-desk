import { z } from 'zod';
import { discoverProjectSkills, loadProjectSkills } from '@cc-desk/agent-node/project-skills';
import { loadProjectInstructions } from '@cc-desk/agent-node/project-instructions';
import type { Register } from './registration';
import type { StateStore } from '../store';
import type { NativeInstructionsPreview, NativeSkillPreview, NativeSkillsListResult } from '../../shared/native-skills';

/** The trusted renderer supplies an identity, never a filesystem root. */
export function registerNativeSkillHandlers(handle: Register, store: StateStore): void {
  const sessionIdSchema = z.string().min(1).max(100);
  const pathSchema = z.string().min(1).max(4096);
  const scope = (sessionId: string) => {
    const session = store.state.sessions.find(item => item.id === sessionId);
    if (!session || session.kind !== 'agent' || session.execution.providerId !== 'native' || session.execution.mode !== 'structured') {
      throw new Error('项目 Skills 仅适用于已创建的 Native 图形会话。');
    }
    const cwd = session.cwd, conversationId = session.execution.conversationId;
    return { options: { projectRoot: cwd, excludedRoots: [store.directory] }, assertCurrent: () => {
      const current = store.state.sessions.find(item => item.id === sessionId);
      if (!current || current.kind !== 'agent' || current.cwd !== cwd || current.execution.providerId !== 'native' || current.execution.mode !== 'structured' || current.execution.conversationId !== conversationId) {
        throw new Error('会话或项目目录已变化，请重新读取来源。');
      }
    } };
  };
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
