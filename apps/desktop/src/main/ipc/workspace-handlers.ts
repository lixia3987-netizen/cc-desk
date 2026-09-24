import { z } from 'zod';
import type { Project, Session } from '../../shared/types';
import { idSchema } from '../../shared/schema';
import type { StateStore } from '../store';
import type { WorkspaceQueries } from '../workspace-queries';
import { gitChanges, gitDiff, worktreeInfo, mergeWorktree, cleanupWorktree } from '../git';
import { listProjectFiles, readProjectFile } from '../files';
import type { Register } from './registration';

interface WorkspacePorts {
  store: Pick<StateStore, 'state' | 'change'>;
  queries: WorkspaceQueries;
  session(id: string): Session;
  project(id: string): Project;
  worktreeDirectories(session: Session): Promise<string[]>;
  worktreeBase(session: Session): string;
  directoriesBusy(keys: string[]): boolean;
  idleTerminalBlock(keys: string[]): boolean;
  cleanupDependencies(session: Session): boolean;
  manageWorktree<T>(id: string, action: (session: Session) => Promise<T>): Promise<T>;
  onState(): void;
}

const relativePath = z.string().min(1).max(4096).refine(s => !/[\x00\r\n]/.test(s));

const historySchema = z.object({
  projectId: idSchema, query: z.string().max(500).optional(), offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export function registerWorkspaceHandlers(handle: Register, ports: WorkspacePorts): void {
  handle('history:query', historySchema, ({ projectId, ...options }) => ports.queries.history(ports.project(projectId).path, options));
  handle('git:changes', idSchema, id => {
    const session = ports.session(id);
    if (session.archived && !session.worktree && session.worktreeBase) {
      return { available: false, changes: [], truncated: false, error: '工作目录已清理，此记录仅保留历史。' };
    }
    return gitChanges(session.cwd);
  });
  handle('git:diff', z.object({ id: idSchema, path: relativePath, staged: z.boolean() }), ({ id, path, staged }) => {
    return gitDiff(ports.session(id).cwd, path, staged);
  });
  handle('files:list', z.object({ id: idSchema, query: z.string().max(500) }), ({ id, query }) => {
    return listProjectFiles(ports.session(id).cwd, query);
  });
  handle('files:read', z.object({ id: idSchema, path: relativePath }), ({ id, path }) => {
    return readProjectFile(ports.session(id).cwd, path);
  });
  handle('worktree:info', idSchema, async id => {
    const session = ports.session(id);
    // Read-only refreshes can outlive cleanup. Missing Git roots should produce
    // unavailable metadata, while all mutation paths keep their strict checks.
    const directories = await ports.worktreeDirectories(session).catch(() => undefined);
    const blocked = directories ? ports.directoriesBusy(directories) : true;
    const info = await worktreeInfo(ports.worktreeBase(session), session.worktree ?? session.cwd, id, blocked);
    if (directories && ports.idleTerminalBlock(directories)) {
      const reason = '原生 Claude 终端仍打开，请先关闭终端释放工作目录。';
      info.reasons.push(reason); info.cleanupReasons.push(reason);
    }
    if (ports.cleanupDependencies(session)) {
      info.canCleanup = false;
      const reason = '其他会话的工作目录或 worktree 来源依赖此目录，请先处理这些会话。';
      info.reasons.push(reason); info.cleanupReasons.push(reason);
    }
    return info;
  });
  handle('worktree:merge', idSchema, id => ports.manageWorktree(id, session => {
    return mergeWorktree(ports.worktreeBase(session), session.worktree!, id, false);
  }));
  handle('worktree:cleanup', idSchema, id => ports.manageWorktree(id, async session => {
    if (ports.cleanupDependencies(session)) throw new Error('其他会话的工作目录或 worktree 来源依赖此目录，请先处理这些会话。');
    const result = await cleanupWorktree(ports.worktreeBase(session), session.worktree!, id, false);
    if (result.ok) {
      ports.store.change(state => {
        const item = state.sessions.find(session => session.id === id)!;
        item.worktree = undefined;
        item.archived = true;
        item.error = '工作目录已清理，此记录仅保留历史。请在来源项目中创建新会话。';
      });
      ports.onState();
    }
    return result;
  }));
  handle('cli:diagnostics', idSchema.optional(), async id => {
    const cwd = id ? ports.session(id).cwd : undefined;
    return { ...await ports.queries.diagnose(cwd), cwd };
  });
}
