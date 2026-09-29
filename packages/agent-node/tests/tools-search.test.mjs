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
const call = (id, name, input) => ({ id, name, arguments: JSON.stringify(input) });
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-search-tools-'));
  const supervisor = new ProcessSupervisor();
  t.after(async () => { await supervisor.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, supervisor, port: new LocalToolPort({ projectRoot: root, supervisor, ownerId: 'search-owner', ...options }) };
}
async function read(port, ctx, id, name, input) { const prepared = await port.prepare(call(id, name, input), ctx); return port.execute(prepared, ctx); }
async function files(root, entries) {
  for (const [name, contents] of Object.entries(entries)) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), contents); }
}

test('search retains literal invocation/output compatibility and adds complete file hashes and positions', async t => {
  const { root, port } = await fixture(t), ctx = context();
  const contents = 'a needle line\nneedle again\n$(touch SHOULD_NOT_EXIST)';
  await files(root, { 'file.txt': contents });
  const result = await read(port, ctx, 'old-search', 'search', { path: '.', query: 'needle', maxMatches: 2 });
  assert.equal(result.status, 'completed'); assert.equal(result.output.path, '.'); assert.equal(result.output.matches.length, 2);
  assert.deepEqual(result.output.matches.map(item => item.line), [1, 2]);
  assert.equal(result.output.matches[0].column, 3); assert.equal(result.output.matches[0].hash, contentHash(contents));
  assert.equal(result.output.matches[0].hashStatus, 'complete');
  assert.equal(result.output.scannedBytes, Buffer.byteLength(contents));
  assert.equal(result.output.complete, true); assert.equal(result.output.scanComplete, true); assert.equal(result.output.nextCursor, null);
  assert.ok(result.output.matches[0].identity); assert.equal(result.output.truncated, result.truncated);
  const literal = await read(port, ctx, 'literal-shell', 'search', { path: '.', query: '$(touch SHOULD_NOT_EXIST)' });
  assert.equal(literal.output.matches.length, 1);
  await assert.rejects(fs.stat(path.join(root, 'SHOULD_NOT_EXIST')), { code: 'ENOENT' });
});

test('find_files is metadata-only for large/binary files and supports literal basename, restricted glob and directory exclusions', async t => {
  const { root, port } = await fixture(t, { maxFileBytes: 64 }), ctx = context();
  await files(root, { 'src/Feature.ts': 'a'.repeat(100), 'src/feature.bin': Buffer.from([0, 255]), 'src/other.ts': 'ordinary',
    'vendor/Feature.ts': 'skip custom directory', 'node_modules/Feature.ts': 'skip default directory', '.env': 'protected' });
  const found = await read(port, ctx, 'find', 'find_files', { path: '.', name: 'feature', caseSensitive: false, glob: '**/*', ignoreDirectories: ['vendor'] });
  assert.equal(found.status, 'completed'); assert.deepEqual(found.output.matches.map(item => item.path), ['src/Feature.ts', 'src/feature.bin']);
  assert.ok(found.output.matches.every(item => item.hash === null && item.hashStatus === 'not_read' && item.identity));
  assert.equal(found.output.scannedBytes, 0, 'filename discovery must not read content');
  assert.equal(found.output.complete, true);
  const typescript = await read(port, ctx, 'find-ts', 'find_files', { path: 'src', glob: '*.ts' });
  assert.deepEqual(typescript.output.matches.map(item => item.path), ['src/Feature.ts', 'src/other.ts']);
  await assert.rejects(port.prepare(call('null-is-not-an-edit-hash', 'apply_patch', { path: 'src/Feature.ts', content: 'replace', expectedHash: found.output.matches[0].hash }), ctx), /conflict|exists/i);
});

