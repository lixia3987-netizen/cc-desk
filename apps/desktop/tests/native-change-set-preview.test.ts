import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NativeChangeSetPreview as Preview, NativeChangeSetResult as Result } from '@cc-desk/contracts/native-changes';
import { NativeChangeSetPreview, NativeChangeSetResult, nativeChangeSetCanApprove, nativeChangeSetResultLabel } from '../src/renderer/NativeChangeSetPreview';
import { NativeRecoveryPanel } from '../src/renderer/NativeRecoveryPanel';

const hash = (value: string) => value.repeat(64);
function size(preview: Preview): Preview {
  let previous = -1;
  while (previous !== preview.previewBytes) { previous = preview.previewBytes; preview.previewBytes = Buffer.byteLength(JSON.stringify(preview)); }
  return preview;
}
function preview(): Preview {
  return size({ schemaVersion: 1, digest: hash('a'), atomic: false, totalContentBytes: 12, previewBytes: 0,
    files: [{ index: 0, path: 'src/中文 文件.ts', kind: 'replace', beforeHash: hash('b'), afterHash: hash('c'), beforeBytes: 6, afterBytes: 6,
      diff: '--- a/src/中文 文件.ts\n+++ b/src/中文 文件.ts\n@@ -1,1 +1,1 @@\n-"before" [LF]\n+"after" [CRLF]\n',
      lineEndings: { before: 'lf', after: 'crlf' }, noFinalNewline: { before: false, after: false } },
    { index: 1, path: 'new.txt', kind: 'create', beforeHash: null, afterHash: hash('d'), beforeBytes: 0, afterBytes: 6,
      diff: '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+"<script>hello</script>" [no newline]\n',
      lineEndings: { before: 'none', after: 'none' }, noFinalNewline: { before: false, after: true } }],
  });
}
function result(status: Result['status'] = 'completed'): Result {
  const files = preview().files.map(({ index, path, beforeHash, afterHash }) => ({ index, path, beforeHash, afterHash, status: 'applied' as const }));
  const state: Result = { digest: hash('a'), atomic: false, status, receiptCommitted: true, files };
  if (status === 'partial') state.files[1].status = 'not_applied';
  if (status === 'unknown') state.files[1].status = 'unknown';
  if (status === 'not_applied') state.files.forEach(file => { file.status = 'not_applied'; });
  return state;
}
const renderPreview = (value: unknown) => renderToStaticMarkup(createElement(NativeChangeSetPreview, { preview: value }));
const renderResult = (value: unknown, state?: Parameters<typeof NativeChangeSetResult>[0]['state']) => renderToStaticMarkup(createElement(NativeChangeSetResult, { result: value, state }));

test('complete multi-file preview exposes every path, exact hashes, operation and escaped diff without claiming atomicity', () => {
  const value = preview(), markup = renderPreview(value);
  assert.equal(nativeChangeSetCanApprove(value), true);
  assert.match(markup, /本次批准 2 个文件/);
  for (const file of value.files) {
    assert.ok(markup.includes(file.path)); assert.ok(markup.includes(file.afterHash));
    if (file.beforeHash) assert.ok(markup.includes(file.beforeHash));
  }
  assert.match(markup, /创建文件/); assert.match(markup, /替换文件/);
  assert.match(markup, /不存在（创建文件）/);
  assert.match(markup, /不具备跨文件原子性/); assert.match(markup, /不会自动回滚/);
  assert.match(markup, /JSON 转义展示/); assert.match(markup, /LF → CRLF/); assert.match(markup, /目标文件无/);
  assert.match(markup, /&lt;script&gt;hello&lt;\/script&gt;/); assert.doesNotMatch(markup, /<script>/);
  assert.match(markup, /\[no newline\]/);
  assert.equal((markup.match(/完整改动差异/g) ?? []).length, 2);
  // Diff lines remain literal preformatted text, including the final newline.
  assert.match(markup, /\[CRLF\]\n<\/span>/);
});

