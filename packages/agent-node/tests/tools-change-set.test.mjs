import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LocalToolPort, LOCAL_TOOL_DEFINITIONS } from '../dist/tools/local-tools.js';
import { ProcessSupervisor } from '../dist/process-supervisor.js';
import { contentHash } from '../dist/tools/project-files.js';
import { loadProjectInstructions } from '../dist/project-instructions.js';

const identity = { sessionId: 's', conversationId: 'conversation', runId: 'run', requestId: 'request', workerGeneration: 1 };
const context = overrides => ({ identity: { ...identity }, policyRevision: 'policy-1', signal: new AbortController().signal, maxOutputBytes: 32768, ...overrides });
const call = (id, changes) => ({ id, name: 'apply_change_set', arguments: JSON.stringify({ changes }) });
const approve = (prepared, ctx) => ({ decision: 'approved', expiresAt: Date.now() + 60000, binding: { ...ctx.identity, toolCallId: prepared.call.id, inputDigest: prepared.inputDigest, policyRevision: ctx.policyRevision } });
const pair = () => [{ path: 'a.txt', content: 'a after\n', expectedHash: contentHash('a before\n') }, { path: 'b.txt', content: 'b after\n', expectedHash: contentHash('b before\n') }];
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-change-set-tools-'));
  const supervisor = new ProcessSupervisor(), events = [];
  await fs.writeFile(path.join(root, 'a.txt'), 'a before\n'); await fs.writeFile(path.join(root, 'b.txt'), 'b before\n');
  await fs.writeFile(path.join(root, 'unrelated.txt'), 'user change retained\n');
  const recordChangeSetEvent = async (run, toolCall, event) => {
    events.push({ identity: structuredClone(run), call: structuredClone(toolCall), event: structuredClone(event) });
    await options.onRecord?.(event, { root, events });
  };
  const config = { projectRoot: root, supervisor, ownerId: 'group-owner', ...options, recordChangeSetEvent: options.withoutRecorder ? undefined : recordChangeSetEvent };
  delete config.onRecord; delete config.withoutRecorder;
  const port = new LocalToolPort(config);
  t.after(async () => { await supervisor.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, supervisor, port, events, config };
}
const contents = async root => Promise.all(['a.txt', 'b.txt'].map(file => fs.readFile(path.join(root, file), 'utf8')));
async function readScope(port, ctx, id, relative) {
  const prepared = await port.prepare({ id, name: 'list_directory', arguments: JSON.stringify({ path: relative, depth: 0 }) }, ctx);
  return port.execute(prepared, ctx);
}

test('grouped changes show a complete digest-bound preview, require approval and durably report each individual effect', async t => {
  const f = await fixture(t), ctx = context(), input = pair();
  const prepared = await f.port.prepare(call('group', input), ctx), preview = prepared.preconditions.changeSet;
  assert.equal(prepared.requiresApproval, true); assert.equal(prepared.definition.risk, 'write');
  assert.equal(preview.atomic, false); assert.equal(preview.files.length, 2); assert.match(preview.digest, /^[a-f0-9]{64}$/);
  assert.match(preview.files[0].diff, /a before/); assert.match(preview.files[0].diff, /a after/);
  assert.equal(preview.files[0].beforeHash, input[0].expectedHash); assert.equal(preview.files[0].afterHash, contentHash(input[0].content));
  assert.deepEqual(await contents(f.root), ['a before\n', 'b before\n']); assert.equal(f.events.length, 0);
  const permission = approve(prepared, ctx);
  const [result, concurrent] = await Promise.all([f.port.execute(prepared, ctx, permission), f.port.execute(prepared, ctx, permission)]);
  assert.deepEqual(result, concurrent); assert.equal(result.status, 'completed'); assert.equal(result.output.atomic, false);
  assert.equal(result.output.digest, preview.digest); assert.equal(result.output.receiptCommitted, true);
  assert.deepEqual(result.output.files.map(file => file.status), ['applied', 'applied']);
  assert.deepEqual(f.events.map(item => [item.event.index, item.event.status]), [[0, 'prepared'], [0, 'applied'], [1, 'prepared'], [1, 'applied']]);
  assert.ok(f.events.every(item => item.event.changeSetDigest === preview.digest));
  assert.deepEqual(f.events[0].identity, identity); assert.deepEqual(f.events[0].call, prepared.call);
  assert.deepEqual(result.effects.changeSet, result.output);
  assert.deepEqual(await contents(f.root), ['a after\n', 'b after\n']);
  assert.equal(await fs.readFile(path.join(f.root, 'unrelated.txt'), 'utf8'), 'user change retained\n');
  await fs.writeFile(path.join(f.root, 'a.txt'), 'new user edit');
  assert.deepEqual(await f.port.execute(prepared, ctx, permission), result);
  assert.equal(f.events.length, 4); assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'new user edit');
});