test('regex is explicit, case-insensitive when requested, and bounded to the first match on each line', async t => {
  const { root, port } = await fixture(t), ctx = context();
  await files(root, { 'src/a.ts': 'Cat 42 cat 33\ncat x\nCAT 7\n', 'src/a.js': 'cat 999' });
  const found = await read(port, ctx, 'regex', 'search', { path: '.', query: 'cat \\d+', mode: 'regex', caseSensitive: false, glob: '**/*.ts' });
  assert.equal(found.status, 'completed'); assert.deepEqual(found.output.matches.map(item => item.line), [1, 3]);
  assert.ok(found.output.matches.every(item => item.path === 'src/a.ts' && item.column === 1));
  const literal = await read(port, ctx, 'same-literal', 'search', { path: '.', query: 'cat \\d+' });
  assert.equal(literal.output.matches.length, 0); assert.equal(literal.output.complete, true);
});

test('paged search preserves a stable sequence and exactly-once receipts without granting write permissions', async t => {
  const { root, port } = await fixture(t), ctx = context();
  await files(root, { 'a.txt': 'needle a\nneedle b\nneedle c\n' });
  const input = { path: '.', query: 'needle', pageSize: 1 };
  const prepared = await port.prepare(call('first', 'search', input), ctx);
  assert.equal(prepared.requiresApproval, false); assert.equal(prepared.definition.risk, 'read');
  const [first, repeated] = await Promise.all([port.execute(prepared, ctx), port.execute(prepared, ctx)]);
  assert.deepEqual(first, repeated); assert.equal(first.output.matches.length, 1); assert.equal(first.output.complete, false);
  assert.equal(first.output.scanComplete, true); assert.equal(first.output.pageComplete, false); assert.ok(first.output.nextCursor);
  const second = await read(port, ctx, 'second', 'search', { ...input, cursor: first.output.nextCursor });
  const third = await read(port, ctx, 'third', 'search', { ...input, cursor: second.output.nextCursor });
  assert.deepEqual([...first.output.matches, ...second.output.matches, ...third.output.matches].map(item => item.line), [1, 2, 3]);
  assert.equal(third.output.complete, true); assert.equal(third.output.nextCursor, null);
  const edit = await port.prepare(call('edit', 'edit_file', { path: 'a.txt', oldText: 'needle a', newText: 'updated a', expectedHash: third.output.matches[0].hash }), ctx);
  assert.equal(edit.requiresApproval, true); await assert.rejects(port.execute(edit, ctx), /approval/);
  await fs.appendFile(path.join(root, 'a.txt'), 'external new line\n');
  assert.deepEqual(await port.execute(prepared, ctx), first, 'same call returns its original read receipt rather than rescanning');
});

for (const changed of ['query', 'policy', 'identity', 'file', 'directory', 'instructions']) test(`search cursor cannot silently resume after ${changed} changes`, async t => {
  const { root, port } = await fixture(t), ctx = context();
  await files(root, { 'AGENTS.md': 'Root rules.', 'a.txt': 'needle 1\nneedle 2' });
  const input = { path: '.', query: 'needle', pageSize: 1 };
  const first = await read(port, ctx, 'first', 'search', input);
  assert.ok(first.output.nextCursor);
  let nextInput = { ...input, cursor: first.output.nextCursor }, nextContext = ctx;
  if (changed === 'query') nextInput = { ...nextInput, query: 'other' };
  if (changed === 'policy') nextContext = { ...ctx, policyRevision: 'policy-2' };
  if (changed === 'identity') nextContext = { ...ctx, identity: { ...ctx.identity, runId: 'other-run', workerGeneration: 2 } };
  if (changed === 'file') await fs.writeFile(path.join(root, 'a.txt'), 'needle changed\nneedle 2');
  if (changed === 'directory') await fs.writeFile(path.join(root, 'added.txt'), 'needle newly created');
  if (changed === 'instructions') await fs.writeFile(path.join(root, 'AGENTS.md'), 'Changed root instructions.');
  let result;
  try { result = await read(port, nextContext, 'next', 'search', nextInput); }
  catch (error) { assert.match(String(error), /cursor|changed|scope|revision|identity|binding/i); return; }
  assert.equal(result.status, 'failed'); assert.match(JSON.stringify(result.output), /cursor|changed|scope|revision|identity|binding/i);
});

