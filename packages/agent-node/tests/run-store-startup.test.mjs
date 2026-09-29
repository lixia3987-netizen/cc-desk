import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalJson } from '@cc-desk/agent-core';
import { NativeRunStore, nativeSubmissionInputDigest } from '../dist/run-store.js';

const sha = value => createHash('sha256').update(value).digest('hex');
function runRequest(conversationId) {
  const input = 'Inspect this project';
  return { identity: { sessionId: 'session', conversationId, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 },
    input, inputDigest: sha(input), userItems: [{ role: 'user', content: input }], protocol: { id: 'openai-responses', version: 1 },
    configuration: { model: 'fixture', sessionOptions: { connectionId: 'fixture', mcpConnections: ['local'] } }, policyRevision: 'model-policy' };
}
function startup(req, overrides = {}) {
  const request = { identity: req.identity, startupId: 'mcp_stdio_startup', inputDigest: sha(req.input),
    optionsDigest: sha(canonicalJson(req.configuration.sessionOptions)), policyRevision: 'launch-policy',
    metadata: { cwd: '/fixture/project', servers: [{ id: 'local', revision: 1, executable: '/fixture/node', argv: ['server.mjs'], envSources: [{ variable: 'API_TOKEN', source: 'MCP_FIXTURE_TOKEN' }] }] }, ...overrides };
  return { ...request, approval: { binding: { ...request.identity, toolCallId: request.startupId,
    inputDigest: sha(canonicalJson(request.metadata)), policyRevision: request.policyRevision }, decision: 'approved', expiresAt: Date.now() + 60_000 } };
}
async function fixture(t, options = {}) {
  const rootDirectory = await mkdtemp(path.join(tmpdir(), 'native-startup-')), conversationId = randomUUID();
  let store = await NativeRunStore.open({ rootDirectory, conversationId, ...options });
  t.after(async () => { await store.close().catch(() => {}); await rm(rootDirectory, { recursive: true, force: true }); });
  return { rootDirectory, conversationId, get store() { return store; }, reopen: async (extra = {}) => {
    await store.close(); store = await NativeRunStore.open({ rootDirectory, conversationId, ...extra }); return store;
  } };
}
async function finish(store, req, response = 'Done') {
  await store.append(req.identity, { type: 'model_response', response: { outputItems: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: response }] }], toolCalls: [], finishReason: 'completed', usage: null } });
  const result = { identity: req.identity, status: 'completed', modelRequests: 1, toolCalls: 0, usage: null, context: store.loadContext(), committed: true };
  await store.append(req.identity, { type: 'run_finished', result });
  return result;
}

