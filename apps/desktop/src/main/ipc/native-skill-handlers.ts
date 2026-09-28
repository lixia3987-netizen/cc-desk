import { z } from 'zod';
import { discoverProjectSkills } from '@cc-desk/agent-node/project-skills';
import type { Register } from './registration';
import type { StateStore } from '../store';
import type { NativeSkillsListResult } from '../../shared/native-skills';

/** The trusted renderer supplies an identity, never a filesystem root. */
export function registerNativeSkillHandlers(handle: Register, store: StateStore): void {
  handle('native:skills-list', z.object({ sessionId: z.string().min(1).max(100) }).strict(), async ({ sessionId }): Promise<NativeSkillsListResult> => {
    const session = store.state.sessions.find(item => item.id === sessionId);
    if (!session || session.kind !== 'agent' || session.execution.providerId !== 'native' || session.execution.mode !== 'structured') {
      throw new Error('项目 Skills 仅适用于已创建的 Native 图形会话。');
    }
    const cwd = session.cwd, conversationId = session.execution.conversationId;
    let result: NativeSkillsListResult;
    try { result = await discoverProjectSkills({ projectRoot: cwd, excludedRoots: [store.directory] }); }
    catch { throw new Error('无法读取项目 Skills，请检查会话目录和访问权限。'); }
    const current = store.state.sessions.find(item => item.id === sessionId);
    if (!current || current.cwd !== cwd || current.execution.providerId !== 'native' || current.execution.mode !== 'structured' || current.execution.conversationId !== conversationId) {
      throw new Error('会话或项目目录已变化，请重新读取 Skills。');
    }
    return result;
  });
}
