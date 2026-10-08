import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { NativeAgentSnapshot, NativeAgentView, NativeAgentResult } from '../shared/chat';
import { Dialog } from './Dialog';
import { NativeAgentResultReader, nativeAgentReviewPrompt } from './native-agent-review';

const labels: Record<NativeAgentView['status'], string> = {
  prepared: '准备中', running: '运行中', completed: '执行已完成', failed: '执行失败', cancelled: '已取消', unknown: '结果未知，待核查',
};
const referenceId = (childId: string, kind: string) => `native-agent-${childId}-${kind}`;
function revealReference(event: MouseEvent<HTMLAnchorElement>, id: string) {
  event.preventDefault();
  const target = document.getElementById(id);
  if (!target) return;
  for (let parent: HTMLElement | null = target; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
  target.scrollIntoView({ block: 'nearest' }); target.focus({ preventScroll: true });
}
function Reference({ id, label, value }: { id: string; label: string; value: string }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState('');
  return <div id={id} tabIndex={-1} className="native-agent-reference">
    <strong>{label}</strong><code>{value}</code>
    <button type="button" className="compact" aria-label={`复制${label}`} onClick={async () => {
      try { await window.desktop.copyText(value); setCopied(true); setError(''); }
      catch { setError('复制失败，请重试。'); }
    }}>{copied ? '已复制' : '复制'}</button>
    {error && <span role="alert">{error}</span>}
  </div>;
}
function Agent({ agent, loadError, onRead }: { agent: NativeAgentView; loadError?: string; onRead: () => void }) {
  const status = loadError ? 'unknown' : agent.status;
  const links = [{ kind: 'task', label: '子任务' }, { kind: 'run', label: '执行回合' }, { kind: 'receipt', label: '执行回执' },
    ...(agent.worktree ? [{ kind: 'worktree', label: '隔离工作区' }] : []), ...(agent.artifact ? [{ kind: 'patch', label: '文件差异' }] : [])];
  return <details className="native-agent-entry" data-agent-id={agent.childId} data-agent-status={status}>
    <summary><strong>{agent.title}</strong><span>{agent.mode === 'review' ? '只读审阅' : '隔离实现'}</span><span className={`native-agent-state ${status}`}>{labels[status]}</span></summary>
    <button type="button" className="secondary compact native-agent-read" onClick={onRead}>查看保存成果</button>
    <nav aria-label={`${agent.title}的结果引用`}>{links.map(link => <a key={link.kind} href={`#${referenceId(agent.childId, link.kind)}`}
      onClick={event => revealReference(event, referenceId(agent.childId, link.kind))}>{link.label}</a>)}</nav>
    {agent.missingTerminal && <p className="native-agent-warning">未找到可确认的终局回执，无法确认子 Agent 已停止或成果已完整保存。</p>}
    {agent.summary && <p className="native-agent-summary">{agent.summary}</p>}
    {agent.reason && <p>结束原因：<code>{agent.reason}</code></p>}
    {agent.error && <p className="native-agent-warning">宿主记录：<code>{agent.error}</code></p>}
    {agent.usage && <p>模型请求 {agent.usage.modelRequests} 次 · 工具调用 {agent.usage.toolCalls} 次（计入父回合总额度）</p>}
    <p>更新时间：<time dateTime={agent.updatedAt}>{agent.updatedAt}</time></p>
    <Reference id={referenceId(agent.childId, 'task')} label="子任务 ID" value={agent.taskId}/>
    <Reference id={referenceId(agent.childId, 'run')} label="子执行回合 ID" value={agent.identity.runId}/>
    <Reference id={referenceId(agent.childId, 'receipt')} label="执行回执路径" value={agent.receiptPath}/>
    {agent.evidence?.taskSnapshotPath && <Reference id={referenceId(agent.childId, 'task-record')} label="子任务记录路径" value={agent.evidence.taskSnapshotPath}/>}
    {agent.evidence?.runJournalPath && <Reference id={referenceId(agent.childId, 'run-record')} label="子回合原始记录路径" value={agent.evidence.runJournalPath}/>}
    {agent.worktree && <div id={referenceId(agent.childId, 'worktree')} tabIndex={-1}>
      <p>基线：{agent.worktree.baseline === 'snapshot' ? '父工作区修改快照' : '父 Git HEAD'} · {agent.worktree.verified ? '已确认独立工作区' : '创建状态尚未确认'}</p>
      <Reference id={referenceId(agent.childId, 'worktree-path')} label="隔离工作区路径" value={agent.worktree.path}/>
      <Reference id={referenceId(agent.childId, 'worktree-branch')} label="隔离分支" value={agent.worktree.branch}/>
      <p className="native-agent-note">分支保留用于审阅，不代表改动已提交或已合入父工作区。</p>
      <p>基线提交：<code>{agent.worktree.baseCommit}</code></p>
    </div>}
    {agent.artifact && <div id={referenceId(agent.childId, 'patch')} tabIndex={-1}>
      <Reference id={referenceId(agent.childId, 'patch-path')} label="文件差异路径" value={agent.artifact.patchPath}/>
      <ul>{agent.artifact.changedFiles.map(file => <li key={file.path}><code>{file.status} {file.path}</code></li>)}</ul>
      {agent.artifact.omittedFiles > 0 && <p>另有 {agent.artifact.omittedFiles} 个文件差异保存在完整补丁中。</p>}
    </div>}
    {!!agent.evidence?.commandReceipts.length && <details><summary>命令回执（{agent.evidence.commandReceipts.length}）</summary>
      {agent.evidence.commandReceipts.map(command => <div key={command.toolCallId} className="native-agent-command">
        <p>工具调用：<code>{command.toolCallId}</code> · 状态：<code>{command.status}</code> · 退出码：{command.exitCode === null ? '未知' : command.exitCode}</p>
        <Reference id={referenceId(agent.childId, `command-${command.toolCallId}`)} label="命令原始记录路径" value={command.receiptPath}/>
      </div>)}
    </details>}
  </details>;
}

/** Plain text from retained host records; summaries and patches never become HTML. */
export function NativeAgentSavedResult({ result }: { result: NativeAgentResult }) {
  const { agent, goal, patch } = result;
  return <>
    <p className={`native-agent-state ${agent.status}`}>{labels[agent.status]} · 父任务验收尚未确认</p>
    {agent.missingTerminal && <p className="native-agent-warning">未找到可确认的终局回执，需先核查执行状态与已产生的操作。</p>}
    <section aria-label="子任务目标"><h3>目标</h3><p className="native-agent-result-text">{goal}</p></section>
    <section aria-label="子任务结果摘要"><h3>结果摘要</h3><p className="native-agent-result-text">{agent.summary || '没有保存的结果摘要。'}</p></section>
    {agent.reason && <p>结束原因：<code>{agent.reason}</code></p>}
    {agent.error && <p className="native-agent-warning">宿主记录：<code>{agent.error}</code></p>}
    {agent.usage && <p>模型请求 {agent.usage.modelRequests} 次 · 工具调用 {agent.usage.toolCalls} 次（计入原父回合总额度）</p>}
    <section aria-label="保存补丁"><h3>保存补丁</h3>
      <p className="native-agent-note">以下为成果保存时的补丁，当前父工作区或隔离工作区可能已变化；读取补丁不会执行写入。</p>
      {patch ? <>
        <p>SHA-256：<code>{patch.sha256}</code></p>
        <p className={patch.integrity === 'verified' ? undefined : 'native-agent-warning'}>完整性：{patch.integrity === 'verified' ? '已与宿主保存的哈希校验一致' : '旧记录缺少原始哈希，当前读取仅生成摘要，不能证明内容自保存以来未变化'}</p>
        <p>补丁共 {patch.totalBytes.toLocaleString()} 字节 · 当前显示字符 {patch.offset.toLocaleString()}–{(patch.offset + patch.text.length).toLocaleString()} / {patch.totalCharacters.toLocaleString()}</p>
        <pre className="native-agent-patch" aria-label="保存补丁内容"><code>{patch.text || '（空补丁）'}</code></pre>
      </> : <p>本次读取没有可用的保存补丁。可查看结果摘要和已保存回执。</p>}
    </section>
    <details className="native-agent-result-evidence"><summary>宿主保存的验证回执（{agent.evidence?.commandReceipts.length ?? 0}）</summary>
      <p className="native-agent-note">下列为保存的执行事实；退出码为 0 不能代替任务验收，路径引用不能代替日志正文。</p>
      {agent.evidence?.commandReceipts.length ? agent.evidence.commandReceipts.map(command => <div className="native-agent-command" key={command.toolCallId}>
        <p>工具调用：<code>{command.toolCallId}</code> · 状态：<code>{command.status}</code> · 退出码：{command.exitCode === null ? '未知' : command.exitCode}</p>
        <p>原始记录：<code>{command.receiptPath}</code></p>
      </div>) : <p>没有保存的命令验证回执。</p>}
      {agent.evidence?.taskSnapshotPath && <p>子任务记录：<code>{agent.evidence.taskSnapshotPath}</code></p>}
      {agent.evidence?.runJournalPath && <p>子回合记录：<code>{agent.evidence.runJournalPath}</code></p>}
    </details>
    <details className="native-agent-result-evidence"><summary>身份与隔离工作区</summary>
      <p>父执行回合：<code>{agent.parentIdentity.runId}</code> · 子 Agent：<code>{agent.childId}</code></p>
      <p>子任务：<code>{agent.taskId}</code> · 子执行回合：<code>{agent.identity.runId}</code></p>
      <p>执行回执：<code>{agent.receiptPath}</code></p>
      {agent.worktree && <>
        <p>隔离工作区：<code>{agent.worktree.path}</code></p><p>隔离分支：<code>{agent.worktree.branch}</code></p>
        <p>基线：<code>{agent.worktree.baseCommit}</code> · {agent.worktree.baseline === 'snapshot' ? '父工作区修改快照' : '父 Git HEAD'}</p>
        <p className="native-agent-note">隔离分支不代表改动已提交或已合入，整合仍需审阅和父回合审批。</p>
      </>}
    </details>
  </>;
}

function ResultDialog({ sessionId, agent, readOnly, onReviewPrompt, onClose }: {
  sessionId: string; agent: NativeAgentView; readOnly: boolean; onReviewPrompt?: (text: string, parentTaskId: string) => void; onClose: () => void;
}) {
  const [result, setResult] = useState<NativeAgentResult>(), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [previousOffsets, setPreviousOffsets] = useState<number[]>([]), [opinion, setOpinion] = useState(''), [notice, setNotice] = useState(''), [handoffError, setHandoffError] = useState('');
  const current = useRef<NativeAgentResult | undefined>(undefined), reading = useRef(false), readGeneration = useRef(0);
  const reader = useMemo(() => new NativeAgentResultReader(sessionId, agent, request => window.desktop.nativeAgentResult(sessionId, request)), [sessionId, agent.childId, agent.parentIdentity.runId]);
  const load = async (offset = 0, direction: 'reset' | 'next' | 'previous' = 'reset') => {
    if (reading.current) return;
    const generation = ++readGeneration.current;
    reading.current = true; setLoading(true); setError(''); setNotice('');
    try {
      const next = await reader.read(offset, direction === 'reset' ? undefined : current.current?.patch?.sha256);
      if (!next || generation !== readGeneration.current) return;
      const previousOffset = current.current?.patch?.offset ?? 0;
      setPreviousOffsets(previous => direction === 'reset' ? [] : direction === 'previous' ? previous.slice(0, -1) : [...previous, previousOffset]);
      current.current = next; setResult(next); setLoading(false);
    } catch (failure) { if (generation === readGeneration.current) { setError(failure instanceof Error ? failure.message : '成果读取失败，请重试。'); setLoading(false); } }
    finally { if (generation === readGeneration.current) reading.current = false; }
  };
  useEffect(() => { void load(); return () => { reader.cancel(); readGeneration.current++; reading.current = false; }; }, [reader]);
  const handoff = (action: 'review' | 'revise') => {
    if (!result || loading || error || readOnly || !onReviewPrompt) return;
    try { onReviewPrompt(nativeAgentReviewPrompt(result, opinion, action), result.agent.parentTaskId); setHandoffError(''); setNotice('已追加到输入框，请检查后发送。'); }
    catch (failure) { setNotice(''); setHandoffError(failure instanceof Error ? failure.message : '无法追加审阅意见，请重试。'); }
  };
  const uncertain = result?.agent.status === 'unknown' || result?.agent.missingTerminal;
  const handoffDisabled = readOnly || !onReviewPrompt || loading || !!error || !result;
  return <Dialog label="子 Agent 保存成果" className="native-agent-result" onClose={onClose}>
    <div className="native-agent-result-heading"><h2>{agent.title}</h2><button type="button" className="secondary compact" onClick={onClose}>关闭成果</button></div>
    <p className="native-agent-note">成果审阅与任务验收分别记录；以下内容来自宿主保留记录。</p>
    {loading && <p role="status">正在读取保存成果…</p>}
    {error && <div className="native-agent-warning" role="alert"><p>{error}</p><button type="button" className="secondary compact" disabled={loading} onClick={() => void load()}>重新读取成果</button></div>}
    {error && result && <p className="native-agent-warning">下面保留上次读取的内容，本次状态未能确认。</p>}
    {result && <NativeAgentSavedResult result={result}/>}
    {result?.patch && <div className="native-agent-result-actions" aria-label="保存补丁分页">
      <button type="button" className="secondary compact" disabled={loading || !!error || !previousOffsets.length} onClick={() => void load(previousOffsets[previousOffsets.length - 1], 'previous')}>上一页补丁</button>
      <button type="button" className="secondary compact" disabled={loading || !!error || result.patch.nextOffset === null} onClick={() => void load(result.patch!.nextOffset!, 'next')}>下一页补丁</button>
    </div>}
    <div className="native-agent-review-input"><label>成果审阅意见<textarea aria-label="成果审阅意见" rows={3} maxLength={2000} value={opinion} disabled={readOnly} placeholder="说明需要检查、整合或修改的内容。" onChange={event => { setOpinion(event.target.value); setNotice(''); setHandoffError(''); }}/></label></div>
    {readOnly && <p className="native-agent-note">当前仅允许查看成果，不能向会话交接。</p>}
    <div className="native-agent-result-actions">
      <button type="button" className="primary compact" disabled={handoffDisabled} onClick={() => handoff('review')}>{uncertain ? '交给父 Agent 核查' : result?.agent.mode === 'implement' ? '交给父 Agent 审阅/整合' : '交给父 Agent 审阅'}</button>
      <button type="button" className="secondary compact" disabled={handoffDisabled} onClick={() => handoff('revise')}>要求修改</button>
    </div>
    <p className="native-agent-note">操作会把成果身份、补丁哈希和意见追加到输入框，由你检查并发送。不会自动运行模型或修改文件。</p>
    {handoffError && <p className="native-agent-warning" role="alert">{handoffError}</p>}
    {notice && <p role="status">{notice}</p>}
  </Dialog>;
}

export function NativeAgentPanel({ sessionId, agents, loadError, readOnly = false, onReviewPrompt }: {
  sessionId: string; agents?: NativeAgentSnapshot; loadError?: string; readOnly?: boolean; onReviewPrompt?: (text: string, parentTaskId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false), [selection, setSelection] = useState<{ sessionId: string; parentRunId: string; childId: string }>();
  useEffect(() => { setSelection(undefined); setExpanded(false); }, [sessionId, agents?.parentRunId]);
  if (!agents?.items.length && !agents?.incomplete) return null;
  const retained = agents.items.slice(0, 16), visible = expanded ? retained : retained.slice(0, 4);
  const omitted = agents.omitted + Math.max(0, agents.items.length - 16);
  const selected = selection?.sessionId === sessionId && selection.parentRunId === agents.parentRunId ? retained.find(agent => agent.childId === selection.childId) : undefined;
  return <section className="native-agent-panel" aria-label="Native Agent 协作">
    {selected && <ResultDialog key={`${sessionId}:${agents.parentRunId}:${selected.childId}`} sessionId={sessionId} agent={selected} readOnly={readOnly || !!loadError} onReviewPrompt={onReviewPrompt} onClose={() => setSelection(undefined)}/>}
    <details open><summary>子 Agent（{agents.items.length}）</summary>
      <p className="native-agent-note">子 Agent 执行完成后，结果、命令回执及隔离工作区保留供审阅；任务验收需另行确认。</p>
      {(agents.incomplete || loadError) && <p className="native-agent-warning" role="alert">{loadError ? `当前状态未知：${loadError}。` : '部分子 Agent 记录无法读取或校验。'}请核查保存的执行回执。</p>}
      {visible.map(agent => <Agent key={agent.childId} agent={agent} loadError={loadError} onRead={() => setSelection({ sessionId, parentRunId: agents.parentRunId, childId: agent.childId })}/>)}
      {retained.length > 4 && <button type="button" className="secondary compact native-agent-read" onClick={() => setExpanded(value => !value)}>{expanded ? '仅显示最近 4 项' : `查看全部子 Agent（${retained.length}）`}</button>}
      {omitted > 0 && <p className="native-agent-note">另有 {omitted} 个结果保留在父回合记录中。</p>}
      {omitted > 0 && <Reference id={`native-agent-history-${agents.parentRunId}`} label="父回合子 Agent 记录目录" value={agents.receiptDirectory}/>}
    </details>
  </section>;
}
