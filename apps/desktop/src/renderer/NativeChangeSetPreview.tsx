import { isNativeChangeSetPreview, isNativeChangeSetResult } from '@cc-desk/contracts/native-changes';
import type { NativeChangeSetLineEndings, NativeChangeSetResult as ChangeSetResult } from '@cc-desk/contracts/native-changes';

const endings: Record<NativeChangeSetLineEndings, string> = { none: '无换行符', lf: 'LF', crlf: 'CRLF', cr: 'CR', mixed: '混合换行' };
const fileStates = { applied: '已写入', not_applied: '未应用', unknown: '结果未知 · 需核查现场' };
const resultStates: Record<ChangeSetResult['status'], string> = {
  completed: '本次变更集写入已记录', partial: '本次变更集部分应用', not_applied: '本次变更集未应用', unknown: '本次变更集结果未知',
};

/** Missing, truncated or malformed host previews must never fall back to ordinary JSON approval. */
export function nativeChangeSetCanApprove(preview: unknown): boolean {
  return isNativeChangeSetPreview(preview);
}

type ChangeSetState = 'pending' | 'running' | 'not_executed' | 'result';
export function nativeChangeSetResultLabel(result: unknown, state?: ChangeSetState): string {
  if (state === 'pending') return '等待执行';
  if (state === 'running') return '多文件写入进行中';
  if (state === 'not_executed') return '本次变更集未执行';
  return isNativeChangeSetResult(result) ? resultStates[result.status] : '多文件执行结果待核查';
}

function Hashes({ beforeHash, afterHash }: { beforeHash: string | null; afterHash: string }) {
  return <dl className="native-change-set-hashes">
    <dt>批准的原 SHA-256</dt><dd><code>{beforeHash ?? '不存在（创建文件）'}</code></dd>
    <dt>批准的目标 SHA-256</dt><dd><code>{afterHash}</code></dd>
  </dl>;
}

export function NativeChangeSetPreview({ preview }: { preview: unknown }) {
  if (!isNativeChangeSetPreview(preview)) return <section className="native-change-set native-change-set-invalid" aria-label="多文件变更预览">
    <p className="native-change-set-warning" role="alert">无法读取完整且有效的多文件预览，已禁止允许本次操作。</p>
    <p>预览可能缺失、损坏或超限。请拒绝此次请求，再让 Agent 缩小变更范围并重新准备审批。</p>
  </section>;
  return <section className="native-change-set" aria-label="多文件变更预览" data-change-set-digest={preview.digest}>
    <h4>本次批准 {preview.files.length} 个文件的变更</h4>
    <p className="native-change-set-warning">这些文件依次写入，不具备跨文件原子性。中途失败可能已修改部分文件，不会自动回滚；结果未知时请先核查现场，不要整批重试。</p>
    <p className="native-change-set-note">以下为宿主生成的完整改动预览。滚动可查看全部差异；批准前请核对每个文件、原版本与目标版本。批准后仍会复核文件和指令版本。</p>
    <p className="native-change-set-note">行内容以 JSON 转义展示，行尾标签表示真实换行；展示完整改动区及附近上下文，并非最小差异。</p>
    <p className="native-change-set-meta">目标内容共 {preview.totalContentBytes} 字节 · 预览 {preview.previewBytes} 字节</p>
    <p className="native-change-set-meta">变更集摘要：<code>{preview.digest}</code></p>
    <ol className="native-change-set-files">{preview.files.map(file => <li key={file.index} className="native-change-set-file" data-change-file={file.path}>
      <header><strong>{file.index + 1}. <code>{file.path}</code></strong><span>{file.kind === 'create' ? '创建文件' : '替换文件'}</span></header>
      <Hashes beforeHash={file.beforeHash} afterHash={file.afterHash}/>
      <p className="native-change-set-meta">大小：{file.beforeBytes} → {file.afterBytes} 字节；换行：{endings[file.lineEndings.before]} → {endings[file.lineEndings.after]}</p>
      <p className="native-change-set-meta">末尾换行：原文件{file.beforeHash === null ? '不存在' : file.beforeBytes === 0 ? '为空' : file.noFinalNewline.before ? '无' : '有'} → 目标文件{file.afterBytes === 0 ? '为空' : file.noFinalNewline.after ? '无' : '有'}</p>
      <pre className="native-change-set-diff" aria-label={file.path + ' 完整改动差异'}><code>{file.diff.split('\n').map((line, index, lines) => <span key={index} className={line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : undefined}>{line}{index < lines.length - 1 ? '\n' : ''}</span>)}</code></pre>
    </li>)}</ol>
  </section>;
}

export function NativeChangeSetResult({ result, state }: { result: unknown; state?: ChangeSetState }) {
  if (state === 'pending' || state === 'running' || state === 'not_executed') return <section className="native-change-set" aria-label="多文件执行结果" data-change-set-state={state}>
    <h4>{nativeChangeSetResultLabel(result, state)}</h4>
    <p className="native-change-set-note">{state === 'pending' ? '正在准备工具或等待审批，尚未获得执行回执。' : state === 'running' ? '正在依次写入文件；请等待宿主确认逐文件结果，当前不代表全部完成。' : '宿主已确认本次工具未执行写入；此前其他操作可能已修改文件。旧请求不会自动重放。'}</p>
  </section>;
  if (!isNativeChangeSetResult(result)) return <section className="native-change-set native-change-set-invalid" aria-label="多文件执行结果">
    <strong>多文件执行结果待核查</strong>
    <p className="native-change-set-warning" role="alert">逐文件回执缺失或无效，无法判断哪些文件已经写入。请核查现场；不要将其视为全部失败、全部未执行或全部完成，也不要整批重放。</p>
  </section>;
  return <section className="native-change-set" aria-label="多文件执行结果" data-change-set-status={result.status}>
    <h4>{resultStates[result.status]}</h4>
    <p className="native-change-set-note">这是本次工具的写入回执，不代表任务验收通过；哈希标明获批版本，文件可能在之后被修改。</p>
    {result.status !== 'completed' && <p className="native-change-set-warning">多文件写入不是原子事务，已写入的文件不会自动回滚。请逐项核查后再决定下一步，不要整批重放。</p>}
    {result.files.some(file => file.status === 'unknown') && <p className="native-change-set-warning" role="alert">结果未知的文件可能已发生写入，不能按未执行处理；当前记录不能证明全部失败或全部完成。</p>}
    {!result.receiptCommitted && <p className="native-change-set-warning" role="alert">部分执行回执未能持久保存，重启后的状态仍须核查。</p>}
    {result.errorCode && <p className="native-change-set-meta">原因：<code>{result.errorCode}</code></p>}
    <p className="native-change-set-meta">变更集摘要：<code>{result.digest}</code></p>
    <ol className="native-change-set-files">{result.files.map(file => <li key={file.index} className="native-change-set-file" data-file-status={file.status}>
      <header><strong>{file.index + 1}. <code>{file.path}</code></strong><span className="native-change-set-state">{fileStates[file.status]}</span></header>
      <Hashes beforeHash={file.beforeHash} afterHash={file.afterHash}/>
      {file.errorCode && <p className="native-change-set-meta">原因：<code>{file.errorCode}</code></p>}
    </li>)}</ol>
  </section>;
}
