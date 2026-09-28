import { useId, useState } from 'react';
import { getNativeTaskCriterionVerification, type NativeTaskEvidence, type NativeTaskView, type NativeTaskStepStatus, type NativeTaskVerification } from '@cc-desk/contracts/native-task';
import type { NativeTaskReviewInput } from '../shared/native-task';

export interface NativeTaskPanelProps {
  task: NativeTaskView | null;
  loading?: boolean;
  historical?: boolean;
  loadError?: string;
  disabled?: boolean;
  busy?: boolean;
  onContinue?(taskId: string): void;
  onRefresh?(): void;
  onReview?(input: NativeTaskReviewInput): Promise<void>;
}

const stepLabels: Record<NativeTaskStepStatus, string> = {
  pending: '待办', in_progress: '进行中', implemented: '模型声明已实现', blocked: '受阻', interrupted: '已中断，待核查',
};
const verificationLabels: Record<NativeTaskVerification, string> = {
  unverified: '未验证', verifying: '验证中', passed: '验收通过', failed: '验证失败', not_applicable: '不适用', stale: '证据已过期',
};
const outcomeLabels: Record<string, string> = {
  completed: '本轮正常结束', model_completed: '本轮正常结束', cancelled: '本轮已取消', failed: '本轮执行失败',
  budget_exhausted: '预算已用尽', recovery_required: '需要核查执行现场', interrupted: '本轮已中断',
};

/** A historical or incomplete receipt must never acquire a passing presentation. */
export function nativeTaskEvidenceState(task: NativeTaskView, evidence: NativeTaskEvidence): NativeTaskVerification {
  if (evidence.stale || evidence.planRevision !== task.planRevision || evidence.acceptanceRevision !== task.acceptanceRevision
    || (task.workspace && evidence.workspaceFingerprint !== task.workspace.current.fingerprint)) return 'stale';
  if (!evidence.workspaceComplete || (task.workspace && !task.workspace.current.complete)) return 'unverified';
  // A successful command is a receipt, not an acceptance decision. Only explicit human review can pass a criterion.
  if (evidence.source === 'command') return evidence.status === 'failed' || (typeof evidence.exitCode === 'number' && evidence.exitCode !== 0) ? 'failed' : 'unverified';
  if (!evidence.reason?.trim()) return 'unverified';
  return evidence.status;
}

function criterionState(task: NativeTaskView, criterionId: string): NativeTaskVerification {
  return getNativeTaskCriterionVerification(task, criterionId);
}

export function nativeTaskCanApprove(task: NativeTaskView): boolean {
  return task.execution !== 'active' && !!task.workspace?.current.complete && task.criteria.length > 0
    && task.steps.every(step => step.status === 'implemented')
    && task.criteria.every(criterion => ['passed', 'not_applicable'].includes(criterionState(task, criterion.id)));
}

function Evidence({ task, evidence, unknown }: { task: NativeTaskView; evidence: NativeTaskEvidence; unknown: boolean }) {
  const status = unknown ? 'unverified' : nativeTaskEvidenceState(task, evidence);
  return <details className="native-task-evidence" data-evidence-status={status}>
    <summary><span>{evidence.source === 'command' ? '宿主命令回执' : '人工核验'}</span><span className={'native-task-state ' + status}>{unknown ? '当前状态未知' : verificationLabels[status]}</span></summary>
    <div className="native-task-evidence-body">
      <p>关联条件：{evidence.criterionIds.length ? evidence.criterionIds.join('、') : '尚未关联'} · 步骤：{evidence.stepIds.length ? evidence.stepIds.join('、') : '尚未关联'}</p>
      {evidence.command && <><p>程序：<code>{evidence.command.executable}</code></p><p>参数：<code>{JSON.stringify(evidence.command.argv)}</code></p><p>工作目录：<code>{evidence.command.cwd}</code></p></>}
      {evidence.source === 'command' && <p>退出码：{evidence.exitCode === undefined || evidence.exitCode === null ? '未知' : evidence.exitCode} · 工具调用：<code>{evidence.toolCallId || '未记录'}</code></p>}
      {evidence.reason && <p>核验说明：{evidence.reason}</p>}
      <p>来源回合：<code>{evidence.identity.runId}</code> · 计划版本 {evidence.planRevision} · 条件版本 {evidence.acceptanceRevision}</p>
      <p>现场指纹：<code>{evidence.workspaceFingerprint || '未记录'}</code> · {evidence.workspaceComplete ? '声明范围内已完整记录' : '现场记录不完整'}</p>
      {status === 'stale' && <p className="native-task-warning">计划、验收条件或文件版本已变化，此证据不计入当前验收。</p>}
      {evidence.source === 'command' && <p>命令执行结果仅供核验，退出码为 0 不代表任务验收通过。</p>}
      {evidence.truncated && <p className="native-task-warning">命令输出已截断，当前日志不完整。</p>}
      {evidence.output !== undefined && <pre aria-label="证据日志">{evidence.output || '（无输出）'}</pre>}
      {evidence.outputDigest && <p>输出摘要：<code>{evidence.outputDigest}</code></p>}
      <time dateTime={evidence.createdAt}>{evidence.createdAt}</time>
    </div>
  </details>;
}

