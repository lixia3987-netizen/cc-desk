import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LocalToolPort } from '../dist/tools/local-tools.js';
import { ProcessSupervisor } from '../dist/process-supervisor.js';
import { contentHash } from '../dist/tools/project-files.js';
import { loadProjectInstructions } from '../dist/project-instructions.js';

const identity = { sessionId: 's', conversationId: 'c', runId: 'r', requestId: 'request', workerGeneration: 1 };
const context = () => ({ identity: { ...identity }, policyRevision: 'policy-1', signal: new AbortController().signal, maxOutputBytes: 32768 });
const call = (id, name, input) => ({ id, name, arguments: JSON.stringify(input) });
const approve = (prepared, ctx) => ({ decision: 'approved', expiresAt: Date.now() + 60000, binding: { ...ctx.identity, toolCallId: prepared.call.id, inputDigest: prepared.inputDigest, policyRevision: ctx.policyRevision } });
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-tools-'));
  const supervisor = new ProcessSupervisor();
  t.after(async () => { await supervisor.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, supervisor, port: new LocalToolPort({ projectRoot: root, supervisor, ownerId: 'owner', ...options }) };
}
async function executeRead(port, ctx, id, name, input) { return port.execute(await port.prepare(call(id, name, input), ctx), ctx); }

test('ranged read keeps full-content hash and rejects approval-time changes outside the range', async t => {
  const { root, port } = await fixture(t);
  await fs.writeFile(path.join(root, 'file'), 'first\nsecond\nthird');
  const ctx = context();
  const read = await executeRead(port, ctx, 'read', 'read_file', { path: 'file', startLine: 1, endLine: 1 });
  assert.equal(read.output.content, 'first');
  assert.equal(read.output.hash, contentHash('first\nsecond\nthird'));
  const update = await port.prepare(call('write', 'apply_patch', { path: 'file', content: 'replacement', expectedHash: read.output.hash }), ctx);
  assert.equal(update.requiresApproval, true);
  await fs.writeFile(path.join(root, 'file'), 'first\nchanged\nthird');
  await assert.rejects(port.execute(update, ctx, approve(update, ctx)), /changed|conflict/i);
  assert.equal(await fs.readFile(path.join(root, 'file'), 'utf8'), 'first\nchanged\nthird');
});
test('write and sensitive read require exact unexpired approvals; changed inputs and owners are refused', async t => {
  const { root, port } = await fixture(t);
  const ctx = context();
  await fs.writeFile(path.join(root, '.env.local'), 'TOKEN=private');
  const sensitive = await port.prepare(call('sensitive', 'read_file', { path: '.env.local' }), ctx);
  assert.equal(sensitive.requiresApproval, true);
  await assert.rejects(port.execute(sensitive, ctx), /approval/);
  const wrongOwner = approve(sensitive, ctx);
  wrongOwner.binding.workerGeneration = 2;
  await assert.rejects(port.execute(sensitive, ctx, wrongOwner), /approval/);
  const expired = approve(sensitive, ctx);
  expired.expiresAt = Date.now() - 1;
  await assert.rejects(port.execute(sensitive, ctx, expired), /approval/);
  const edited = structuredClone(sensitive);
  edited.input.path = 'another-file';
  await assert.rejects(port.execute(edited, ctx, approve(sensitive, ctx)), /changed/);
  const result = await port.execute(sensitive, ctx, approve(sensitive, ctx));
  assert.equal(result.output.content, 'TOKEN=private');
  const create = await port.prepare(call('create', 'apply_patch', { path: 'created', content: 'yes', expectedHash: null }), ctx);
  await assert.rejects(port.execute(create, ctx), /approval/);
  assert.equal((await port.execute(create, ctx, approve(create, ctx))).status, 'completed');
  await fs.writeFile(path.join(root, 'created'), 'external');
  assert.equal((await port.execute(create, ctx, approve(create, ctx))).status, 'completed');
  assert.equal(await fs.readFile(path.join(root, 'created'), 'utf8'), 'external');
  await assert.rejects(port.prepare(call('create', 'apply_patch', { path: 'created', content: 'other', expectedHash: null }), ctx), /reused/);
});
for (const filename of ['AGENTS.md', 'CLAUDE.md']) test(`${filename} must reach the model before a write and changes invalidate approval`, async t => {
  const { root, supervisor } = await fixture(t);
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, filename), 'Root rule.');
  await fs.writeFile(path.join(root, 'src', filename), 'Nested rule.');
  await fs.writeFile(path.join(root, 'src', 'file'), 'old');
  const initialInstructions = await loadProjectInstructions({ projectRoot: root });
  const port = new LocalToolPort({ projectRoot: root, supervisor, ownerId: 'nested', initialInstructions });
  const ctx = context();
  await assert.rejects(port.prepare(call('unseen', 'apply_patch', { path: 'src/file', content: 'new', expectedHash: contentHash('old') }), ctx), /not been shown/);
  const read = await executeRead(port, ctx, 'read', 'read_file', { path: 'src/file' });
  assert.match(read.output.instructions.text, /Nested rule\./);
  assert.doesNotMatch(read.output.instructions.text, /Root rule\./);
  assert.ok(read.output.instructions.sources.every(source => !Object.hasOwn(source, 'content')));
  const prepared = await port.prepare(call('write', 'apply_patch', { path: 'src/file', content: 'new', expectedHash: read.output.hash }), ctx);
  await fs.writeFile(path.join(root, 'src', filename), 'Changed rule.');
  await assert.rejects(port.execute(prepared, ctx, approve(prepared, ctx)), /instructions changed/);
  assert.equal(await fs.readFile(path.join(root, 'src', 'file'), 'utf8'), 'old');
});
test('literal search/list skip sensitive and protected paths, enforce output/count limits and never run query syntax', async t => {
  const { root, port } = await fixture(t);
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, '.git', 'config'), 'needle secret');
  await fs.writeFile(path.join(root, '.env'), 'needle secret');
  await fs.writeFile(path.join(root, 'src', 'file'), 'needle normal\nneedle more');
  await fs.writeFile(path.join(root, 'syntax'), '$(touch hacked) --all');
  const ctx = context();
  const found = await executeRead(port, ctx, 'search', 'search', { path: '.', query: 'needle' });
  assert.deepEqual(found.output.matches.map(match => match.path), ['src/file', 'src/file']);
  const literal = await executeRead(port, ctx, 'literal', 'search', { path: '.', query: '$(touch hacked)' });
  assert.equal(literal.output.matches[0].path, 'syntax');
  await assert.rejects(fs.stat(path.join(root, 'hacked')), /ENOENT/);
  const listed = await executeRead(port, ctx, 'list', 'list_directory', { path: '.', maxEntries: 1 });
  assert.equal(listed.output.entries.length, 1);
  assert.equal(listed.truncated, true);
  const shallow = await executeRead(port, ctx, 'shallow', 'list_directory', { path: '.', depth: 0 });
  assert.equal(shallow.output.entries.some(entry => entry.path === 'src/file'), false);
  assert.equal(shallow.output.entries.some(entry => /\.git|\.env/.test(entry.path)), false);
  const smallContext = { ...ctx, maxOutputBytes: 512 };
  await assert.rejects(port.prepare(call('tiny', 'read_file', { path: 'src/file' }), smallContext), /budget/);
});
test('command uses approved literal argv/cwd and ownership is rechecked immediately before execution', async t => {
  let owned = true;
  const { root, port } = await fixture(t, { assertOwnership() { if (!owned) throw new Error('Lease lost.'); } });
  const ctx = context();
  const prepared = await port.prepare(call('command', 'run_command', { executable: process.execPath, argv: ['-e', 'process.stdout.write(JSON.stringify({cwd:process.cwd(),arg:process.argv[1],secret:process.env.OPENAI_API_KEY}))', 'literal ; echo unsafe'], cwd: '.' }), ctx);
  await assert.rejects(port.execute(prepared, ctx), /approval/);
  owned = false;
  await assert.rejects(port.execute(prepared, ctx, approve(prepared, ctx)), /Lease lost/);
  owned = true;
  const result = await port.execute(prepared, ctx, approve(prepared, ctx));
  assert.equal(result.status, 'completed');
  assert.deepEqual(JSON.parse(result.output.stdout), { cwd: await fs.realpath(root), arg: 'literal ; echo unsafe' });
  assert.equal(result.effects.cleanup, 'released');
});
test('schema rejects unknown fields and pre-aborted tools never run', async t => {
  const { port } = await fixture(t);
  const ctx = context();
  await assert.rejects(port.prepare(call('bad', 'run_command', { executable: process.execPath, argv: [], cwd: '.', env: { OPENAI_API_KEY: 'x' } }), ctx), /unexpected/);
  const controller = new AbortController(); controller.abort(new Error('Cancelled before prepare'));
  await assert.rejects(port.prepare(call('aborted', 'list_directory', { path: '.' }), { ...ctx, signal: controller.signal }), /Cancelled/);
});
for (const mutation of ['add', 'change', 'remove']) test(`CLAUDE ${mutation} invalidates approved commands with unchanged AGENTS rules`, async t => {
  const { root, supervisor } = await fixture(t);
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'Root rule.');
  const claudePath = path.join(root, 'src', 'CLAUDE.md');
  if (mutation !== 'add') await fs.writeFile(claudePath, 'Nested Claude rule.');
  const initialInstructions = await loadProjectInstructions({ projectRoot: root });
  const port = new LocalToolPort({ projectRoot: root, supervisor, ownerId: `claude-${mutation}`, initialInstructions });
  const ctx = context();
  const input = { executable: process.execPath, argv: ['-e', 'require("node:fs").writeFileSync("command-ran", "unexpected")'], cwd: 'src' };
  if (mutation !== 'add') {
    await assert.rejects(port.prepare(call('unseen-command', 'run_command', input), ctx), /not been shown/);
  }
  const read = await executeRead(port, ctx, 'scope', 'list_directory', { path: 'src' });
  assert.deepEqual(read.output.instructions.sources.map(source => source.path), mutation === 'add' ? ['AGENTS.md'] : ['AGENTS.md', 'src/CLAUDE.md']);
  const prepared = await port.prepare(call('command', 'run_command', input), ctx);
  if (mutation === 'remove') await fs.rm(claudePath);
  else await fs.writeFile(claudePath, 'Updated nested Claude rule.');
  await assert.rejects(port.execute(prepared, ctx, approve(prepared, ctx)), /instructions changed/);
  await assert.rejects(fs.stat(path.join(root, 'src', 'command-ran')), /ENOENT/);
});

