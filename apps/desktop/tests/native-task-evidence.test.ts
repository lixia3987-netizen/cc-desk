import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PreparedTool, ToolResult } from '@cc-desk/agent-core';
import type { NativeTaskSnapshot } from '@cc-desk/contracts/native-task';
import { captureTaskWorkspace, commandEvidenceReceipt, describeTaskChanges } from '../src/main/engines/native/task-evidence';

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-task-evidence-'));
  await fs.writeFile(path.join(directory, 'source.ts'), 'user pre-existing edits\n');
  return { directory, capture: (limits?: Parameters<typeof captureTaskWorkspace>[0]['limits']) => captureTaskWorkspace({ projectRoot: directory, limits }),
    dispose: () => fs.rm(directory, { recursive: true, force: true }) };
}
const prepared: PreparedTool = {
  call: { id: 'check-1', name: 'run_command', arguments: '{"executable":"node","argv":["--test"],"cwd":"."}' },
  definition: { name: 'run_command', risk: 'command', description: '', inputSchema: {} },
  input: { executable: 'node', argv: ['--test'], cwd: '.' }, inputDigest: 'a'.repeat(64),
  policyRevision: 'test', requiresApproval: true, preconditions: {},
};
const task: NativeTaskSnapshot = {
  schemaVersion: 1, taskId: 'task-1', identity: { sessionId: 'session', conversationId: 'conversation', runId: 'run', requestId: 'request', workerGeneration: 1 },
  goal: 'Implement feature', steps: [{ id: 'step', title: 'Implement', dependsOn: [], status: 'implemented' }],
  criteria: [{ id: 'criterion', description: 'Meaningful tests pass', stepIds: ['step'], kind: 'command' }],
  revision: 1, planRevision: 1, acceptanceRevision: 1, execution: 'active', verification: 'unverified', evidence: [], history: [], createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z',
};
function result(overrides: Record<string, unknown> = {}, status: ToolResult['status'] = 'completed'): ToolResult {
  return { status, output: { exitCode: 0, signal: null, stdout: 'PASS', stderr: '', outputBytes: 4, truncated: false, timedOut: false, cancelled: false, cleanup: 'released', ...overrides } as ToolResult['output'] };
}

test('workspace uses byte content including binary/untracked files, preserving pre-existing edits as baseline', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.directory, 'asset.bin'), Buffer.from([0, 255, 3]));
    const before = await f.capture(), equal = await f.capture();
    assert.equal(before.complete, true); assert.equal(before.files.length, 2);
    assert.equal(before.fingerprint, equal.fingerprint);
    assert.deepEqual(describeTaskChanges(before, equal), { complete: true, added: [], modified: [], removed: [], attribution: 'observed_since_task_start', truncated: false });
    assert.equal(JSON.stringify(before).includes('user pre-existing edits'), false, 'only file hashes are stored');
    await fs.writeFile(path.join(f.directory, 'source.ts'), 'external same HEAD edit\n');
    await fs.writeFile(path.join(f.directory, 'new.ts'), 'new');
    await fs.unlink(path.join(f.directory, 'asset.bin'));
    const after = await f.capture();
    assert.notEqual(after.fingerprint, before.fingerprint);
    assert.deepEqual(describeTaskChanges(before, after), { complete: true, added: ['new.ts'], modified: ['source.ts'], removed: ['asset.bin'], attribution: 'observed_since_task_start', truncated: false });
  } finally { await f.dispose(); }
});