function Review({ task, disabled, onReview }: { task: NativeTaskView; disabled: boolean; onReview: NonNullable<NativeTaskPanelProps['onReview']> }) {
  const fieldId = useId();
  const [criterionId, setCriterionId] = useState(task.criteria[0]?.id || '');
  const [decision, setDecision] = useState<NativeTaskReviewInput['decision']>(task.criteria.length ? 'passed' : 'approve');
  const [reason, setReason] = useState(''), [pending, setPending] = useState(false), [error, setError] = useState('');
  const ready = !disabled && !pending && task.execution !== 'active' && !!task.workspace?.current.complete;
  const canApprove = nativeTaskCanApprove(task);
  const submit = async () => {
    if (!ready || !reason.trim() || (decision === 'approve' && !canApprove)) return;
    const input: NativeTaskReviewInput = {
      taskId: task.taskId, expectedRevision: task.revision, expectedWorkspaceFingerprint: task.workspace!.current.fingerprint,
      decision, ...(criterionId ? { criterionId } : {}), reason: reason.trim(),
    };
    setPending(true); setError('');
    try { await onReview(input); setReason(''); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '保存核验失败，请刷新任务状态后重试。'); }
    finally { setPending(false); }
  };
  return <details className="native-task-review"><summary>人工核验与任务验收</summary>
    <p>请先检查实际改动和证据，再逐项记录核验结果。每项确认与当前计划、条件和文件版本绑定。</p>
    <label htmlFor={fieldId + '-scope'}>核验范围</label>
    <select id={fieldId + '-scope'} disabled={!ready} value={criterionId} onChange={event => {
      setCriterionId(event.target.value); setDecision(event.target.value ? 'passed' : 'approve'); setError('');
    }}><option value="">整个任务</option>{task.criteria.map(criterion => <option key={criterion.id} value={criterion.id}>{criterion.id}：{criterion.description}</option>)}</select>
    <label htmlFor={fieldId + '-decision'}>核验结果</label>
    <select id={fieldId + '-decision'} disabled={!ready} value={decision} onChange={event => setDecision(event.target.value as NativeTaskReviewInput['decision'])}>
      {criterionId ? <><option value="passed">人工确认此条件通过</option><option value="failed">此条件未通过</option><option value="not_applicable">此条件不适用（需说明）</option></>
        : <><option value="approve" disabled={!canApprove}>确认任务验收</option><option value="reject">任务验收未通过</option></>}
    </select>
    {!canApprove && <p className="native-task-warning">任务验收条件尚未满足。需模型声明步骤已实现，并对所有条件逐项核验；缺少、过期或失败的证据不能直接通过整体验收。</p>}
    {task.execution === 'active' && <p>本轮仍在运行，结束后才能提交人工核验。</p>}
    {!task.workspace?.current.complete && <p className="native-task-warning">现场版本尚未完整记录，暂不能提交人工核验。</p>}
    <label htmlFor={fieldId + '-reason'}>核验依据或不适用理由（必填，最多 2000 字）</label>
    <textarea id={fieldId + '-reason'} value={reason} maxLength={2000} rows={3} disabled={!ready} placeholder="说明检查了哪些改动、日志或操作，以及判断依据。" onChange={event => setReason(event.target.value)} />
    <button type="button" className="secondary compact" disabled={!ready || !reason.trim() || (decision === 'approve' && !canApprove)} onClick={() => void submit()}>{pending ? '正在保存核验…' : criterionId ? '记录人工核验' : decision === 'approve' ? '确认任务验收' : '记录任务未通过'}</button>
    {error && <p className="native-task-warning" role="alert">{error}</p>}
  </details>;
}