for (const filename of ['AGENTS.md', 'CLAUDE.md']) test(`searching nested matches never marks unshown ${filename} instructions as seen`, async t => {
  const { root, supervisor } = await fixture(t), ctx = context();
  await files(root, { 'AGENTS.md': 'Root instruction.', [`nested/${filename}`]: 'Nested instruction must be shown in full.', 'nested/file.txt': 'needle before' });
  const initialInstructions = await loadProjectInstructions({ projectRoot: root });
  const port = new LocalToolPort({ projectRoot: root, supervisor, ownerId: `deep-${filename}`, initialInstructions });
  const found = await read(port, ctx, 'root-search', 'search', { path: '.', query: 'needle' });
  assert.equal(found.output.matches[0].path, 'nested/file.txt');
  assert.doesNotMatch(found.output.instructions.text, /Nested instruction/);
  const edit = { path: 'nested/file.txt', oldText: 'before', newText: 'after', expectedHash: found.output.matches[0].hash };
  await assert.rejects(port.prepare(call('unseen-edit', 'edit_file', edit), ctx), /not been shown/);
  const named = await read(port, ctx, 'root-find', 'find_files', { path: '.', name: 'file.txt' });
  assert.equal(named.output.matches[0].hash, null);
  await assert.rejects(port.prepare(call('still-unseen', 'edit_file', edit), ctx), /not been shown/);
  const scope = await read(port, ctx, 'nested-search', 'search', { path: 'nested', query: 'needle' });
  assert.match(scope.output.instructions.text, /Nested instruction must be shown in full/);
  assert.equal((await port.prepare(call('seen-edit', 'edit_file', edit), ctx)).requiresApproval, true);
});

test('search schemas refuse unsupported syntax, unknown properties, spoofed cursors and credential queries', async t => {
  const secret = 'sk-search-secret-must-not-be-recorded';
  const { port } = await fixture(t, { forbiddenValues: [secret] }), ctx = context();
  const invalid = [
    ['search', { path: '.', query: 'x', maxMatches: 1, pageSize: 1 }],
    ['search', { path: '.', query: 'x', pageSize: 0 }], ['search', { path: '.', query: 'x', mode: 'files' }],
    ['search', { path: '.', query: 'x', regex: true }], ['search', { path: '.', query: '(' , mode: 'regex' }],
    ['search', { path: '.', query: 'x', glob: '../*' }], ['search', { path: '.', query: 'x', glob: '**/[a-z].ts' }],
    ['search', { path: '.', query: 'x', ignoreDirectories: ['../outside'] }], ['search', { path: '.', query: 'x', ignoreDirectories: 'vendor' }],
    ['search', { path: '.', query: 'x', caseSensitive: 1 }], ['search', { path: '.', query: secret }],
    ['find_files', { path: '.', name: '' }], ['find_files', { path: '.', name: secret }], ['find_files', { path: '.', query: 'content' }],
    ['find_files', { path: '/absolute', name: 'x' }], ['find_files', { path: '.', maxMatches: 1 }],
  ];
  for (const [index, [name, input]] of invalid.entries()) await assert.rejects(port.prepare(call(`bad-${index}`, name, input), ctx));
  const forged = await read(port, ctx, 'forged-cursor', 'search', { path: '.', query: 'x', cursor: 'unknown-cursor' });
  assert.equal(forged.status, 'failed');
  for (const name of ['search', 'find_files']) {
    const definition = LOCAL_TOOL_DEFINITIONS.find(item => item.name === name);
    assert.equal(definition.risk, 'read'); assert.equal(definition.inputSchema.additionalProperties, false);
  }
});