test('workspace explicitly excludes generated, Git, sensitive and host-protected paths', async () => {
  const f = await fixture();
  try {
    for (const name of ['.git', 'node_modules', 'dist', 'host-data']) {
      await fs.mkdir(path.join(f.directory, name)); await fs.writeFile(path.join(f.directory, name, 'value'), 'private or generated');
    }
    await fs.writeFile(path.join(f.directory, '.env'), 'TOKEN=secret');
    const options = { projectRoot: f.directory, excludedRoots: [path.join(f.directory, 'host-data')] };
    const before = await captureTaskWorkspace(options);
    assert.equal(before.complete, true); assert.deepEqual(before.files.map(file => file.path), ['source.ts']);
    assert.ok(before.scope.includes('exclude-sensitive-paths'));
    assert.ok(before.scope.includes('exclude-directory:node_modules'));
    await fs.writeFile(path.join(f.directory, '.env'), 'TOKEN=other');
    await fs.writeFile(path.join(f.directory, 'dist', 'value'), 'changed generated');
    assert.equal((await captureTaskWorkspace(options)).fingerprint, before.fingerprint);
    assert.notEqual((await f.capture()).fingerprint, before.fingerprint, 'changing declared scope changes the fingerprint');
  } finally { await f.dispose(); }
});

test('bounded scans expose incomplete scope and never report missing entries as deleted', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.directory, 'other.ts'), '123456789');
    const complete = await f.capture();
    const entries = await f.capture({ maxEntries: 1 });
    assert.equal(entries.complete, false); assert.ok(entries.issues.includes('entry_limit'));
    assert.deepEqual(describeTaskChanges(complete, entries).removed, []);
    const bytes = await f.capture({ maxFileBytes: 2 });
    assert.equal(bytes.complete, false); assert.ok(bytes.issues.includes('file_byte_limit'));
    const total = await f.capture({ maxBytes: 10 });
    assert.equal(total.complete, false); assert.ok(total.issues.includes('total_byte_limit'));
  } finally { await f.dispose(); }
});

test('links never read outside the project and incomplete observations do not become complete', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture(); const external = await fs.mkdtemp(path.join(os.tmpdir(), 'native-task-outside-'));
  try {
    await fs.writeFile(path.join(external, 'outside'), 'never read this secret');
    await fs.symlink(path.join(external, 'outside'), path.join(f.directory, 'link'));
    const observed = await f.capture();
    assert.equal(observed.complete, false); assert.ok(observed.issues.includes('unsupported_link'));
    assert.deepEqual(observed.files.map(file => file.path), ['source.ts']);
    assert.equal(JSON.stringify(observed).includes('never read'), false);
  } finally { await f.dispose(); await fs.rm(external, { recursive: true, force: true }); }
});

test('workspace identity follows the actual directory and cancellation aborts the observation', async () => {
  const first = await fixture(), second = await fixture();
  try {
    const before = await first.capture(), after = await second.capture();
    assert.notEqual(before.rootFingerprint, after.rootFingerprint);
    assert.equal(describeTaskChanges(before, after).complete, false);
    const abort = new AbortController(); abort.abort(new Error('cancelled observation'));
    await assert.rejects(captureTaskWorkspace({ projectRoot: first.directory, signal: abort.signal }), /cancelled observation/);
    await assert.rejects(first.capture({ maxEntries: 0 }), /Invalid/);
    const absent = await captureTaskWorkspace({ projectRoot: path.join(first.directory, 'missing') });
    assert.equal(absent.complete, false);
  } finally { await first.dispose(); await second.dispose(); }
});

test('directory additions during a scan make the observation incomplete', async () => {
  const f = await fixture(); const open = fs.open; let injected = false;
  try {
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (!injected && path.basename(String(args[0])) === 'source.ts') {
        injected = true; await fs.writeFile(path.join(f.directory, 'arrived-during-scan.ts'), 'external');
      }
      return handle;
    }) as typeof fs.open;
    const observed = await f.capture();
    assert.equal(injected, true); assert.equal(observed.complete, false);
    assert.ok(observed.issues.includes('changed_during_scan'));
  } finally { fs.open = open; await f.dispose(); }
});

test('change summaries have one total bound and include mode-only changes', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const before = await f.capture();
    await fs.chmod(path.join(f.directory, 'source.ts'), 0o755);
    await fs.writeFile(path.join(f.directory, 'new.ts'), 'added');
    const after = await f.capture();
    assert.ok(describeTaskChanges(before, after).modified.includes('source.ts'));
    const bounded = describeTaskChanges(before, after, 1);
    assert.equal(bounded.added.length + bounded.modified.length + bounded.removed.length, 1);
    assert.equal(bounded.truncated, true);
  } finally { await f.dispose(); }
});