test('the absence of a durable recorder or valid approval prevents every grouped write', async t => {
  const f = await fixture(t, { withoutRecorder: true }), ctx = context();
  const prepared = await f.port.prepare(call('no-recorder', pair()), ctx);
  assert.equal((await f.port.execute(prepared, ctx, approve(prepared, ctx))).status, 'not_executed');
  assert.deepEqual(await contents(f.root), ['a before\n', 'b before\n']);
  const g = await fixture(t), missing = await g.port.prepare(call('no-approval', pair()), ctx);
  assert.equal((await g.port.execute(missing, ctx)).status, 'not_executed');
  for (const [index, mutate] of [permission => { permission.decision = 'denied'; }, permission => { permission.expiresAt = Date.now() - 1; },
    permission => { permission.binding.workerGeneration++; }, permission => { permission.binding.inputDigest = 'other'; }].entries()) {
    const item = await g.port.prepare(call(`invalid-${index}`, pair()), ctx), permission = approve(item, ctx); mutate(permission);
    assert.equal((await g.port.execute(item, ctx, permission)).status, 'not_executed');
  }
  assert.equal(g.events.length, 0); assert.deepEqual(await contents(g.root), ['a before\n', 'b before\n']);
});

test('grouped tool input, complete preview, policy, identity and output bound cannot be substituted after preparation', async t => {
  const f = await fixture(t), ctx = context(), prepared = await f.port.prepare(call('bound', pair()), ctx), approval = approve(prepared, ctx);
  for (const change of [value => { value.input.changes[0].content = 'other'; }, value => { value.preconditions.changeSet.files[0].diff = 'hidden replacement'; },
    value => { value.preconditions.changeSet.digest = '0'.repeat(64); }, value => { value.preconditions.changeSet.files.reverse(); }]) {
    const changed = structuredClone(prepared); change(changed);
    await assert.rejects(f.port.execute(changed, ctx, approval), /changed/);
  }
  await assert.rejects(f.port.execute(prepared, { ...ctx, policyRevision: 'new-policy' }, approval), /changed/);
  await assert.rejects(f.port.execute(prepared, { ...ctx, identity: { ...identity, workerGeneration: 2 } }, approval), /changed/);
  await assert.rejects(f.port.execute(prepared, { ...ctx, maxOutputBytes: 1024 }, approval), /budget/);
  assert.equal(f.events.length, 0); assert.deepEqual(await contents(f.root), ['a before\n', 'b before\n']);
});

test('all file versions are preflighted before the first group effect', async t => {
  const f = await fixture(t), ctx = context(), prepared = await f.port.prepare(call('conflict', pair()), ctx);
  await fs.writeFile(path.join(f.root, 'b.txt'), 'external changed second file');
  await assert.rejects(f.port.validate(prepared, ctx), /changed|conflict/i);
  assert.equal((await f.port.execute(prepared, ctx, approve(prepared, ctx))).status, 'not_executed');
  assert.equal(f.events.length, 0); assert.deepEqual(await contents(f.root), ['a before\n', 'external changed second file']);
});