test('startup approval becomes a durable reservation before callers may spawn; getters do not expose mutable state', async t => {
  let reached, release;
  const atSync = new Promise(resolve => { reached = resolve; });
  const allowReturn = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { fault: async (point, event) => { if (point === 'after_sync' && event === 'startup_prepared') { reached(); await allowReturn; } } });
  const req = runRequest(f.conversationId), launch = startup(req);
  let allowedToSpawn = false;
  const prepared = f.store.prepareStartup(launch).then(value => { allowedToSpawn = true; return value; });
  await atSync;
  assert.equal(allowedToSpawn, false);
  const records = (await readFile(path.join(f.store.directory, 'journal.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.at(-1).event.type, 'startup_prepared');
  release();
  assert.equal((await prepared).seq, 2);
  assert.equal(allowedToSpawn, true);
  assert.equal(f.store.loadContext(), null);
  assert.equal(f.store.listRuns().length, 0);
  assert.equal(f.store.recoveryRequired, false);
  const receipt = f.store.lookupStartup(req.identity.requestId);
  assert.equal(receipt.status, 'live');
  receipt.startups[0].metadata.cwd = '/mutated';
  assert.equal(f.store.lookupStartup(req.identity.requestId).startups[0].metadata.cwd, '/fixture/project');
  await f.store.closeStartup(req.identity, launch.startupId);
});

test('startup requires exact approval identity, launch digest, policy, decision and live expiry', async t => {
  const f = await fixture(t), req = runRequest(f.conversationId);
  for (const mutate of [
    value => { value.approval.binding.workerGeneration++; },
    value => { value.approval.binding.toolCallId = 'another'; },
    value => { value.approval.binding.inputDigest = sha('another'); },
    value => { value.approval.binding.policyRevision = 'another'; },
    value => { value.metadata.servers[0].argv.push('unapproved'); },
    value => { value.approval.decision = 'denied'; },
    value => { value.approval.expiresAt = Date.now() - 1; },
  ]) {
    const launch = startup(req); mutate(launch);
    await assert.rejects(f.store.prepareStartup(launch), error => ['stale_approval', 'approval_required'].includes(error.code));
  }
  assert.equal(f.store.usage.records, 1);
  assert.equal(f.store.lookupStartup(req.identity.requestId), undefined);
});

test('startup reservation rejects credentials and secret-shaped metadata fields before persistence', async t => {
  const secret = 'fixture-sensitive-value';
  const f = await fixture(t, { forbiddenValues: [secret] }), req = runRequest(f.conversationId);
  await assert.rejects(f.store.prepareStartup(startup(req, { metadata: { argv: [secret] } })), { code: 'secret_rejected' });
  await assert.rejects(f.store.prepareStartup(startup(req, { metadata: { env: { API_KEY: 'anything' } } })), { code: 'secret_rejected' });
  const launch = startup(req);
  await f.store.prepareStartup(launch);
  assert.equal((await readFile(path.join(f.store.directory, 'journal.jsonl'), 'utf8')).includes(secret), false);
  await f.store.closeStartup(req.identity, launch.startupId);
});

test('live startup belongs to one exact submission and may hand off to its model run', async t => {
  const f = await fixture(t), req = runRequest(f.conversationId), launch = startup(req);
  await f.store.prepareStartup(launch);
  await assert.rejects(f.store.prepareStartup(launch), { code: 'startup_already_prepared' });
  await assert.rejects(f.store.beginRun(runRequest(f.conversationId)), { code: 'conversation_busy' });
  await assert.rejects(f.store.prepareStartup(startup(runRequest(f.conversationId))), { code: 'conversation_busy' });
  await assert.rejects(f.store.beginRun({ ...req, identity: { ...req.identity, workerGeneration: 2 } }), { code: 'stale_owner' });
  await assert.rejects(f.store.beginRun({ ...req, input: 'Changed input' }), { code: 'payload_mismatch' });
  await assert.rejects(f.store.beginRun({ ...req, configuration: { ...req.configuration, sessionOptions: {} } }), { code: 'payload_mismatch' });
  assert.equal((await f.store.beginRun(req)).kind, 'accepted');
  const result = await finish(f.store, req);
  await f.store.closeStartup(req.identity, launch.startupId);
  await f.reopen();
  assert.equal(f.store.recoveryRequired, false);
  assert.equal(f.store.lookupStartup(req.identity.requestId).status, 'closed');
  assert.deepEqual((await f.store.beginRun(req)).result, result);
});

test('all selected startup reservations must be closed and only their owning writer can attest cleanup', async t => {
  const f = await fixture(t), req = runRequest(f.conversationId), first = startup(req), second = startup(req, { startupId: 'second-service' });
  await f.store.prepareStartup(first);
  await f.store.prepareStartup(second);
  await assert.rejects(f.store.closeStartup({ ...req.identity, runId: randomUUID() }, first.startupId), { code: 'stale_owner' });
  const closed = await f.store.closeStartup(req.identity, first.startupId);
  assert.deepEqual(await f.store.closeStartup(req.identity, first.startupId), closed);
  assert.equal(f.store.lookupStartup(req.identity.requestId).status, 'live');
  await f.reopen();
  assert.equal(f.store.lookupStartup(req.identity.requestId).status, 'recovery_required');
  await assert.rejects(f.store.closeStartup(req.identity, second.startupId), { code: 'recovery_required' });
  assert.deepEqual(f.store.getRecoveryReport().tools, [{ callId: second.startupId, name: 'mcp_stdio_startup', status: 'unknown' }]);
});

test('crash before any model run creates an unknown-effects recovery barrier without inventing model context', async t => {
  const f = await fixture(t), req = runRequest(f.conversationId), launch = startup(req);
  await f.store.prepareStartup(launch);
  await f.reopen();
  assert.equal(f.store.listRuns().length, 0);
  assert.equal(f.store.loadContext(), null);
  assert.equal(f.store.recoveryRequired, true);
  const report = f.store.getRecoveryReport();
  assert.equal(report.runId, req.identity.runId);
  assert.equal(report.classification, 'unknown_effects');
  await assert.rejects(f.store.beginRun(req), { code: 'conversation_busy' });
  await assert.rejects(f.store.prepareStartup(startup(runRequest(f.conversationId))), { code: 'conversation_busy' });
  await assert.rejects(f.store.resolveRecovery({ runId: report.runId, expectedHash: report.expectedHash, resourcesVerified: true }), { code: 'unknown_effects' });
  await f.reopen();
  assert.deepEqual(f.store.getRecoveryReport(), report);
});

test('completed model receipt cannot hide a crash before local MCP cleanup', async t => {
  const f = await fixture(t), req = runRequest(f.conversationId), launch = startup(req);
  await f.store.prepareStartup(launch);
  await f.store.beginRun(req);
  const result = await finish(f.store, req);
  await f.reopen();
  assert.deepEqual(f.store.lookupSubmission(req.identity.requestId).result, result);
  assert.equal(f.store.getRecoveryReport().classification, 'unknown_effects');
  assert.equal(f.store.recoveryRequired, true);
  await assert.rejects(f.store.beginRun(req), { code: 'conversation_busy' });
  await assert.rejects(f.store.append(req.identity, { type: 'startup_closed', startupId: launch.startupId }), { code: 'invalid_record' });
});

test('confirmed cleanup with no model receipt still reserves the submission across restart and permits only a new request', async t => {
  const f = await fixture(t), req = runRequest(f.conversationId), launch = startup(req);
  await f.store.prepareStartup(launch);
  await f.store.closeStartup(req.identity, launch.startupId);
  await f.reopen();
  assert.equal(f.store.recoveryRequired, false);
  assert.equal(f.store.lookupSubmission(req.identity.requestId), undefined);
  assert.equal(f.store.lookupStartup(req.identity.requestId).status, 'closed');
  await assert.rejects(f.store.prepareStartup(launch), { code: 'startup_already_prepared' });
  await assert.rejects(f.store.prepareStartup(startup(req, { startupId: 'replacement' })), { code: 'startup_already_prepared' });
  await assert.rejects(f.store.beginRun(req), { code: 'startup_already_prepared' });
  const next = runRequest(f.conversationId), nextLaunch = startup(next);
  await f.store.prepareStartup(nextLaunch);
  await f.store.closeStartup(next.identity, nextLaunch.startupId);
});

test('startup preparation after fsync failure poisons this writer and leaves a durable recovery barrier', async t => {
  const f = await fixture(t, { fault: (point, event) => { if (point === 'after_sync' && event === 'startup_prepared') throw new Error('fault'); } });
  const req = runRequest(f.conversationId), launch = startup(req);
  await assert.rejects(f.store.prepareStartup(launch), /fault/);
  assert.equal(f.store.recoveryRequired, true);
  await assert.rejects(f.store.closeStartup(req.identity, launch.startupId), { code: 'recovery_required' });
  await f.reopen();
  assert.equal(f.store.lookupStartup(req.identity.requestId).status, 'recovery_required');
  assert.equal(f.store.getRecoveryReport().classification, 'unknown_effects');
});

test('uncertain cleanup persistence is resolved only by reopening the actual journal', async t => {
  const f = await fixture(t, { fault: (point, event) => { if (point === 'after_sync' && event === 'startup_closed') throw new Error('fault'); } });
  const req = runRequest(f.conversationId), launch = startup(req);
  await f.store.prepareStartup(launch);
  await assert.rejects(f.store.closeStartup(req.identity, launch.startupId), /fault/);
  assert.equal(f.store.recoveryRequired, true);
  await f.reopen();
  assert.equal(f.store.recoveryRequired, false);
  assert.equal(f.store.lookupStartup(req.identity.requestId).status, 'closed');
});

test('startup needs durable cleanup headroom before it is allowed to launch', async t => {
  const f = await fixture(t, { limits: { maxRecords: 3 } }), req = runRequest(f.conversationId);
  await assert.rejects(f.store.prepareStartup(startup(req)), { code: 'limit_exceeded' });
  assert.equal(f.store.usage.records, 1);
  assert.equal(f.store.lookupStartup(req.identity.requestId), undefined);
});

test('live host startup permits pre-model automatic compaction; abandoned startup blocks compaction after restart', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 2; i++) {
    const prior = runRequest(f.conversationId);
    await f.store.beginRun(prior);
    await finish(f.store, prior, 'Detailed prior work. '.repeat(400));
  }
  const req = runRequest(f.conversationId), launch = startup(req);
  await f.store.prepareStartup(launch);
  const source = f.store.getCompactionSource();
  assert.equal((await f.store.reserveAutoCompaction({ requestId: req.identity.requestId, inputDigest: launch.inputDigest, configurationDigest: launch.optionsDigest, expectedHash: source.expectedHash })).kind, 'reserved');
  const plan = f.store.planContextCompaction({ summary: 'Earlier inspection completed.', expectedHash: f.store.getCompactionSource().expectedHash, automaticRequestId: req.identity.requestId });
  await f.store.commitContextCompaction(plan);
  await f.reopen();
  assert.equal(f.store.getRecoveryReport().classification, 'unknown_effects');
  assert.throws(() => f.store.getCompactionSource(), { code: 'conversation_busy' });
});


