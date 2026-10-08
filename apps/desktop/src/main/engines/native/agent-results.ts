import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RunIdentity } from '@cc-desk/agent-core';
import { assertNoModelCredential } from '@cc-desk/agent-node/responses-model';
import type { NativeAgentResult, NativeAgentResultRequest } from '../../../shared/chat';
import { loadNativeAgents, nativeAgentReceiptDirectory } from './agent-projection';

export const MAX_NATIVE_AGENT_PATCH_BYTES = 16 * 1024 * 1024;
const requestSchema = z.object({
  parentRunId: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/i),
  childId: z.string().uuid(),
  patchOffset: z.number().int().nonnegative().safe().optional(),
  patchCharacters: z.number().int().min(1).max(32000).optional(),
  expectedPatchSha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
}).strict();

const messages = {
  invalid_request: '子 Agent 成果读取请求无效。',
  parent_mismatch: '子 Agent 成果不属于指定父回合。',
  result_not_found: '未找到指定子 Agent 的成果回执。',
  receipt_invalid: '子 Agent 成果回执无法读取或校验，原记录已保留。',
  patch_missing: '子 Agent 成果补丁不存在，原工作区已保留。',
  patch_unsafe: '子 Agent 成果补丁的文件或目录归属无法确认。',
  patch_too_large: '子 Agent 成果补丁超过读取大小限制。',
  patch_read_failed: '子 Agent 成果补丁读取失败，原文件已保留。',
  patch_integrity_mismatch: '子 Agent 成果补丁与保存的完整性记录不一致。',
  patch_revision_mismatch: '子 Agent 成果补丁版本已改变，请重新核查。',
  patch_offset_invalid: '子 Agent 成果补丁读取位置超出内容范围。',
  patch_encoding_invalid: '子 Agent 成果补丁不是有效 UTF-8 文本，不能按文本预览。',
  protected_value: '子 Agent 成果包含受保护的凭据，已停止读取。',
} as const;
export type NativeAgentResultReadErrorCode = keyof typeof messages;
export class NativeAgentResultReadError extends Error {
  constructor(readonly code: NativeAgentResultReadErrorCode) { super(messages[code]); this.name = 'NativeAgentResultReadError'; }
}
function failure(code: NativeAgentResultReadErrorCode): never { throw new NativeAgentResultReadError(code); }

/** No caller-controlled path: every component comes from a bound, parsed host receipt. */
async function assertPatchDirectories(dataDirectory: string, file: string): Promise<void> {
  const root = path.resolve(dataDirectory), directory = path.dirname(file), relative = path.relative(root, directory);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) failure('patch_unsafe');
  if (path.relative(root, await fs.realpath(root)) !== '') failure('patch_unsafe');
  for (let current = root, index = 0, parts = relative.split(path.sep); index <= parts.length; index++) {
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) failure('patch_unsafe');
    if (index < parts.length) current = path.join(current, parts[index]);
  }
}

async function readPatch(dataDirectory: string, file: string): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    await assertPatchDirectories(dataDirectory, file);
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink()) failure('patch_unsafe');
    if (before.size > MAX_NATIVE_AGENT_PATCH_BYTES) failure('patch_too_large');
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) failure('patch_unsafe');
    if (opened.size > MAX_NATIVE_AGENT_PATCH_BYTES) failure('patch_too_large');
    // A bounded read also handles a file growing after stat without allocating its new size.
    const buffer = Buffer.alloc(opened.size + 1);
    let read = 0;
    while (read < buffer.byteLength) {
      const chunk = await handle.read(buffer, read, buffer.byteLength - read, read);
      if (!chunk.bytesRead) break;
      read += chunk.bytesRead;
    }
    const after = await handle.stat(), current = await fs.lstat(file);
    await assertPatchDirectories(dataDirectory, file);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) failure('patch_unsafe');
    if (after.size > MAX_NATIVE_AGENT_PATCH_BYTES) failure('patch_too_large');
    if (read !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
      current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) failure('patch_integrity_mismatch');
    return buffer.subarray(0, read);
  } catch (error) {
    if (error instanceof NativeAgentResultReadError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') failure('patch_missing');
    if (code === 'ELOOP' || code === 'ENOTDIR') failure('patch_unsafe');
    return failure('patch_read_failed');
  } finally { await handle?.close(); }
}

const splitSurrogate = (text: string, offset: number) => offset > 0 && offset < text.length &&
  text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff &&
  text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff;

/** Read preserved facts; this never resumes work, reads arbitrary files or accepts a task. */
export async function readNativeAgentResult(dataDirectory: string, parent: RunIdentity, request: NativeAgentResultRequest,
  options: { forbiddenValues?: readonly string[] } = {}): Promise<NativeAgentResult> {
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success) failure('invalid_request');
  const input = parsed.data;
  if (input.parentRunId !== parent.runId) failure('parent_mismatch');
  try {
    nativeAgentReceiptDirectory(dataDirectory, parent);
    const root = path.resolve(dataDirectory), stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(root, await fs.realpath(root)) !== '') failure('receipt_invalid');
  } catch { failure('receipt_invalid'); }
  const projection = await loadNativeAgents(dataDirectory, parent), snapshot = projection.snapshot(false);
  const receipt = projection.receipts().find(value => value.childId === input.childId);
  if (!receipt) failure(snapshot.incomplete ? 'receipt_invalid' : 'result_not_found');
  const agent = snapshot.items.find(value => value.childId === input.childId);
  if (!agent) failure('receipt_invalid');
  const forbidden = options.forbiddenValues ?? [];
  try { assertNoModelCredential(receipt, forbidden); } catch { failure('protected_value'); }
  const result: NativeAgentResult = { agent, goal: receipt.goal, acceptance: 'not_assessed' };
  if (!receipt.artifact) {
    if (input.patchOffset !== undefined || input.patchCharacters !== undefined || input.expectedPatchSha256 !== undefined) failure('patch_missing');
    return result;
  }
  const bytes = await readPatch(dataDirectory, receipt.artifact.patchPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (receipt.artifact.sha256 !== undefined && (receipt.artifact.sha256 !== sha256 || receipt.artifact.bytes !== bytes.byteLength)) failure('patch_integrity_mismatch');
  if (input.expectedPatchSha256 !== undefined && input.expectedPatchSha256.toLowerCase() !== sha256) failure('patch_revision_mismatch');
  if (forbidden.some(value => value && bytes.includes(Buffer.from(value, 'utf8')))) failure('protected_value');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { failure('patch_encoding_invalid'); }
  try { assertNoModelCredential(text, forbidden); } catch { failure('protected_value'); }
  let offset = input.patchOffset ?? 0;
  if (offset > text.length) failure('patch_offset_invalid');
  if (splitSurrogate(text, offset)) offset--;
  let end = Math.min(text.length, offset + (input.patchCharacters ?? 16000));
  if (splitSurrogate(text, end)) end--;
  // A one-character request at a surrogate pair still makes forward progress.
  if (end === offset && offset < text.length) end = Math.min(text.length, offset + 2);
  result.patch = { sha256, integrity: receipt.artifact.sha256 === undefined ? 'legacy_unverified' : 'verified',
    text: text.slice(offset, end), offset, nextOffset: end < text.length ? end : null, totalCharacters: text.length, totalBytes: bytes.byteLength };
  return result;
}
