import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { runAgent, type ModelPort, type ModelResponse, type ToolCall } from '@cc-desk/agent-core';
import { createNativeModel } from '@cc-desk/agent-node/native-model';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { SkillRegistry } from '@cc-desk/agent-node/skill-registry';
import { SkillSnapshotStore } from '@cc-desk/agent-node/skill-snapshots';
import type { NativeSkillSubmission } from '@cc-desk/contracts/native-skills';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { NativeSkillRuntime } from '../src/main/engines/native/skill-runtime';
import { createNativeConfig } from '../src/main/engines/native/config';

const exec = promisify(execFile);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const final = (): ModelResponse => ({ outputItems: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reviewed fixture.txt and the isolated current delivery.' }] }],
  toolCalls: [], finishReason: 'completed', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
const callResponse = (name: string, input: unknown, id: string = randomUUID()): ModelResponse => {
  const call: ToolCall = { id, name, arguments: JSON.stringify(input) };
  return { outputItems: [{ type: 'function_call', call_id: call.id, name, arguments: call.arguments }], toolCalls: [call], finishReason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
};

test('one parent workflow quality round freezes Skills once while all three independent children concurrently pass strict inheritance preflight', { timeout: 30000 }, async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-workflow-skill-quality-')));
  const project = path.join(directory, 'project'), data = path.join(directory, 'data');
  const skillPath = path.join(project, '.agents', 'skills', 'engineering', 'SKILL.md');
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  // This fixture tests exact raw-byte Skill inheritance. Keep only its two
  // evidence files stable through checkout while inheriting host Git settings.
  await fs.writeFile(path.join(project, '.gitattributes'), '/.agents/skills/engineering/SKILL.md -text\n/fixture.txt -text\n');
  await fs.writeFile(skillPath, '---\nname: engineering\ndescription: Exact independent quality engineering guide.\n---\nINHERITED_QUALITY_GUIDE Preserve unrelated files and cite actual material evidence.\n');
  await fs.writeFile(path.join(project, 'fixture.txt'), 'actual quality material\n');
  for (const args of [['init'], ['config', 'user.name', 'Local workflow fixture'], ['config', 'user.email', 'fixture@example.invalid'], ['add', '.'], ['commit', '-m', 'fixture baseline']]) await exec('git', args, { cwd: project });
  const id = randomUUID(), projectId = randomUUID(), conversationId = randomUUID();
  const registry = () => new SkillRegistry({ projectId, projectRoot: project, excludedRoots: [data], sources: [
    { id: 'project-agents', scope: 'project', kind: 'project-agents', rootPath: '.agents/skills', enabled: true, revision: 1 },
  ] });
  const runtime = new NativeSkillRuntime({ registry, forbiddenValues: () => ['sk-quality-inheritance-local-fixture'], snapshots: new SkillSnapshotStore({ directory: path.join(data, 'native', 'skill-snapshots') }) });
  let freezes = 0;
  const createRun = runtime.createRun.bind(runtime);
  t.mock.method(runtime, 'createRun', async (...args: Parameters<typeof createRun>) => {
    const run = await createRun(...args), prepare = run.prepareInheritance.bind(run);
    run.prepareInheritance = async (...input: Parameters<typeof prepare>) => { freezes++; return prepare(...input); };
    return run;
  });
  let entered = 0, release!: () => void;
  const concurrent = new Promise<void>(resolve => { release = resolve; });
  const manifests: string[] = [], childIds = new Set<string>();
  const preflight = runtime.preflightChild.bind(runtime);
  t.mock.method(runtime, 'preflightChild', async (...args: Parameters<typeof preflight>) => {
    manifests.push(args[0].inheritance.digest); childIds.add(args[0].identity.runId);
    if (++entered === 3) release();
    await concurrent;
    // Run the actual private-capture identity fence after all roles arrive.
    return preflight(...args);
  });
  const store = new StateStore(data), connections = new ConnectionStore(data), events = new ExecutionEvents();
  const connection = connections.upsert({ name: 'local deterministic quality model', protocol: 'responses', baseURL: 'https://example.invalid/v1', model: 'fixture', enabled: true, allowLoopbackHttp: false, auth: { mode: 'memory' } });
  connections.setCredential({ id: connection.id, revision: connection.revision, mode: 'memory', secret: 'sk-quality-inheritance-local-fixture' });
  const timestamp = new Date().toISOString();
  store.change(state => {
    state.projects.push({ id: projectId, path: project, name: 'quality project', createdAt: timestamp });
    state.sessions.push({ id, projectId, title: 'quality inheritance', kind: 'agent', cwd: project, execution: { providerId: 'native', mode: 'structured', conversationId },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: connection.id, autoCompact: 'off', maxInputTokens: 240000, maxSubagents: 3 } }),
      started: false, archived: false, status: 'idle', createdAt: timestamp, updatedAt: timestamp });
  });
  const worker: NonNullable<NativeExecutorOptions['worker']> = async options => {
    const transport = createNativeModel(options.model), quality = options.request.configuration.workflowQuality as { role: string } | undefined;
    let step = 0;
    const model: ModelPort = { protocol: transport.protocol, userItems: input => transport.userItems(input), toolResultItems: (call, result) => transport.toolResultItems(call, result),
      estimateInputTokens: context => transport.estimateInputTokens(context), generate: async request => {
        assert.match(options.model.instructions!, /INHERITED_QUALITY_GUIDE/);
        const initial = options.request.configuration.initialNativeSkills as any;
        assert.equal(initial.activations.length, 1);
        assert.equal(initial.activations[0].confirmedByResponseId, undefined);
        assert.equal(initial.activations[0].runId, request.identity.runId);
        if (quality) assert.equal(initial.activations[0].origin, 'inherited');
        step++;
        if (!quality && step === 1) return callResponse('update_plan', { expectedRevision: 0, plan: { goal: 'Independently inspect fixture.txt and delivery evidence.',
          steps: [{ id: 'inspect', title: 'Inspect actual material', dependsOn: [], status: 'in_progress' }],
          criteria: [{ id: 'manual-review', description: 'The user reviews actual delivery evidence before acceptance.', stepIds: ['inspect'], kind: 'manual' }] } });
        if (step === (quality ? 1 : 2)) return callResponse('read_file', { path: 'fixture.txt' }, 'actual-material-read');
        if (quality && step === 2) return callResponse('submit_quality_report', { verdict: 'passed', reviewedPaths: ['fixture.txt'], limitations: [], findings: [], resolutions: [],
          verification: { status: 'not_applicable', commandToolCallIds: [], reason: 'This workflow delivery is static inspection with actual full material reads.' } });
        return final();
      } };
    return runAgent({ ...options.request, signal: options.signal }, { model, tools: options.tools, store: options.store, approvals: options.approvals,
      completionValidation: options.completionValidation, contextMaintenance: options.contextMaintenance,
      host: { now: Date.now, digest: hash, emit: options.onEvent, consumeBudget: options.consumeBudget,
        deadline: (ms, signal) => { const abort = new AbortController(), cancel = () => abort.abort(), timer = setTimeout(cancel, ms);
          signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
          return { signal: abort.signal, dispose() { clearTimeout(timer); signal.removeEventListener('abort', cancel); } }; } } });
  };
  const executor = new NativeStructuredExecutor(store, connections, events, { worker, skills: runtime });
  t.after(async () => { release(); await executor.shutdown().catch(() => {}); store.flush(); await fs.rm(directory, { recursive: true, force: true }); });
  await executor.initialize();
  const source = registry(), catalog = await source.discover(), loaded = await source.loadCatalogSkill(catalog.entries[0]);
  const submission: NativeSkillSubmission = { schemaVersion: 1, explicitSkillRefs: [{ skillId: loaded.version.skillId, version: loaded.version, catalogRevision: catalog.revision }], excludedSkillIds: [] };
  await runtime.prepareSubmission(id, submission);
  const result = await executor.send(id, '使用 workflow，独立分析 `fixture.txt` 并核对交付结论。', [], undefined, { requestId: randomUUID(), nativeSkills: submission,
    nativeExecutionPolicy: { toolPolicy: 'read_only', collaboration: 'adversarial', qualityValidation: 'static' } });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(freezes, 1, 'Concurrent quality roles must share one host-owned private capture per round.');
  assert.equal(entered, 3); assert.equal(childIds.size, 3); assert.equal(new Set(manifests).size, 1);
  const quality = result.nativeReceipt?.workflowQuality;
  assert.equal(quality?.status, 'passed'); assert.equal(quality?.round, 1); assert.equal(quality?.manualAcceptance, 'not_requested');
  assert.deepEqual(quality?.rounds[0].roles.map(role => role.role).sort(), ['challenger', 'reviewer', 'verifier']);
  for (const role of quality!.rounds[0].roles) {
    assert.equal(role.status, 'completed'); assert.equal(role.report?.declaration.verdict, 'passed');
    const ledger = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId: role.identity.conversationId });
    try { const run = ledger.getRun(role.identity.runId)!;
      assert.equal(run.result?.committed, true); assert.equal(run.result?.status, 'completed');
      assert.ok(run.configuration.nativeSkillInheritance); assert.equal(run.tools.filter(tool => tool.call.name === 'submit_quality_report' && tool.completed?.result.status === 'completed').length, 1);
    } finally { await ledger.close(); }
  }
  assert.equal(await fs.readFile(path.join(project, 'fixture.txt'), 'utf8'), 'actual quality material\n');
});
