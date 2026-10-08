import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { RunIdentity } from '@cc-desk/agent-core';
import type { NativeAgentResultRequest } from '../src/shared/chat';
import type { NativeDelegationReceipt } from '../src/main/engines/native/agent-delegation';
import { writeAgentArtifact, writeAgentReceipt } from '../src/main/engines/native/agent-artifacts';
import { nativeAgentReceiptDirectory, loadNativeAgents } from '../src/main/engines/native/agent-projection';
import { MAX_NATIVE_AGENT_PATCH_BYTES, NativeAgentResultReadError, readNativeAgentResult } from '../src/main/engines/native/agent-results';

const identity = (): RunIdentity => ({ sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 });
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const at = '2026-10-08T01:00:00.000Z';
async function fixture(t: { after(fn: () => Promise<void>): void }, text: string | Buffer | null = '--- a/source.ts\n+++ b/source.ts\n+new result\n', legacy = false) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-agent-results-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const parent = identity(), child = identity(), childId = randomUUID(), batchId = randomUUID(), taskId = randomUUID();
  const receiptPath = path.join(nativeAgentReceiptDirectory(directory, parent), batchId, childId, 'receipt.json');
  const receipt: NativeDelegationReceipt = { version: 1, batchId, childId, taskId, identity: child, parentIdentity: parent,
    parentTaskId: randomUUID(), toolCallId: 'delegate-1', title: '保留实现成果', goal: '完成实现后由父任务审阅', mode: 'implement',
    status: 'completed', createdAt: at, updatedAt: at, receiptPath, cwd: directory,
    result: { identity: child, taskId, status: 'completed', reason: 'model_completed', committed: true,
      summary: '实现完成，尚未验收', modelRequests: 2, toolCalls: 1 } };
  if (text !== null) {
    const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text), patchPath = path.join(path.dirname(receiptPath), 'workspace.diff.patch');
    receipt.artifact = { patchPath, changedFiles: [{ path: 'source.ts', status: 'M' }], head: 'b'.repeat(40), baseCommit: 'a'.repeat(40),
      ...(legacy ? {} : { sha256: digest(bytes), bytes: bytes.byteLength }) };
    await writeAgentArtifact(patchPath, bytes);
  }
  await writeAgentReceipt(receiptPath, receipt);
  const request: NativeAgentResultRequest = { parentRunId: parent.runId, childId };
  return { directory, parent, receipt, request, read: (update: Partial<NativeAgentResultRequest> = {}, forbiddenValues: readonly string[] = []) =>
    readNativeAgentResult(directory, parent, { ...request, ...update }, { forbiddenValues }) };
}
const hasCode = (code: NativeAgentResultReadError['code']) => (error: unknown) => error instanceof NativeAgentResultReadError && error.code === code;

test('verified retained results expose the saved goal, metadata and patch without accepting the task', async t => {
  const f = await fixture(t), result = await f.read();
  assert.equal(result.acceptance, 'not_assessed'); assert.equal(result.goal, f.receipt.goal);
  assert.equal(result.agent.parentIdentity.runId, f.parent.runId); assert.equal(result.agent.status, 'completed');
  assert.equal(result.patch!.integrity, 'verified'); assert.equal(result.patch!.sha256, f.receipt.artifact!.sha256);
  assert.equal(result.agent.artifact!.sha256, result.patch!.sha256); assert.equal(result.agent.artifact!.bytes, result.patch!.totalBytes);
  assert.equal(result.patch!.offset, 0); assert.equal(result.patch!.nextOffset, null);
  assert.equal(result.patch!.text, await fs.readFile(f.receipt.artifact!.patchPath, 'utf8'));
  assert.deepEqual(JSON.parse(await fs.readFile(f.receipt.receiptPath, 'utf8')), f.receipt, 'reading does not mutate durable facts');
});

test('legacy receipts remain readable with explicitly unverified integrity and unchanged raw bytes', async t => {
  const bytes = Buffer.from('+historical result\n'), f = await fixture(t, bytes, true), result = await f.read();
  assert.equal(result.patch!.integrity, 'legacy_unverified'); assert.equal(result.patch!.sha256, digest(bytes));
  assert.equal(result.patch!.totalBytes, bytes.byteLength); assert.equal(result.agent.artifact!.sha256, undefined);
  assert.deepEqual(await fs.readFile(f.receipt.artifact!.patchPath), bytes);
  assert.equal((await f.read({ expectedPatchSha256: digest(bytes) })).patch!.integrity, 'legacy_unverified');
});