test('selected project skills must reach the model before tools write and initial context marks them seen', async t => {
  const { root, supervisor } = await fixture(t);
  const skill = '.agents/skills/review/SKILL.md';
  await fs.mkdir(path.dirname(path.join(root, skill)), { recursive: true });
  await fs.writeFile(path.join(root, skill), 'Review changes before writing.');
  const ctx = context();
  const input = { path: 'created', content: 'approved', expectedHash: null };
  const unseen = new LocalToolPort({ projectRoot: root, supervisor, ownerId: 'unseen-skill', projectSkills: [skill] });
  await assert.rejects(unseen.prepare(call('unseen-write', 'apply_patch', input), ctx), /not been shown/);
  const read = await executeRead(unseen, ctx, 'read-skill', 'list_directory', { path: '.' });
  assert.deepEqual(read.output.instructions.sources.map(source => source.path), [skill]);
  assert.equal((await unseen.prepare(call('seen-write', 'apply_patch', input), ctx)).requiresApproval, true);
  const initialInstructions = await loadProjectInstructions({ projectRoot: root, projectSkills: [skill] });
  const initialized = new LocalToolPort({ projectRoot: root, supervisor, ownerId: 'initial-skill', projectSkills: [skill], initialInstructions });
  const prepared = await initialized.prepare(call('initial-write', 'apply_patch', input), ctx);
  assert.equal((await initialized.execute(prepared, ctx, approve(prepared, ctx))).status, 'completed');
  assert.equal(await fs.readFile(path.join(root, 'created'), 'utf8'), 'approved');
});

