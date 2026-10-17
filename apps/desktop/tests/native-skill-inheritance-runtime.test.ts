import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { runAgent, type JsonValue, type ModelPort, type ModelResponse, type RunIdentity, type ToolCall, type ToolPort, type RunStore } from '@cc-desk/agent-core';
import { createNativeModel } from '@cc-desk/agent-node/native-model';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { SkillRegistry } from '@cc-desk/agent-node/skill-registry';
import { SkillSnapshotStore } from '@cc-desk/agent-node/skill-snapshots';
import { composeToolPorts } from '@cc-desk/agent-node/mcp-tools';
import type { NativeSkillSubmission } from '@cc-desk/contracts/native-skills';
import { NativeSkillRuntime, isNativeSkillInheritanceManifest, normalizeNativeSkillInheritanceManifest, type NativeSkillInheritanceManifest } from '../src/main/engines/native/skill-runtime';
import { nativeSkillInheritanceDigest } from '../src/main/engines/native/skill-inheritance';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const identity = (): RunIdentity => ({ sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 });
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value));
const finalResponse = (): ModelResponse => ({ outputItems: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Completed runtime fixture.' }] }],
  toolCalls: [], finishReason: 'completed', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
const toolResponse = (...calls: ToolCall[]): ModelResponse => ({ outputItems: calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments })),
  toolCalls: calls, finishReason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
const call = (name: string, args: unknown): ToolCall => ({ id: randomUUID(), name, arguments: JSON.stringify(args) });
const guide = (name: string) => `---\nname: ${name}\ndescription: Exact ${name} engineering guide.\n---\nComplete ${name} constraints.\n`;

async function fixture(t: { after(fn: () => Promise<void>): void }, options: { dynamic?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-skill-inheritance-runtime-'));
  const project = path.join(directory, 'project'), childProject = path.join(directory, 'child'), user = path.join(directory, 'user');
  const snapshots = new SkillSnapshotStore({ directory: path.join(directory, 'snapshots') });
  for (const name of ['active', 'candidate']) {
    const target = path.join(project, '.agents', 'skills', name, 'SKILL.md'); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, guide(name));
  }
  await fs.mkdir(path.join(user, 'global'), { recursive: true }); await fs.writeFile(path.join(user, 'global', 'SKILL.md'), guide('global'));
  await fs.cp(project, childProject, { recursive: true });
  const parentIdentity = identity(), projectId = randomUUID(), abort = new AbortController();
  const registry = () => new SkillRegistry({ projectId, projectRoot: project, sources: [
    { id: 'project-agents', scope: 'project', kind: 'project-agents', rootPath: '.agents/skills', enabled: true, revision: 1 },
    { id: 'custom-user', scope: 'user', kind: 'custom', rootPath: user, enabled: true, revision: 1 },
  ] });
  let invalidSession = 0, registryHook: (() => void | Promise<void>) | undefined, ownershipHook: (() => void | Promise<void>) | undefined;
  let forbiddenHook: (() => void | Promise<void>) | undefined;
  const runtime = new NativeSkillRuntime({ registry: async sessionId => { if (sessionId !== parentIdentity.sessionId) { invalidSession++; throw new Error('Child sessions have no UI registry.'); }
    await registryHook?.(); return registry(); },
    snapshots, forbiddenValues: async () => { await forbiddenHook?.(); return []; } });
  const catalog = await registry().discover(), active = catalog.entries.find(entry => entry.name === 'active')!;
  const activeVersion = (await registry().loadCatalogSkill(active)).version;
  const submission: NativeSkillSubmission = { schemaVersion: 1, explicitSkillRefs: [{ skillId: active.skillId, catalogRevision: catalog.revision, version: activeVersion }], excludedSkillIds: [] };
  await runtime.prepareSubmission(parentIdentity.sessionId, submission);
  const parent = await runtime.createRun({ sessionId: parentIdentity.sessionId, identity: parentIdentity, ...(options.dynamic ? {} : { submission }),
    baseInstructionBytes: 0, signal: abort.signal, assertOwnership: async () => { await ownershipHook?.(); } });
  const ledger = await NativeRunStore.open({ rootDirectory: path.join(directory, 'conversations'), conversationId: parentIdentity.conversationId });
  t.after(async () => { abort.abort(); await ledger.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const f = { directory, project, childProject, user, runtime, parent, parentIdentity, ledger, abort, active, activeVersion, submission,
    get invalidSession() { return invalidSession; },
    setRegistryHook(hook: typeof registryHook) { registryHook = hook; },
    setOwnershipHook(hook: typeof ownershipHook) { ownershipHook = hook; },
    setForbiddenHook(hook: typeof forbiddenHook) { forbiddenHook = hook; },
    childOptions(inheritance: NativeSkillInheritanceManifest) { return { sessionId: parentIdentity.sessionId, parentIdentity, inheritance, identity: identity(), projectRoot: childProject,
      signal: abort.signal, baseInstructionBytes: 0, assertOwnership: () => {} }; },
    async run(action: () => Promise<void>, allowReplacedObserver = false) {
      let failure: unknown, called = false;
      const definition = { name: 'capture_inheritance', description: 'A host runtime fixture.', risk: 'read' as const,
        inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false } };
      const capture: ToolPort = { definitions: [definition], prepare: async (call, context) => ({ call, definition, input: {}, inputDigest: hash('{}'),
        policyRevision: context.policyRevision, preconditions: {}, requiresApproval: false }), validate: async () => {}, execute: async () => {
        called = true; try { await action(); } catch (error) { failure = error; }
        return { status: 'completed', output: { captured: true } };
      } };
      const tools = composeToolPorts([parent.tools, capture]);
      const adapter = createNativeModel({ protocol: 'responses', baseURL: 'https://example.invalid/v1', model: 'fixture', apiKey: 'sk-local-inheritance-fixture-only' });
      let requests = 0;
      const model: ModelPort = { protocol: adapter.protocol, userItems: input => adapter.userItems(input), toolResultItems: (call, result) => adapter.toolResultItems(call, result),
        estimateInputTokens: context => adapter.estimateInputTokens(context), generate: async () => ++requests === 1
          ? toolResponse(...(options.dynamic ? [call('load_skill', { skillId: active.skillId, catalogRevision: catalog.revision })] : []), call('capture_inheritance', {})) : finalResponse() };
      const store: RunStore = { beginRun: request => ledger.beginRun(request), ensureCapacity: (identity, bytes) => ledger.ensureCapacity(identity, bytes),
        checkpoint: (identity, context) => ledger.checkpoint(identity, context), append: async (identity, event) => {
          const receipt = await ledger.append(identity, event); parent.tools.observeCommitted(event, receipt.seq); return receipt;
        } };
      const result = await runAgent({ identity: parentIdentity, input: 'Capture the exact child inheritance.', policyRevision: 'fixture-policy', signal: abort.signal,
        configuration: { ...(options.dynamic ? {} : { nativeSkills: json(submission) }), modelInstructions: parent.initialInstructions,
          nativeSkillCatalog: { revision: parent.catalogRevision, entries: json(parent.catalog.entries.map(({ skillId, sourceId, relativePath, sourceRevision, sourceFingerprint, metadataHash, format }) =>
            ({ skillId, sourceId, relativePath, sourceRevision, sourceFingerprint, metadataHash, format }))), truncated: parent.catalog.truncated }, initialNativeSkills: json(parent.tools.snapshot()) },
      }, { model, tools, store, approvals: { request: async request => ({ binding: request.binding, decision: 'approved', expiresAt: request.expiresAt }) },
        host: { now: Date.now, digest: hash, emit: () => {}, deadline: (ms, parent) => {
          const controller = new AbortController(), cancel = () => controller.abort(), timer = setTimeout(cancel, ms); parent.addEventListener('abort', cancel, { once: true });
          return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent.removeEventListener('abort', cancel); } };
        } } });
      if (failure) throw failure;
      assert.equal(called, true);
      // A controlled host-observer replacement below intentionally advances its
      // sequence past this fixture's tool batch; it cannot complete that batch.
      if (!allowReplacedObserver) assert.equal(result.status, 'completed');
    },
  };
  return f;
}