test('image startup submission binds exact attachment hashes and legacy text startup still replays', async t => {
  const f = await fixture(t), req = runRequest(f.conversationId);
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
  const imageAttachments = [{ name: 'picture.png', mimeType: 'image/png', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }];
  req.configuration.imageAttachments = imageAttachments;
  req.userItems = [{ role: 'user', content: [{ type: 'input_text', text: req.input }, { type: 'input_image', image_url: `data:image/png;base64,${bytes.toString('base64')}`, detail: 'auto' }] }];
  const launch = startup(req, { inputDigest: nativeSubmissionInputDigest(req.input, imageAttachments) });
  assert.notEqual(launch.inputDigest, sha(req.input));
  await f.store.prepareStartup(launch);
  await assert.rejects(f.store.beginRun({ ...req, configuration: { ...req.configuration, imageAttachments: [{ ...imageAttachments[0], sha256: 'a'.repeat(64) }] } }), { code: 'payload_mismatch' });
  await assert.rejects(f.store.beginRun({ ...req, configuration: { ...req.configuration, imageAttachments: [] } }), { code: 'payload_mismatch' });
  assert.equal((await f.store.beginRun(req)).kind, 'accepted');
  const result = await finish(f.store, req);
  await f.store.closeStartup(req.identity, launch.startupId);
  await f.reopen();
  assert.equal(f.store.lookupStartup(req.identity.requestId).inputDigest, launch.inputDigest);
  assert.deepEqual((await f.store.beginRun(req)).result, result);
  assert.throws(() => f.store.getCompactionSource(), { code: 'image_context_compaction_unsupported' });
});