for (const mutation of ['change', 'remove', 'linked-directory']) test(`selected skill ${mutation} invalidates approved commands without changing AGENTS or CLAUDE`, async t => {
  const { root, supervisor } = await fixture(t);
  const skill = '.claude/skills/review/SKILL.md';
  await fs.mkdir(path.dirname(path.join(root, skill)), { recursive: true });
  await fs.writeFile(path.join(root, skill), 'Original skill.');
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'Unchanged agents.');
  await fs.writeFile(path.join(root, 'CLAUDE.md'), 'Unchanged Claude.');
  const initialInstructions = await loadProjectInstructions({ projectRoot: root, projectSkills: [skill] });
  const port = new LocalToolPort({ projectRoot: root, supervisor, ownerId: `skill-${mutation}`, projectSkills: [skill], initialInstructions });
  const ctx = context();
  const prepared = await port.prepare(call('command', 'run_command', { executable: process.execPath, argv: ['-e', 'require("node:fs").writeFileSync("command-ran", "unexpected")'], cwd: '.' }), ctx);
  if (mutation === 'change') await fs.writeFile(path.join(root, skill), 'Changed skill.');
  else if (mutation === 'remove') await fs.rm(path.join(root, skill));
  else {
    const moved = path.join(root, 'moved-skill');
    await fs.rename(path.dirname(path.join(root, skill)), moved);
    await fs.symlink(moved, path.dirname(path.join(root, skill)), process.platform === 'win32' ? 'junction' : 'dir');
  }
  await assert.rejects(port.execute(prepared, ctx, approve(prepared, ctx)), /instructions changed|missing|links are refused/);
  await assert.rejects(fs.stat(path.join(root, 'command-ran')), /ENOENT/);
});