test('captured project candidates rebind to the child root while approved user roots stay fixed', async t => {
  const f = await fixture(t);
  await f.run(async () => {
    const manifest = await f.parent.prepareInheritance(f.ledger);
    assert.equal(manifest.catalog.entries.length, 3); assert.equal(manifest.context.parentManifest.entries.length, 1);
    const options = f.childOptions(manifest), child = await f.runtime.createChildRun(options);
    const active = child.tools.snapshot().activations[0];
    assert.equal(active.origin, 'inherited'); assert.equal(active.version.skillId, f.activeVersion.skillId);
    assert.equal(active.version.fullFileHash, f.activeVersion.fullFileHash);
    assert.notEqual(active.version.sourceFingerprint, f.activeVersion.sourceFingerprint);
    assert.equal(active.confirmedByResponseId, undefined); assert.equal(active.offeredToRequestId, undefined);
    assert.equal(active.receiptSeq, 0); assert.deepEqual(active.inheritedFrom?.version, f.activeVersion);
    assert.equal(child.catalog.entries.find(entry => entry.name === 'global')!.sourceFingerprint, manifest.catalog.entries.find(entry => entry.name === 'global')!.sourceFingerprint);
    assert.equal(f.invalidSession, 0);
    await assert.rejects(child.tools.assertSideEffectsCurrent(options.signal), /observation/);
  });
});