test('ownership, policy, cancellation and output budgets remain bound to a prepared search and its cached receipt', async t => {
  let owned = true;
  const { root, port } = await fixture(t, { assertOwnership() { if (!owned) throw new Error('Lease lost.'); } }), ctx = context();
  await files(root, { 'a.txt': 'needle once\nneedle twice' });
  const prepared = await port.prepare(call('bound', 'search', { path: '.', query: 'needle' }), ctx);
  const altered = structuredClone(prepared); altered.input.query = 'other';
  await assert.rejects(port.execute(altered, ctx), /changed/);
  await assert.rejects(port.execute(prepared, { ...ctx, policyRevision: 'other' }), /changed/);
  await assert.rejects(port.execute(prepared, { ...ctx, maxOutputBytes: 1024 }), /budget/);
  const first = await port.execute(prepared, ctx); assert.equal(first.status, 'completed');
  owned = false; await assert.rejects(port.execute(prepared, ctx), /Lease lost/);
  owned = true; const controller = new AbortController(); controller.abort(new Error('Cancelled'));
  await assert.rejects(port.execute(prepared, { ...ctx, signal: controller.signal }), /Cancelled/);
  await assert.rejects(port.prepare(call('too-small', 'find_files', { path: '.' }), { ...ctx, maxOutputBytes: 512 }), /budget/);
});

test('changed scope instructions during search suppress results and do not authorize an edit', async t => {
  let calls = 0, mutateAt = Infinity;
  const { root, supervisor } = await fixture(t), ctx = context();
  await files(root, { 'AGENTS.md': 'Initial rule.', 'file.txt': 'needle before' });
  const port = new LocalToolPort({ projectRoot: root, supervisor, ownerId: 'mid-read', assertOwnership: async () => {
    calls++; if (calls === mutateAt) await fs.writeFile(path.join(root, 'AGENTS.md'), 'Changed while searching.');
  } });
  const prepared = await port.prepare(call('changing', 'search', { path: '.', query: 'needle' }), ctx);
  // execute guard, validate guard, pre-execution guard, then result-delivery guard.
  mutateAt = calls + 4;
  const result = await port.execute(prepared, ctx);
  assert.equal(result.status, 'failed'); assert.match(JSON.stringify(result.output), /instructions changed/i);
  assert.equal(JSON.stringify(result.output).includes('needle before'), false);
  await assert.rejects(port.prepare(call('unseen-after-failure', 'edit_file', { path: 'file.txt', oldText: 'before', newText: 'after', expectedHash: contentHash('needle before') }), ctx), /not been shown/);
});

test('search output containing a protected credential is not returned or marked as delivered', async t => {
  const secret = 'sk-search-protected-output-token';
  const { root, port } = await fixture(t, { forbiddenValues: [secret] }), ctx = context();
  await files(root, { 'ordinary.txt': `needle ${secret}` });
  const result = await read(port, ctx, 'secret-output', 'search', { path: '.', query: 'needle' });
  assert.equal(result.status, 'failed'); assert.equal(JSON.stringify(result.output).includes(secret), false);
});

test('search output budgets retain completeness and continuation metadata instead of silently dropping matches', async t => {
  const { root, port } = await fixture(t), ctx = context({ maxOutputBytes: 4096 });
  await files(root, { 'long.txt': Array.from({ length: 30 }, (_, index) => `needle ${index} ` + 'x'.repeat(400)).join('\n') });
  const result = await read(port, ctx, 'bounded-output', 'search', { path: '.', query: 'needle', pageSize: 100 });
  assert.equal(result.status, 'completed'); assert.ok(Buffer.byteLength(JSON.stringify(result.output)) <= ctx.maxOutputBytes);
  assert.ok(result.output.matches.length > 0 && result.output.matches.length < 30);
  assert.equal(result.output.scanComplete, true); assert.equal(result.output.complete, false);
  assert.equal(result.output.truncated, true); assert.ok(result.output.nextCursor);
  assert.ok(result.output.truncationReasons.length > 0);
});

test('a cached search cannot cross a run change while its asynchronous ownership check settles', async t => {
  let replaceIdentity = false;
  const ctx = context();
  const { root, port } = await fixture(t, { assertOwnership: async () => {
    if (replaceIdentity) ctx.identity = { ...ctx.identity, runId: 'replacement-run' };
  } });
  await files(root, { 'a.txt': 'needle' });
  const prepared = await port.prepare(call('cached', 'search', { path: '.', query: 'needle' }), ctx);
  assert.equal((await port.execute(prepared, ctx)).status, 'completed');
  replaceIdentity = true;
  await assert.rejects(port.execute(prepared, ctx), /changed/);
});