test('selected skill mutation invalidates edit_file approval and preserves the target', async t => {
  const { root, supervisor } = await fixture(t);
  const skill = '.agents/skills/review/SKILL.md';
  await fs.mkdir(path.dirname(path.join(root, skill)), { recursive: true });
  await fs.writeFile(path.join(root, skill), 'Original edit guide.');
  await fs.writeFile(path.join(root, 'file'), 'before');
  const initialInstructions = await loadProjectInstructions({ projectRoot: root, projectSkills: [skill] });
  const port = new LocalToolPort({ projectRoot: root, supervisor, ownerId: 'skill-edit', projectSkills: [skill], initialInstructions });
  const ctx = context();
  const prepared = await port.prepare(call('edit', 'edit_file', { path: 'file', oldText: 'before', newText: 'after', expectedHash: contentHash('before') }), ctx);
  await fs.writeFile(path.join(root, skill), 'Changed edit guide.');
  await assert.rejects(port.execute(prepared, ctx, approve(prepared, ctx)), /instructions changed/);
  assert.equal(await fs.readFile(path.join(root, 'file'), 'utf8'), 'before');
});

test('a full 32KiB selected skill already supplied to the model does not exhaust read, list or search output', async t => {
  const { root, supervisor } = await fixture(t);
  const skill = '.agents/skills/review/SKILL.md';
  await fs.mkdir(path.dirname(path.join(root, skill)), { recursive: true });
  await fs.writeFile(path.join(root, skill), 'Skill sentinel.\n' + 'x'.repeat(32 * 1024 - 16));
  await fs.writeFile(path.join(root, 'file'), 'needle expected file.');
  const initialInstructions = await loadProjectInstructions({ projectRoot: root, projectSkills: [skill] });
  assert.equal(Buffer.byteLength(initialInstructions.sources[0].content), 32 * 1024);
  const port = new LocalToolPort({ projectRoot: root, supervisor, ownerId: 'large-known-skill', projectSkills: [skill], initialInstructions });
  const ctx = { ...context(), maxOutputBytes: 64 * 1024 };
  for (const [name, input] of [['read_file', { path: 'file' }], ['list_directory', { path: '.', depth: 0 }], ['search', { path: '.', query: 'needle' }]]) {
    const result = await executeRead(port, ctx, name, name, input);
    assert.equal(result.status, 'completed');
    assert.ok(Buffer.byteLength(JSON.stringify(result.output)) < ctx.maxOutputBytes);
    assert.equal(result.output.instructions.text, '');
    assert.deepEqual(result.output.instructions.sources, initialInstructions.sources.map(({ path, scope, hash }) => ({ path, scope, hash })));
    assert.doesNotMatch(JSON.stringify(result.output), /Skill sentinel/);
  }
});