test('inactive candidate changes invalidate the original frozen manifest rather than offering the new version', async t => {
  const f = await fixture(t);
  await f.run(async () => {
    const manifest = await f.parent.prepareInheritance(f.ledger), original = structuredClone(manifest);
    await fs.appendFile(path.join(f.project, '.agents', 'skills', 'candidate', 'SKILL.md'), 'Changed inactive guide.');
    await assert.rejects(f.runtime.assertInheritanceCurrent(f.childOptions(manifest)), /changed|改变/i);
    await assert.rejects(f.runtime.preflightChild(f.childOptions(manifest)), /changed|改变/i);
    assert.deepEqual(manifest, original);
  });
});

for (const mode of ['missing', 'different'] as const) test(`a ${mode} child guide fails without falling back to the parent's root`, async t => {
  const f = await fixture(t);
  await f.run(async () => {
    const manifest = await f.parent.prepareInheritance(f.ledger), target = path.join(f.childProject, '.agents', 'skills', 'active', 'SKILL.md');
    if (mode === 'missing') await fs.rm(target); else await fs.appendFile(target, 'Unreviewed child guide change.');
    await assert.rejects(f.runtime.preflightChild(f.childOptions(manifest)), /differs/);
    await assert.rejects(f.runtime.createChildRun(f.childOptions(manifest)), /differs/);
    assert.equal(await fs.readFile(path.join(f.project, '.agents', 'skills', 'active', 'SKILL.md'), 'utf8'), guide('active'));
  });
});

test('child-local candidates added after freezing never enlarge the inherited catalog', async t => {
  const f = await fixture(t);
  await f.run(async () => {
    const manifest = await f.parent.prepareInheritance(f.ledger), added = path.join(f.childProject, '.agents', 'skills', 'unreviewed', 'SKILL.md');
    await fs.mkdir(path.dirname(added)); await fs.writeFile(added, guide('unreviewed'));
    const child = await f.runtime.createChildRun(f.childOptions(manifest));
    assert.equal(child.catalog.entries.length, manifest.catalog.entries.length);
    assert.equal(child.catalog.entries.some(entry => entry.name === 'unreviewed'), false);
    assert.equal(child.initialInstructions.includes('Complete unreviewed constraints'), false);
  });
});

test('read-only delegation cannot freeze a new guide from the same unobserved model batch', async t => {
  const f = await fixture(t, { dynamic: true });
  await f.run(async () => {
    assert.equal(f.parent.tools.snapshot().activations.length, 1);
    await assert.rejects(f.parent.prepareInheritance(f.ledger), /observation/);
  });
});