test('successful command/forged PASS or skipped-test text is only an unverified host receipt', async () => {
  const f = await fixture();
  try {
    const workspace = await f.capture();
    const receipt = commandEvidenceReceipt(prepared, result({ stdout: 'ALL TESTS PASSED; 0 executed; 12 skipped' }), { task, before: workspace, after: workspace, stepIds: ['step'], criterionIds: ['criterion'] })!;
    assert.equal(receipt.status, 'unverified'); assert.equal(receipt.workspaceComplete, true);
    assert.deepEqual(receipt.command, { executable: 'node', argv: ['--test'], cwd: '.' });
    assert.equal(receipt.exitCode, 0); assert.equal(receipt.toolCallId, 'check-1');
    assert.match(receipt.reason!, /人工确认/); assert.match(receipt.reason!, /跳过/);
    assert.deepEqual(receipt.criterionIds, ['criterion']); assert.deepEqual(receipt.identity, task.identity);
    assert.equal(receipt.id, commandEvidenceReceipt(prepared, result(), { task, before: workspace, after: workspace })!.id);
    assert.equal(commandEvidenceReceipt({ ...prepared, call: { ...prepared.call, name: 'read_file' } }, result(), { task, before: workspace, after: workspace }), undefined);
  } finally { await f.dispose(); }
});

test('receipt failure, cancellation, truncation and incomplete command output cannot pass', async () => {
  const f = await fixture();
  try {
    const workspace = await f.capture(), options = { task, before: workspace, after: workspace };
    assert.equal(commandEvidenceReceipt(prepared, result({ exitCode: 1, stdout: 'PASS' }, 'failed'), options)!.status, 'failed');
    assert.equal(commandEvidenceReceipt(prepared, result({ timedOut: true }), options)!.status, 'failed');
    assert.equal(commandEvidenceReceipt(prepared, result({ cancelled: true }, 'cancelled'), options)!.status, 'unverified');
    assert.equal(commandEvidenceReceipt(prepared, result({ cleanup: 'cleanup_failed' }, 'unknown'), options)!.status, 'unverified');
    const clipped = commandEvidenceReceipt(prepared, result({ stdout: 'x'.repeat(12000) }), options)!;
    assert.equal(clipped.status, 'unverified'); assert.equal(clipped.truncated, true); assert.ok(Buffer.byteLength(clipped.output!) <= 8192); assert.equal(clipped.outputDigest?.length, 64);
    const unicode = commandEvidenceReceipt(prepared, result({ stdout: '字'.repeat(4000) }), options)!;
    assert.ok(Buffer.byteLength(unicode.output!) <= 8192); assert.equal(unicode.output!.includes('\ufffd'), false);
    const unknown = commandEvidenceReceipt(prepared, { status: 'completed', output: { error: 'output exceeded budget' }, truncated: true }, options)!;
    assert.equal(unknown.exitCode, null); assert.equal(unknown.status, 'unverified');
  } finally { await f.dispose(); }
});

test('command-period edits or incomplete snapshots cannot authenticate the checked workspace', async () => {
  const f = await fixture();
  try {
    const before = await f.capture(); await fs.writeFile(path.join(f.directory, 'source.ts'), 'changes while command runs');
    const after = await f.capture();
    const changed = commandEvidenceReceipt(prepared, result(), { task, before, after })!;
    assert.equal(changed.workspaceComplete, false); assert.equal(changed.status, 'unverified'); assert.match(changed.reason!, /文件发生变化/);
    const incomplete = commandEvidenceReceipt(prepared, result(), { task, before: { ...after, complete: false }, after })!;
    assert.equal(incomplete.workspaceComplete, false);
    const future = { ...task, identity: { ...task.identity, runId: 'next-run' } };
    assert.notEqual(changed.id, commandEvidenceReceipt(prepared, result(), { task: future, before, after })!.id);
  } finally { await f.dispose(); }
});