test('non-UTF8 artifacts are retained but refused as text rather than displayed with replacement characters', async t => {
  const bytes = Buffer.from([43, 99, 97, 102, 233, 10]);
  for (const legacy of [false, true]) {
    const f = await fixture(t, bytes, legacy);
    await assert.rejects(f.read(), hasCode('patch_encoding_invalid'));
    assert.deepEqual(await fs.readFile(f.receipt.artifact!.patchPath), bytes);
  }
});

test('historical results are bound to the complete parent identity rather than the latest run', async t => {
  const f = await fixture(t), latest = { ...f.parent, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 2 };
  assert.equal((await f.read()).agent.childId, f.receipt.childId);
  await assert.rejects(readNativeAgentResult(f.directory, latest, f.request), hasCode('parent_mismatch'));
  await assert.rejects(readNativeAgentResult(f.directory, latest, { ...f.request, parentRunId: latest.runId }), hasCode('result_not_found'));
  await assert.rejects(readNativeAgentResult(f.directory, { ...f.parent, requestId: randomUUID() }, f.request), hasCode('receipt_invalid'));
});

test('request validation and receipt paths cannot grant arbitrary file or cross-child access', async t => {
  const f = await fixture(t);
  for (const request of [{ ...f.request, childId: '../outside' }, { ...f.request, parentRunId: '../outside' },
    { ...f.request, patchPath: f.receipt.artifact!.patchPath }, { ...f.request, patchCharacters: 32001 }, { ...f.request, patchCharacters: 0 },
    { ...f.request, patchOffset: -1 }, { ...f.request, patchOffset: Number.MAX_SAFE_INTEGER + 1 }, { ...f.request, expectedPatchSha256: 'invalid' }]) {
    await assert.rejects(readNativeAgentResult(f.directory, f.parent, request), hasCode('invalid_request'));
  }
  await assert.rejects(f.read({ childId: randomUUID() }), hasCode('result_not_found'));
  f.receipt.artifact!.patchPath = path.join(f.directory, 'outside.patch'); await fs.writeFile(f.receipt.artifact!.patchPath, 'private outside file');
  await writeAgentReceipt(f.receipt.receiptPath, f.receipt);
  await assert.rejects(f.read(), hasCode('receipt_invalid'));
});

test('missing, malformed and partly specified integrity receipts return fixed errors without echoing input', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.receipt.receiptPath, '{"private-input":"do not echo"');
  await assert.rejects(f.read(), error => hasCode('receipt_invalid')(error) && !(error as Error).message.includes('do not echo'));
  delete f.receipt.artifact!.bytes; await writeAgentReceipt(f.receipt.receiptPath, f.receipt);
  await assert.rejects(f.read(), hasCode('receipt_invalid'));
  await fs.rm(f.receipt.receiptPath);
  await assert.rejects(f.read(), hasCode('receipt_invalid'), 'a retained child directory without its receipt is incomplete, not a clean absence');
});

test('new receipt hashes and byte counts both detect patch tampering before returning any page', async t => {
  const f = await fixture(t);
  await fs.appendFile(f.receipt.artifact!.patchPath, 'tampered');
  await assert.rejects(f.read(), hasCode('patch_integrity_mismatch'));
  const bytes = await fs.readFile(f.receipt.artifact!.patchPath); f.receipt.artifact!.sha256 = digest(bytes);
  await writeAgentReceipt(f.receipt.receiptPath, f.receipt);
  await assert.rejects(f.read(), hasCode('patch_integrity_mismatch'), 'a matching hash cannot hide a stale byte count');
});

test('expected hashes bind pages even for a legacy receipt and never silently follow changed content', async t => {
  const f = await fixture(t, 'abcdef', true), first = await f.read({ patchCharacters: 2 });
  await fs.writeFile(f.receipt.artifact!.patchPath, 'abcXYZ');
  await assert.rejects(f.read({ patchOffset: first.patch!.nextOffset!, expectedPatchSha256: first.patch!.sha256 }), hasCode('patch_revision_mismatch'));
  assert.equal((await f.read()).patch!.text, 'abcXYZ');
});

test('bounded UTF-16 pages round-trip astral characters and normalize a mid-surrogate offset', async t => {
  const text = 'A😀BC𐐀D', f = await fixture(t, text);
  const first = await f.read({ patchCharacters: 2 });
  assert.equal(first.patch!.text, 'A'); assert.equal(first.patch!.nextOffset, 1);
  const middle = await f.read({ patchOffset: 2, patchCharacters: 1 });
  assert.equal(middle.patch!.offset, 1); assert.equal(middle.patch!.text, '😀'); assert.equal(middle.patch!.nextOffset, 3);
  let offset = 0, reconstructed = '';
  do {
    const page = (await f.read({ patchOffset: offset, patchCharacters: 2, expectedPatchSha256: first.patch!.sha256 })).patch!;
    assert.ok(!/^[\uDC00-\uDFFF]/.test(page.text)); assert.ok(!/[\uD800-\uDBFF]$/.test(page.text));
    reconstructed += page.text; if (page.nextOffset === null) break; assert.ok(page.nextOffset > offset); offset = page.nextOffset;
  } while (true);
  assert.equal(reconstructed, text); assert.equal((await f.read({ patchOffset: text.length })).patch!.text, '');
  await assert.rejects(f.read({ patchOffset: text.length + 1 }), hasCode('patch_offset_invalid'));
});