test('missing, malformed, oversized and incomplete host previews fail closed instead of showing approvable JSON', () => {
  const values: unknown[] = [undefined, null, {}, { ...preview(), atomic: true }, { ...preview(), truncated: true }, { ...preview(), previewBytes: 1 },
    { ...preview(), files: [] }, { ...preview(), totalContentBytes: 11 }, { ...preview(), schemaVersion: 2 }];
  const missingDiff = preview(); delete (missingDiff.files[0] as Partial<Preview['files'][number]>).diff; values.push(size(missingDiff));
  const duplicate = preview(); duplicate.files[1].path = duplicate.files[0].path; values.push(size(duplicate));
  const invalidHash = preview(); invalidHash.files[1].afterHash = 'not-a-hash'; values.push(size(invalidHash));
  const huge = preview(); huge.files[0].diff = 'untrusted-hidden-payload'.repeat(8000); values.push(size(huge));
  const traversal = preview(); traversal.files[1].path = '../outside.txt'; values.push(size(traversal));
  for (const value of values) {
    assert.equal(nativeChangeSetCanApprove(value), false);
    const markup = renderPreview(value);
    assert.match(markup, /已禁止允许本次操作/); assert.match(markup, /请拒绝此次请求/);
    assert.doesNotMatch(markup, /本次批准|untrusted-hidden-payload|完整改动差异/);
  }
});

test('empty file and missing final newline are represented explicitly', () => {
  const value = preview(); value.files[0].beforeBytes = 0; value.files[0].afterBytes = 0; value.totalContentBytes = 6;
  const markup = renderPreview(size(value));
  assert.match(markup, /末尾换行：原文件为空 → 目标文件为空/);
  assert.match(markup, /末尾换行：原文件不存在 → 目标文件无/);
});

test('partial receipts preserve applied files and confirmed non-applied files without reporting whole-task completion', () => {
  const value = result('partial'), markup = renderResult(value);
  assert.equal(nativeChangeSetResultLabel(value), '本次变更集部分应用');
  assert.match(markup, /data-change-set-status="partial"/);
  assert.match(markup, /data-file-status="applied"/); assert.match(markup, /data-file-status="not_applied"/);
  assert.match(markup, /已写入/); assert.match(markup, /未应用/);
  assert.match(markup, /不会自动回滚/); assert.match(markup, /不要整批重放/);
  assert.doesNotMatch(markup, /本次变更集写入已记录|data-change-set-status="completed"/);
});

test('unknown and uncommitted file receipts cannot appear as all failed, unapplied or complete', () => {
  const value = result('unknown'); value.receiptCommitted = false;
  const markup = renderResult(value);
  assert.equal(nativeChangeSetResultLabel(value), '本次变更集结果未知');
  assert.match(markup, /data-file-status="applied"/); assert.match(markup, /data-file-status="unknown"/);
  assert.match(markup, /可能已发生写入/); assert.match(markup, /不能按未执行处理/);
  assert.match(markup, /回执未能持久保存/);
  assert.doesNotMatch(markup, /data-file-status="not_applied"|data-change-set-status="completed"/);
  const malformed = result('completed'); malformed.files[1].status = 'unknown';
  assert.match(renderResult(malformed), /逐文件回执缺失或无效/);
  assert.equal(nativeChangeSetResultLabel(malformed), '多文件执行结果待核查');
  assert.match(renderResult(undefined), /无法判断哪些文件已经写入/);
});

test('host pending, running and confirmed not-executed phases stay distinct from unknown recovery', () => {
  for (const state of ['pending', 'running', 'not_executed'] as const) {
    const markup = renderResult(undefined, state);
    assert.match(markup, new RegExp(`data-change-set-state="${state}"`));
    assert.doesNotMatch(markup, /逐文件回执缺失或无效|本次变更集写入已记录/);
  }
  assert.equal(nativeChangeSetResultLabel(undefined, 'pending'), '等待执行');
  assert.match(renderResult(undefined, 'running'), /当前不代表全部完成/);
  assert.match(renderResult(undefined, 'not_executed'), /宿主已确认本次工具未执行写入/);
  assert.match(renderResult(result('completed')), /不代表任务验收通过/);
});

test('recovery explicitly warns that unknown multi-file operations may have partially written', () => {
  const markup = renderToStaticMarkup(createElement(NativeRecoveryPanel, {
    recovery: { status: 'blocked', headHash: hash('f'), tools: { completed: 1, notExecuted: 1, unknown: 1 } }, disabled: false, pending: false,
    onResume: () => { throw new Error('no execution while rendering'); }, onConfirm: () => { throw new Error('no execution while rendering'); },
  }));
  assert.match(markup, /若包含多文件变更，可能已部分写入/); assert.match(markup, /不能整批重放/);
  assert.match(markup, /旧会话仍为只读/); assert.match(markup, /需新建会话继续/);
});
