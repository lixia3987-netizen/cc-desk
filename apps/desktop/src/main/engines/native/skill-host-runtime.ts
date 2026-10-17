import path from 'node:path';
import { SkillSnapshotStore } from '@cc-desk/agent-node/skill-snapshots';
import type { NativeSkillSubmission } from '@cc-desk/contracts/native-skills';
import type { StateStore } from '../../store';
import type { ConnectionStore } from './connections';
import type { NativeMcpConnectionStore } from './mcp-connections';
import { NativeSkillCatalogHost } from './skill-catalog-host';
import { NativeSkillRuntime, type NativeSkillRunOptions, type NativeSkillChildRunOptions, type NativeSkillRuntimeOptions } from './skill-runtime';

/** Keep a whole runtime operation and all later tool ownership checks on its original host scope. */
class HostBoundNativeSkillRuntime extends NativeSkillRuntime {
  constructor(private readonly catalog: NativeSkillCatalogHost, options: NativeSkillRuntimeOptions) { super(options); }
  override async prepareSubmission(sessionId: string, submission: NativeSkillSubmission, signal?: AbortSignal) {
    const capture = this.catalog.capture(sessionId);
    const prepared = await super.prepareSubmission(sessionId, submission, signal);
    capture.assertCurrent();
    return prepared;
  }
  override async prepareConversationContinuity(...args: Parameters<NativeSkillRuntime['prepareConversationContinuity']>) {
    const capture = this.catalog.capture(args[0]);
    const continuity = await super.prepareConversationContinuity(...args);
    capture.assertCurrent();
    return continuity;
  }
  private bind<T extends NativeSkillRunOptions>(input: T): T {
    const capture = this.catalog.capture(input.sessionId);
    return { ...input, assertOwnership: async () => {
      capture.assertCurrent();
      await input.assertOwnership();
      capture.assertCurrent();
    } };
  }
  override createRun(input: NativeSkillRunOptions) { return super.createRun(this.bind(input)); }
  override createChildRun(input: NativeSkillChildRunOptions) { return super.createChildRun(this.bind(input)); }
}

/** Internal assembly only. main/index deliberately does not construct or inject this runtime. */
export function createNativeSkillHostRuntime(store: StateStore, options: {
  catalog: NativeSkillCatalogHost;
  connections: ConnectionStore;
  mcpConnections?: NativeMcpConnectionStore;
  snapshots?: SkillSnapshotStore;
}) {
  options.catalog.assertStore(store);
  const snapshots = options.snapshots ?? new SkillSnapshotStore({ directory: path.join(store.directory, 'native', 'skill-snapshots') });
  const runtime = new HostBoundNativeSkillRuntime(options.catalog, { registry: id => options.catalog.registry(id), snapshots,
    forbiddenValues: () => [...options.connections.protectedValues(), ...(options.mcpConnections?.protectedValues() ?? [])] });
  return { runtime, prepareNativeSkills: async (sessionId: string, submission: NativeSkillSubmission): Promise<NativeSkillSubmission> => {
    return runtime.prepareSubmission(sessionId, submission);
  } };
}