test('strict manifest normalization rejects accessors without invocation and modified attestations without a host capability', async t => {
  const f = await fixture(t);
  await f.run(async () => {
    const manifest = await f.parent.prepareInheritance(f.ledger);
    assert.equal(isNativeSkillInheritanceManifest(manifest), true);
    let reads = 0;
    const accessor = { ...manifest, get catalog() { reads++; return manifest.catalog; } };
    assert.equal(isNativeSkillInheritanceManifest(accessor), false); assert.equal(reads, 0);
    assert.throws(() => normalizeNativeSkillInheritanceManifest({ ...manifest, extra: true }));
    const changed = structuredClone(manifest); changed.context.parentHead.seq++;
    const { digest: _digest, ...shape } = changed; changed.digest = nativeSkillInheritanceDigest(shape);
    assert.equal(isNativeSkillInheritanceManifest(changed), true);
    await assert.rejects(f.runtime.preflightChild(f.childOptions(changed)), /owned/);
  });
});

test('a settled parent and an explicitly released capture cannot start a new child', async t => {
  const f = await fixture(t); let captured: NativeSkillInheritanceManifest | undefined;
  await f.run(async () => { captured = await f.parent.prepareInheritance(f.ledger); });
  await assert.rejects(f.runtime.preflightChild(f.childOptions(captured!)), /cancelled/);
  f.runtime.releaseInheritance(f.parentIdentity);
  await assert.rejects(f.runtime.preflightChild(f.childOptions(captured!)), /owned/);
});

test('a capture released during an asynchronous source check cannot authorize a child after that wait', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await f.run(async () => {
    const manifest = await f.parent.prepareInheritance(f.ledger);
    let entered!: () => void, resume!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { resume = resolve; });
    f.setRegistryHook(async () => { f.setRegistryHook(undefined); entered(); await held; });
    const checking = f.runtime.assertInheritanceCurrent(f.childOptions(manifest));
    try {
      await reached;
      f.runtime.releaseInheritance(f.parentIdentity);
      resume();
      await assert.rejects(checking, /改变/);
    } finally { resume(); await checking.catch(() => {}); }
  });
});

test('same-version context replacement at the final parent ownership fence invalidates inheritance observation', async t => {
  const f = await fixture(t);
  await f.run(async () => {
    const manifest = await f.parent.prepareInheritance(f.ledger);
    let registries = 0, ownershipChecks = 0, replaced = false;
    f.setRegistryHook(() => {
      if (++registries === 3) f.setOwnershipHook(() => {
        if (++ownershipChecks === 3) {
          f.setOwnershipHook(undefined); replaced = true;
          f.parent.tools.observeContextReplacement(f.ledger.head!.seq + 1, manifest.context.parentManifest);
        }
      });
    });
    await assert.rejects(f.runtime.assertInheritanceCurrent(f.childOptions(manifest)), { code: 'active_skills_changed' });
    assert.equal(replaced, true);
    assert.equal(f.parent.tools.snapshot().activations[0].confirmedByResponseId, undefined);
  }, true);
});

test('same-version context replacement during final credential inspection cannot publish a prepared inheritance', async t => {
  const f = await fixture(t);
  await f.run(async () => {
    const original = await f.parent.prepareInheritance(f.ledger); f.runtime.releaseInheritance(f.parentIdentity);
    let protectedReads = 0, replaced = false;
    f.setForbiddenHook(() => {
      if (++protectedReads === f.parent.catalog.entries.length + 3) {
        f.setForbiddenHook(undefined); replaced = true;
        f.parent.tools.observeContextReplacement(f.ledger.head!.seq + 1, original.context.parentManifest);
      }
    });
    await assert.rejects(f.parent.prepareInheritance(f.ledger), { code: 'active_skills_changed' });
    assert.equal(replaced, true);
    await assert.rejects(f.runtime.preflightChild(f.childOptions(original)), /owned/);
  }, true);
});

test('revoking the parent capability during final child ownership inspection cannot return a runnable child', async t => {
  const f = await fixture(t);
  await f.run(async () => {
    const manifest = await f.parent.prepareInheritance(f.ledger), options = f.childOptions(manifest);
    let ownershipChecks = 0, revoked = false;
    options.assertOwnership = () => {
      if (++ownershipChecks === 3) { revoked = true; f.runtime.releaseInheritance(f.parentIdentity); }
    };
    await assert.rejects(f.runtime.createChildRun(options), /改变/);
    assert.equal(revoked, true);
  });
});