export function NativeTaskPanel({ task, loading = false, historical = false, loadError, disabled = false, busy = false, onContinue, onRefresh, onReview }: NativeTaskPanelProps) {
  if (!task && !loading && !loadError) return null;
  const unknown = !!loadError;
  const locked = disabled || busy || loading || unknown;
  return <section className="native-task-panel" aria-label="Native 任务计划与验收" aria-busy={loading || busy}>
    <div className="native-task-heading"><strong>任务计划与验收</strong>{onRefresh && <button type="button" className="secondary compact" disabled={loading || busy} onClick={onRefresh}>{loading ? '正在同步…' : '刷新状态'}</button>}</div>
    {loadError && <p className="native-task-warning" role="alert">任务状态未知：{loadError}。请重新读取状态；下面如有记录，仅为上次保存的快照。</p>}
    {!task && <p role="status">{loading ? '正在读取已保存的任务…' : '暂时无法读取任务记录。'}</p>}
    {task && <>
      <p className="native-task-goal">{task.goal}</p>
      {historical && <p className="native-task-warning" role="note">较早任务，未关联当前回合。可显式继续此任务或复核已有记录。</p>}
      <div className="native-task-overview" role="status" aria-live="polite" aria-atomic="true">
        <span>{historical ? '任务最近运行：' : '运行：'}{unknown ? '当前状态未知' : task.execution === 'active' ? '本轮运行中' : task.execution === 'interrupted' ? '本轮已中断，待核查' : outcomeLabels[task.runOutcome || ''] || '本轮已结束'}</span>
        <span>实现声明：{task.steps.filter(step => step.status === 'implemented').length} / {task.steps.length} 步</span>
        <span className={'native-task-state ' + (unknown ? 'unverified' : task.verification)}>验证：{unknown ? '当前状态未知' : verificationLabels[task.verification]}</span>
      </div>
      <p className="native-task-note">运行结束、模型声明已实现和验收通过分别记录；简单问答无需任务计划。</p>
      <details className="native-task-content" open><summary>步骤与验收条件</summary>
        <ol className="native-task-steps">{task.steps.map(step => <li key={step.id} data-step-status={step.status}>
          <div><strong>{step.title}</strong><span className={'native-task-state ' + step.status}>{stepLabels[step.status]}</span></div>
          <small>步骤 {step.id}{step.dependsOn.length > 0 && <> · 依赖：{step.dependsOn.map(id => task.steps.find(item => item.id === id)?.title || id).join('、')}</>}</small>
          {step.blockedReason && <p className="native-task-warning">阻塞原因：{step.blockedReason}</p>}
        </li>)}</ol>
        <ul className="native-task-criteria">{task.criteria.map(criterion => {
          const status = unknown ? 'unverified' : criterionState(task, criterion.id);
          return <li key={criterion.id}><div><strong>{criterion.description}</strong><span className={'native-task-state ' + status}>{unknown ? '当前状态未知' : verificationLabels[status]}</span></div><small>条件 {criterion.id} · {criterion.kind === 'manual' ? '人工检查' : '命令检查'} · 关联步骤：{criterion.stepIds.join('、') || '无'}</small></li>;
        })}</ul>
        {!task.criteria.length && <p className="native-task-note">未记录验收条件，不能确认整体验收通过。</p>}
      </details>
      <details className="native-task-content"><summary>验证证据（{task.evidence.length}）</summary>
        {task.evidence.length ? task.evidence.map(evidence => <Evidence key={evidence.id} task={task} evidence={evidence} unknown={unknown} />) : <p className="native-task-note">未记录验证证据。模型的完成声明不构成验证结果。</p>}
      </details>
      {task.workspace && <details className="native-task-content"><summary>任务期间观察到的文件变化</summary>
        <p className="native-task-note">此摘要可能包含外部修改，不代表全部由 Agent 产生。完整性仅针对声明的扫描范围，不执行撤销。</p>
        <p>新增 {task.workspace.changes.added.length} · 修改 {task.workspace.changes.modified.length} · 删除 {task.workspace.changes.removed.length}</p>
        {(['added', 'modified', 'removed'] as const).map(kind => task.workspace!.changes[kind].length > 0 && <ul key={kind} className="native-task-files" aria-label={{ added: '新增文件', modified: '修改文件', removed: '删除文件' }[kind]}>{task.workspace!.changes[kind].map(path => <li key={path}><span>{{ added: '新增', modified: '修改', removed: '删除' }[kind]}</span><code>{path}</code></li>)}</ul>)}
        {(!task.workspace.changes.complete || task.workspace.changes.truncated) && <p className="native-task-warning">变更摘要不完整或已截断，不能据此认定没有其他变化。</p>}
        <p>记录文件：起始 {task.workspace.baseline.fileCount} 项 · 当前 {task.workspace.current.fileCount} 项</p>
        <p>扫描范围：{task.workspace.current.scope.join('；') || '未记录'}</p>
        {task.workspace.current.issues.length > 0 && <ul className="native-task-warning">{task.workspace.current.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
      </details>}
      {task.review && <p className="native-task-note">最近任务复核：{unknown || task.verification === 'stale' ? '当前有效性待核查' : task.review.status === 'approved' ? '人工确认' : '人工判定未通过'} · {task.review.reason}</p>}
      {onReview && <Review key={`${task.identity.sessionId}:${task.taskId}:${task.revision}:${task.workspace?.current.fingerprint || ''}`} task={task} disabled={locked} onReview={onReview} />}
      <details className="native-task-content"><summary>计划与状态修订记录（{task.history.length}）</summary><ol className="native-task-history">{task.history.map(entry => <li key={entry.revision}><span>修订 {entry.revision} · {entry.summary}</span><small>回合 {entry.runId} · <time dateTime={entry.at}>{entry.at}</time></small></li>)}</ol></details>
      <div className="native-task-footer"><small>任务 {task.taskId} · 修订 {task.revision} · 计划 {task.planRevision} · 条件 {task.acceptanceRevision}</small>{onContinue && <button type="button" className="secondary compact" disabled={locked || task.execution === 'active'} onClick={() => onContinue(task.taskId)}>继续此任务</button>}</div>
      {onContinue && <p className="native-task-note">“继续此任务”只关联下一条指令；发送后才运行，不自动重放已有工具。</p>}
    </>}
  </section>;
}