test('every affected directory must have its AGENTS and CLAUDE instructions shown before a group can be approved', async t => {
  const f = await fixture(t), ctx = context();
  for (const directory of ['left', 'right']) await fs.mkdir(path.join(f.root, directory));
  await fs.writeFile(path.join(f.root, 'left', 'AGENTS.md'), 'Left scope rule.');
  await fs.writeFile(path.join(f.root, 'right', 'CLAUDE.md'), 'Right scope rule.');
  const changes = [{ path: 'left/new.txt', content: 'left', expectedHash: null }, { path: 'right/new.txt', content: 'right', expectedHash: null }];
  await assert.rejects(f.port.prepare(call('unseen', changes), ctx), /not been shown/);
  await readScope(f.port, ctx, 'read-left', 'left');
  await assert.rejects(f.port.prepare(call('right-unseen', changes), ctx), /not been shown/);
  await readScope(f.port, ctx, 'read-right', 'right');
  const prepared = await f.port.prepare(call('all-seen', changes), ctx);
  assert.deepEqual(prepared.preconditions.changeSetScopes.map(scope => scope.path), ['left/new.txt', 'right/new.txt']);
  assert.deepEqual(prepared.preconditions.instructions.map(item => item.path).sort(), ['left/AGENTS.md', 'right/CLAUDE.md']);
  await fs.writeFile(path.join(f.root, 'right', 'CLAUDE.md'), 'Changed right scope.');
  assert.equal((await f.port.execute(prepared, ctx, approve(prepared, ctx))).status, 'not_executed');
  await assert.rejects(fs.stat(path.join(f.root, 'left', 'new.txt')), { code: 'ENOENT' });
  assert.equal(f.events.length, 0);
});

test('selected Skill changes invalidate the entire group and cannot be edited inside it', async t => {
  const f = await fixture(t), ctx = context(), skill = 'guides/review/SKILL.md';
  await fs.mkdir(path.dirname(path.join(f.root, skill)), { recursive: true }); await fs.writeFile(path.join(f.root, skill), 'Original chosen review rules.');
  const initialInstructions = await loadProjectInstructions({ projectRoot: f.root, projectSkills: [skill] });
  const port = new LocalToolPort({ ...f.config, projectSkills: [skill], initialInstructions });
  await assert.rejects(port.prepare(call('edit-selected-skill', [{ path: skill, content: 'changed', expectedHash: contentHash('Original chosen review rules.') }]), ctx), /protected|instruction|skill/i);
  const prepared = await port.prepare(call('selected-skill', pair()), ctx);
  await fs.writeFile(path.join(f.root, skill), 'Changed chosen rules.');
  assert.equal((await port.execute(prepared, ctx, approve(prepared, ctx))).status, 'not_executed');
  assert.deepEqual(await contents(f.root), ['a before\n', 'b before\n']); assert.equal(f.events.length, 0);
});

test('group schemas reject sensitive targets, credentials, aliases, rule files and oversized previews before approval', async t => {
  const secret = 'sk-change-set-private-credential';
  const f = await fixture(t, { forbiddenValues: [secret] }), ctx = context();
  const invalid = [[], Array.from({ length: 17 }, (_, index) => ({ path: `${index}.txt`, content: 'new', expectedHash: null })),
    [{ ...pair()[0], executable: 'sh' }], [{ ...pair()[0], expectedHash: 'short' }], [{ ...pair()[0], content: secret }],
    [pair()[0], pair()[0]], [pair()[0], { ...pair()[1], path: 'A.TXT' }],
    [{ path: '../outside', content: 'new', expectedHash: null }], [{ path: '.git/config', content: 'new', expectedHash: null }],
    [{ path: 'absent.txt', content: 'new', expectedHash: '0'.repeat(64) }, { path: '.env', content: 'private', expectedHash: null }],
    [{ path: 'CLAUDE.md', content: 'change instructions', expectedHash: null }], [{ path: 'nested/AGENTS.md', content: 'change instructions', expectedHash: null }],
  ];
  for (const [index, changes] of invalid.entries()) await assert.rejects(f.port.prepare(call(`invalid-${index}`, changes), ctx));
  const unavailable = new LocalToolPort({ ...f.config, projectRoot: path.join(f.root, 'missing-project') });
  await assert.rejects(unavailable.prepare(call('static-before-project-io', [pair()[0], { path: 'CLAUDE.md', content: 'rewrite rules', expectedHash: null }]), ctx), /instructions|Skills/i,
    'the entire invalid group must be rejected before even reading an unavailable project instruction scope');
  await fs.writeFile(path.join(f.root, 'old-secret.txt'), `unchanged credential ${secret}\nold`);
  await assert.rejects(f.port.prepare(call('hidden-old-credential', [{ path: 'old-secret.txt', content: `unchanged credential removed\nnew`, expectedHash: contentHash(`unchanged credential ${secret}\nold`) }]), ctx), /credential|protected/i);
  await fs.writeFile(path.join(f.root, 'large.txt'), 'before\n'.repeat(25000));
  await assert.rejects(f.port.prepare(call('large-preview', [{ path: 'large.txt', content: 'after\n'.repeat(25000), expectedHash: contentHash('before\n'.repeat(25000)) }]), ctx), /preview|limit|split/i);
  await assert.rejects(f.port.prepare(call('small-output-budget', pair()), { ...ctx, maxOutputBytes: 1024 }), /budget/);
  assert.equal(f.events.length, 0); assert.deepEqual(await contents(f.root), ['a before\n', 'b before\n']);
  assert.equal(LOCAL_TOOL_DEFINITIONS.find(item => item.name === 'apply_change_set').inputSchema.additionalProperties, false);
});

