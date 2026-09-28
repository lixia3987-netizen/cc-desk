import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';

export interface DirectoryOwner { sessionId: string; providerId: string; generation: number }
export interface DirectoryLease { readonly token: string; readonly owner: DirectoryOwner; readonly roots: readonly string[] }

/** Canonicalize existing ancestors too, for management of a removed worktree. */
export function canonicalDirectory(value: string): string {
  let current = path.resolve(value);
  const missing: string[] = [];
  for (;;) {
    try {
      const resolved = path.join(realpathSync.native(current), ...missing);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current)); current = parent;
    }
  }
}

export function directoriesOverlap(a: string, b: string): boolean {
  const contains = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  };
  return contains(a, b) || contains(b, a);
}

/** App-owned roots only: this is mutual exclusion, not an OS filesystem sandbox. */
export class DirectoryExecutionCoordinator {
  private leases = new Map<string, DirectoryLease>();
  conflicts(roots: readonly string[], exceptSessionId?: string): DirectoryLease[] {
    return [...this.leases.values()].filter(lease => lease.owner.sessionId !== exceptSessionId &&
      roots.some(root => lease.roots.some(held => directoriesOverlap(root, held))));
  }
  acquire(owner: DirectoryOwner, roots: readonly string[]): DirectoryLease {
    const normalized = [...new Set(roots.map(canonicalDirectory))].sort();
    if (!normalized.length) throw new Error('没有可授权的执行目录。');
    const conflict = this.conflicts(normalized, owner.sessionId)[0];
    if (conflict) throw new Error(`工作目录正由会话 ${conflict.owner.sessionId}（${conflict.owner.providerId}）占用，请先关闭该会话或选择独立 worktree。`);
    const existing = [...this.leases.values()].find(lease => lease.owner.sessionId === owner.sessionId);
    if (existing) {
      if (existing.owner.providerId !== owner.providerId || JSON.stringify(existing.roots) !== JSON.stringify(normalized)) {
        throw new Error('会话仍持有旧工作目录，请先完全停止再改变目录或执行引擎。');
      }
      if (existing.owner.generation === owner.generation) return existing;
      // An outer queue/workflow can retain the directory across an explicitly
      // cancelled turn. Renew its inner generation without opening a lock gap.
      this.leases.delete(existing.token);
    }
    const lease = Object.freeze({ token: randomUUID(), owner: Object.freeze({ ...owner }), roots: Object.freeze(normalized) });
    this.leases.set(lease.token, lease);
    return lease;
  }
  release(lease: DirectoryLease): void {
    if (this.leases.get(lease.token) !== lease) throw new Error('旧执行代次不能释放当前工作目录。');
    this.leases.delete(lease.token);
  }
  owns(lease: DirectoryLease): boolean { return this.leases.get(lease.token) === lease; }
  get size(): number { return this.leases.size; }
}