test('default and maximum page sizes apply before a result is presented', async t => {
  const f = await fixture(t, 'x'.repeat(40000));
  assert.equal((await f.read()).patch!.text.length, 16000);
  assert.equal((await f.read({ patchCharacters: 32000 })).patch!.text.length, 32000);
});

test('patch size bounds and missing files fail closed', async t => {
  const f = await fixture(t);
  await fs.truncate(f.receipt.artifact!.patchPath, MAX_NATIVE_AGENT_PATCH_BYTES + 1);
  await assert.rejects(f.read(), hasCode('patch_too_large'));
  await fs.rm(f.receipt.artifact!.patchPath); await assert.rejects(f.read(), hasCode('patch_missing'));
});

test('a substituted child directory junction is not followed even if it contains a valid-looking receipt', async t => {
  const f = await fixture(t), original = path.dirname(f.receipt.receiptPath), outside = path.join(f.directory, 'outside');
  await fs.rename(original, outside); await fs.symlink(outside, original, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.read(), hasCode('receipt_invalid'));
});

test('the host data root must already be canonical, including symbolic ancestors above it', async t => {
  const f = await fixture(t), alias = `${f.directory}-alias`, nested = path.join(f.directory, 'profile');
  await fs.mkdir(nested); await fs.symlink(f.directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => fs.rm(alias, { recursive: true, force: true }));
  await assert.rejects(readNativeAgentResult(alias, f.parent, f.request), hasCode('receipt_invalid'));
  await assert.rejects(readNativeAgentResult(path.join(alias, 'profile'), f.parent, f.request), hasCode('receipt_invalid'));
  assert.equal((await f.read()).agent.childId, f.receipt.childId);
});

test('a patch symlink or non-file is not treated as a saved artifact', async t => {
  const f = await fixture(t), patch = f.receipt.artifact!.patchPath;
  await fs.rm(patch); await fs.mkdir(patch);
  await assert.rejects(f.read(), hasCode('patch_unsafe'));
  await fs.rm(patch, { recursive: true });
  const outside = path.join(f.directory, 'external.patch'); await fs.writeFile(outside, 'outside');
  try { await fs.symlink(outside, patch, 'file'); }
  catch (error) { if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return; throw error; }
  await assert.rejects(f.read(), hasCode('patch_unsafe'));
});

test('credential checks cover the full receipt and entire raw patch before paging', async t => {
  const secret = 'protected-model-credential', f = await fixture(t, `safe first page\n${secret}`);
  await assert.rejects(f.read({ patchCharacters: 4 }, [secret]), hasCode('protected_value'));
  const other = await fixture(t, null); other.receipt.goal += secret; await writeAgentReceipt(other.receipt.receiptPath, other.receipt);
  await assert.rejects(other.read({}, [secret]), hasCode('protected_value'));
});

test('a receipt without a patch can be reviewed but cannot satisfy a patch request', async t => {
  const f = await fixture(t, null);
  assert.equal((await f.read()).patch, undefined);
  await assert.rejects(f.read({ patchOffset: 0 }), hasCode('patch_missing'));
});

test('all sixteen saved children remain accessible while inactive running state is shown as unknown', async t => {
  const f = await fixture(t);
  for (let index = 1; index < 16; index++) {
    const batchId = randomUUID(), childId = randomUUID(), child = identity(), taskId = randomUUID();
    const receipt: NativeDelegationReceipt = { ...f.receipt, batchId, childId, identity: child, taskId, status: 'running', result: undefined, artifact: undefined,
      receiptPath: path.join(nativeAgentReceiptDirectory(f.directory, f.parent), batchId, childId, 'receipt.json') };
    await writeAgentReceipt(receipt.receiptPath, receipt);
    const result = await readNativeAgentResult(f.directory, f.parent, { parentRunId: f.parent.runId, childId });
    assert.equal(result.agent.status, 'unknown'); assert.equal(result.agent.missingTerminal, true); assert.equal(result.acceptance, 'not_assessed');
  }
  const projection = await loadNativeAgents(f.directory, f.parent);
  assert.equal(projection.snapshot().items.length, 16); assert.equal(projection.snapshot().omitted, 0);
});