for (const boundary of ['external_file', 'cancel', 'instructions', 'ownership', 'approval_expired']) test(`after the first file, ${boundary} stops remaining changes and reports an explicit partial result`, async t => {
  const abort = new AbortController(), ctx = context({ signal: abort.signal }); let owned = true, permission;
  const f = await fixture(t, { assertOwnership() { if (!owned) throw new Error('Lease lost.'); }, onRecord: async (event, { root }) => {
    if (event.index !== 0 || event.status !== 'applied') return;
    if (boundary === 'external_file') await fs.writeFile(path.join(root, 'b.txt'), 'external second file');
    if (boundary === 'cancel') abort.abort(new Error('User cancelled after the first file.'));
    if (boundary === 'instructions') await fs.writeFile(path.join(root, 'CLAUDE.md'), 'A new rule interrupts the group.');
    if (boundary === 'ownership') owned = false;
    if (boundary === 'approval_expired') permission.expiresAt = Date.now() - 1;
  } });
  const prepared = await f.port.prepare(call('partial', pair()), ctx); permission = approve(prepared, ctx);
  const result = await f.port.execute(prepared, ctx, permission);
  assert.equal(result.status, 'failed'); assert.equal(result.output.status, 'partial'); assert.equal(result.output.receiptCommitted, true);
  assert.deepEqual(result.output.files.map(file => file.status), ['applied', 'not_applied']);
  assert.deepEqual(await contents(f.root), ['a after\n', boundary === 'external_file' ? 'external second file' : 'b before\n']);
  assert.deepEqual(f.events.map(item => [item.event.index, item.event.status]), [[0, 'prepared'], [0, 'applied'], [1, 'not_applied']]);
  const count = f.events.length;
  assert.deepEqual(await f.port.execute(prepared, ctx, permission), result); assert.equal(f.events.length, count);
});

for (const stage of ['prepared', 'applied']) test(`a failed durable ${stage} receipt yields unknown and never replays any file`, async t => {
  let attempts = 0;
  const f = await fixture(t, { onRecord: async event => { if (event.index === 0 && event.status === stage) { attempts++; throw new Error('durable write outcome uncertain'); } } }), ctx = context();
  const prepared = await f.port.prepare(call('lost-receipt', pair()), ctx), approval = approve(prepared, ctx);
  const result = await f.port.execute(prepared, ctx, approval);
  assert.equal(result.status, 'unknown'); assert.equal(result.output.status, 'unknown'); assert.equal(result.output.receiptCommitted, false);
  assert.equal(attempts, 1); assert.equal(await fs.readFile(path.join(f.root, 'b.txt'), 'utf8'), 'b before\n');
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), stage === 'prepared' ? 'a before\n' : 'a after\n');
  const count = f.events.length; assert.deepEqual(await f.port.execute(prepared, ctx, approval), result); assert.equal(f.events.length, count);
});

test('an ownership or cancellation change after a durable preparation still prevents that file write', async t => {
  const abort = new AbortController(), ctx = context({ signal: abort.signal });
  const f = await fixture(t, { onRecord: async event => { if (event.index === 0 && event.status === 'prepared') abort.abort(new Error('Cancelled before effect')); } });
  const prepared = await f.port.prepare(call('prepared-then-cancelled', pair()), ctx);
  const result = await f.port.execute(prepared, ctx, approve(prepared, ctx));
  assert.equal(result.status, 'not_executed'); assert.equal(result.output.status, 'not_applied');
  assert.deepEqual(result.output.files.map(file => file.status), ['not_applied', 'not_applied']);
  assert.deepEqual(await contents(f.root), ['a before\n', 'b before\n']);
  assert.ok(f.events.some(item => item.event.status === 'prepared'));
  assert.ok(f.events.filter(item => item.event.status === 'not_applied').length === 2, 'outcome receipts are allowed after cancellation');
});