for (const filename of ['AGENTS.md', 'CLAUDE.md']) test(`large known skills retain new ${filename} text once, and rejected reads never mark it seen`, async t => {
  const { root, supervisor } = await fixture(t);
  const skill = '.claude/skills/review/SKILL.md';
  await fs.mkdir(path.dirname(path.join(root, skill)), { recursive: true });
  await fs.writeFile(path.join(root, skill), 's'.repeat(32 * 1024));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'file'), 'original');
  const initialInstructions = await loadProjectInstructions({ projectRoot: root, projectSkills: [skill] });
  const port = new LocalToolPort({ projectRoot: root, supervisor, ownerId: `new-${filename}`, projectSkills: [skill], initialInstructions });
  const nestedRule = 'Nested convention sentinel.\n' + 'n'.repeat(32 * 1024 - 28);
  await fs.writeFile(path.join(root, 'src', filename), nestedRule);
  const ctx = { ...context(), maxOutputBytes: 64 * 1024 };
  const write = { path: 'src/file', oldText: 'original', newText: 'updated', expectedHash: contentHash('original') };
  await assert.rejects(port.prepare(call('unseen-edit', 'edit_file', write), ctx), /not been shown/);
  await assert.rejects(port.prepare(call('too-small-read', 'read_file', { path: 'src/file' }), { ...ctx, maxOutputBytes: 2048 }), /budget/);
  await assert.rejects(port.prepare(call('still-unseen-edit', 'edit_file', write), ctx), /not been shown/);
  const result = await executeRead(port, ctx, 'scope-read', 'read_file', { path: 'src/file' });
  assert.equal(result.status, 'completed');
  assert.equal(result.output.content, 'original');
  assert.equal(result.output.instructions.text.split('Nested convention sentinel.').length - 1, 1);
  assert.match(result.output.instructions.text, /deeper.*override/);
  assert.doesNotMatch(result.output.instructions.text, /s{100}/);
  const prepared = await port.prepare(call('seen-edit', 'edit_file', write), ctx);
  assert.equal(prepared.requiresApproval, true);
  const repeated = await executeRead(port, ctx, 'repeat-read', 'read_file', { path: 'src/file' });
  assert.equal(repeated.output.instructions.text, '');
  await fs.writeFile(path.join(root, skill), 'Changed selected skill.');
  await assert.rejects(port.execute(prepared, ctx, approve(prepared, ctx)), /instructions changed/);
  assert.equal(await fs.readFile(path.join(root, 'src', 'file'), 'utf8'), 'original');
});
test('edit_file approval binds the exact displayed fragment replacement and cannot be reused for another edit', async t => {
  const { root, port } = await fixture(t);
  const ctx = context();
  await fs.writeFile(path.join(root, 'file'), 'before\nuntouched');
  const read = await executeRead(port, ctx, 'read', 'read_file', { path: 'file', startLine: 1, endLine: 1 });
  const input = { path: 'file', oldText: 'before', newText: 'after', expectedHash: read.output.hash };
  const prepared = await port.prepare(call('edit', 'edit_file', input), ctx);
  assert.deepEqual(prepared.input, input, 'approval shows the exact original edit, not a rewritten full-file replacement');
  assert.equal(prepared.preconditions.expectedHash, read.output.hash);
  assert.equal(prepared.requiresApproval, true);
  assert.equal(prepared.definition.risk, 'write');
  await assert.rejects(port.execute(prepared, ctx), /approval/);
  const changed = structuredClone(prepared); changed.input.newText = 'unapproved';
  await assert.rejects(port.execute(changed, ctx, approve(prepared, ctx)), /changed/);
  const result = await port.execute(prepared, ctx, approve(prepared, ctx));
  assert.equal(result.status, 'completed');
  assert.equal(result.output.hash, contentHash('after\nuntouched'));
  assert.equal(result.effects.previousHash, read.output.hash);
  assert.equal(await fs.readFile(path.join(root, 'file'), 'utf8'), 'after\nuntouched');
  const second = await port.prepare(call('edit2', 'edit_file', { ...input, oldText: 'after', newText: 'again', expectedHash: result.output.hash }), ctx);
  await assert.rejects(port.execute(second, ctx, approve(prepared, ctx)), /approval/);
  assert.equal((await port.execute(second, ctx, approve(second, ctx))).status, 'completed');
  assert.equal(await fs.readFile(path.join(root, 'file'), 'utf8'), 'again\nuntouched');
  // Retries report the original durable result without applying the text twice.
  assert.deepEqual(await port.execute(prepared, ctx, approve(prepared, ctx)), result);
  assert.equal(await fs.readFile(path.join(root, 'file'), 'utf8'), 'again\nuntouched');
});
test('edit_file rejects approval-time changes outside the matched fragment and cancellation before execute', async t => {
  const { root, port } = await fixture(t);
  const ctx = context();
  await fs.writeFile(path.join(root, 'file'), 'before\nuntouched');
  const input = { path: 'file', oldText: 'before', newText: 'after', expectedHash: contentHash('before\nuntouched') };
  const prepared = await port.prepare(call('edit', 'edit_file', input), ctx);
  await fs.writeFile(path.join(root, 'file'), 'before\nexternal');
  await assert.rejects(port.execute(prepared, ctx, approve(prepared, ctx)), /changed|conflict/);
  assert.equal(await fs.readFile(path.join(root, 'file'), 'utf8'), 'before\nexternal');
  const controller = new AbortController();
  const cancelContext = { ...ctx, signal: controller.signal };
  const cancelled = await port.prepare(call('cancel-edit', 'edit_file', { ...input, expectedHash: contentHash('before\nexternal') }), cancelContext);
  controller.abort(new Error('Cancelled while awaiting approval'));
  await assert.rejects(port.execute(cancelled, cancelContext, approve(cancelled, cancelContext)), /Cancelled/);
  assert.equal(await fs.readFile(path.join(root, 'file'), 'utf8'), 'before\nexternal');
  assert.deepEqual(await fs.readdir(root), ['file']);
});
for (const filename of ['AGENTS.md', 'CLAUDE.md']) test(`${filename} must reach the model before edit_file and changes invalidate approval`, async t => {
  const { root, port } = await fixture(t);
  const ctx = context();
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, filename), 'Root rule.');
  await fs.writeFile(path.join(root, 'src', filename), 'Nested rule.');
  await fs.writeFile(path.join(root, 'src', 'file'), 'before');
  const input = { path: 'src/file', oldText: 'before', newText: 'after', expectedHash: contentHash('before') };
  await assert.rejects(port.prepare(call('unseen-edit', 'edit_file', input), ctx), /not been shown/);
  const read = await executeRead(port, ctx, 'read', 'read_file', { path: input.path });
  assert.match(read.output.instructions.text, /Root rule\./);
  assert.match(read.output.instructions.text, /Nested rule\./);
  assert.ok(read.output.instructions.sources.every(source => !Object.hasOwn(source, 'content')));
  const prepared = await port.prepare(call('edit', 'edit_file', input), ctx);
  await fs.writeFile(path.join(root, 'src', filename), 'Changed rule.');
  await assert.rejects(port.execute(prepared, ctx, approve(prepared, ctx)), /instructions changed/);
  assert.equal(await fs.readFile(path.join(root, 'src', 'file'), 'utf8'), 'before');
});
test('edit_file refuses unsupported options, ambiguous matches and invalid text before requesting approval', async t => {
  const { root, port } = await fixture(t);
  const ctx = context();
  await fs.writeFile(path.join(root, 'file'), 'repeat repeat');
  const input = { path: 'file', oldText: 'repeat', newText: 'after', expectedHash: contentHash('repeat repeat') };
  for (const extra of [{ replaceAll: true }, { edits: [] }, { content: 'whole file' }]) {
    await assert.rejects(port.prepare(call('bad', 'edit_file', { ...input, ...extra }), ctx), /unexpected/);
  }
  await assert.rejects(port.prepare(call('ambiguous', 'edit_file', input), ctx), /exactly once/);
  await assert.rejects(port.prepare(call('empty', 'edit_file', { ...input, oldText: '' }), ctx), /oldText/);
  await assert.rejects(port.prepare(call('encoding', 'edit_file', { ...input, newText: '\ud800' }), ctx), /UTF-8/);
  await assert.rejects(port.prepare(call('create', 'edit_file', { ...input, expectedHash: null }), ctx), /expectedHash/);
  assert.equal(await fs.readFile(path.join(root, 'file'), 'utf8'), 'repeat repeat');
});
