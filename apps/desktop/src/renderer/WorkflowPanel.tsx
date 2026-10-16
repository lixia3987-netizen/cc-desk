import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Check, ChevronRight, Loader2, Play, Plus, RefreshCw, Square, Trash2 } from 'lucide-react';
import type { Session } from '../shared/types';
import { DEFAULT_WORKFLOW_STAGES, NATIVE_WORKFLOW_POLICIES_ENABLED, type WorkflowGate, type WorkflowNativeReceipt, type WorkflowRun, type WorkflowToolPolicy } from '../shared/workflows';
import { PendingAction, type PendingActionState } from './pending-action';
import { paintActionFeedback } from './action-feedback';
import { MessageText } from './MessageText';
import type { UpdateDraft, WorkflowDraft } from '../shared/panel-drafts';

const labels: Record<string, string> = { draft: '待开始', running: '执行中', paused: '等待继续', waiting_verification: '等待验收', waiting_confirmation: '等待确认', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断', pending: '待执行' };
const gates: Record<WorkflowGate, string> = { none: '执行结束后继续', manual: '人工确认产出', native_task: '检查任务验收条件' };

export function WorkflowReceiptDetails({ receipt }: { receipt: WorkflowNativeReceipt }) {
  return <details><summary>执行成果与验证记录</summary>
    <p className="panel-note">模型请求 {receipt.usage.modelRequests} 次 · 工具调用 {receipt.usage.toolCalls} 次 · 执行 {(receipt.usage.activeMs / 60_000).toFixed(1)} 分钟</p>
    {receipt.workspace && <p className="panel-note">工作区核查：{receipt.workspace.complete ? '已记录文件指纹' : '范围不完整'}。这些是本次执行的历史记录，验收时会重新核查。</p>}
    {receipt.changes && <p className="panel-note">新增 {receipt.changes.added.length} 个文件 · 修改 {receipt.changes.modified.length} 个文件 · 删除 {receipt.changes.removed.length} 个文件{receipt.changes.truncated ? '（列表已截断）' : ''}</p>}
    {receipt.changes && <ul>{[...receipt.changes.added, ...receipt.changes.modified, ...receipt.changes.removed].map((file, index) => <li key={index}>{file}</li>)}</ul>}
    {receipt.criteria.length > 0 && <><strong>验收条件</strong><ul>{receipt.criteria.map(criterion => <li key={criterion.id}>{criterion.description}</li>)}</ul></>}
    {receipt.evidence.length > 0 && <><strong>证据引用</strong><ul>{receipt.evidence.map(evidence => <li key={evidence.id}>{evidence.command ? [evidence.command.executable, ...evidence.command.argv].join(' ') : evidence.source === 'manual' ? '人工复核' : '代码位置'} · {evidence.status === 'passed' ? '已确认通过' : evidence.status === 'failed' ? '失败' : evidence.status === 'not_applicable' ? '不适用' : '未验证'}{evidence.exitCode !== undefined ? ` · 退出码 ${evidence.exitCode ?? '未知'}` : ''}{evidence.stale ? ' · 已过期' : ''}{evidence.truncated ? ' · 日志截断' : ''}</li>)}</ul></>}
    {receipt.truncated && <p className="panel-note">成果记录已截断，请结合任务面板和完整执行记录核查。</p>}
    <details><summary>任务与执行标识</summary><p className="panel-note">任务：{receipt.taskId ?? '未建立任务计划'}<br />执行：{receipt.identity.runId}</p></details>
  </details>;
}

export function WorkflowPanel({ session, onError, onTemplate, draft, onDraft, disabled = false, executionBlocked }: { disabled?: boolean; executionBlocked?: (run: WorkflowRun) => boolean; session: Session; onError: (error: unknown) => void; onTemplate: (value: string) => boolean; draft: WorkflowDraft; onDraft: UpdateDraft<WorkflowDraft> }) {
  const [runs, setRuns] = useState<WorkflowRun[]>([]), [deleteId, setDeleteId] = useState(''), [notice, setNotice] = useState('');
  const [confirmationReasons, setConfirmationReasons] = useState<Record<string, string>>({});
  const operation = useRef(new PendingAction()), mounted = useRef(true), refreshingRef = useRef(false), needsSync = useRef(false), reads = useRef(0);
  const [pending, setPending] = useState<PendingActionState>(), [refreshing, setRefreshing] = useState(true), [actionError, setActionError] = useState(''), [syncRequired, setSyncRequired] = useState(false);
  const busy = !!pending || syncRequired || refreshing;
  const [creating, setCreating] = useState(false), [showHistory, setShowHistory] = useState(false);
  const { goal, pauseAfterEachStage: pause, maxAttempts: attempts, editing, instructions, allRuns } = draft;
  const instruction = instructions[editing] ?? '';
  const native = session.execution.providerId === 'native';
  const setInstruction = (value: string) => onDraft(current => ({ ...current, instructions: { ...current.instructions, [editing]: value } }));
  const editStage = (key: string, fallback: string) => onDraft(current => ({ ...current, editing: key, instructions: { ...current.instructions, [key]: current.instructions[key] ?? fallback } }));
  const saveInstruction = async (runId: string, stageId: string) => {
    const key = runId + ':' + stageId;
    await window.desktop.reviseWorkflowStage(runId, stageId, instruction);
    onDraft(current => {
      if (current.instructions[key] !== instruction) return current;
      const instructions = { ...current.instructions }; delete instructions[key];
      return { ...current, instructions, editing: current.editing === key ? '' : current.editing };
    });
  };
  const seq = useRef(0);
  const load = useCallback(async () => {
    const request = ++seq.current; reads.current++; if (mounted.current) setRefreshing(true);
    try { const value = await window.desktop.workflows(allRuns ? undefined : session.id); if (mounted.current && request === seq.current) { setRuns(value); needsSync.current = false; setSyncRequired(false); } }
    finally { reads.current--; if (mounted.current && reads.current === 0) setRefreshing(false); }
  }, [session.id, allRuns]);
  const failure = useCallback((error: unknown) => { if (mounted.current) setActionError(error instanceof Error ? error.message : String(error)); onError(error); }, [onError]);
  useEffect(() => {
    mounted.current = true; setRuns([]); setActionError('');
    void load().catch(failure); const off = window.desktop.onWorkflows(() => void load().catch(failure));
    return () => { mounted.current = false; seq.current++; off(); };
  }, [load, failure]);
  const refresh = async () => {
    if (refreshingRef.current || operation.current.state || reads.current > 0) return;
    refreshingRef.current = true; setRefreshing(true); setActionError('');
    try { await paintActionFeedback(); await load(); } catch (error) { failure(error); }
    finally { refreshingRef.current = false; if (mounted.current) setRefreshing(false); }
  };
  const act = async (action: () => Promise<unknown>, label = '正在处理工作流…', key = session.id, paint = true) => {
    if (operation.current.state || refreshingRef.current || reads.current > 0 || needsSync.current) return;
    setActionError(''); let accepted = false;
    try { await operation.current.run({ key, label }, async () => { await action(); accepted = true; needsSync.current = true; if (mounted.current) setSyncRequired(true); await load(); }, value => { if (mounted.current) setPending(value); }, paint ? undefined : () => Promise.resolve()); }
    catch (error) {
      if (accepted) { needsSync.current = true; if (mounted.current) { setSyncRequired(true); setActionError('操作已提交，工作流状态尚未同步。请刷新工作流确认结果。'); } onError(error); }
      else failure(error);
    }
  };
  const actionLabel = (key: string, label: string) => pending?.key === key ? <><Loader2 size={12} className="spin" />{pending.label}</> : label;
  const stageDefinitions = DEFAULT_WORKFLOW_STAGES.map(stage => ({ ...stage,
    gate: draft.stageGates?.[stage.id] ?? 'none' as WorkflowGate,
    toolPolicy: native && NATIVE_WORKFLOW_POLICIES_ENABLED ? draft.stageToolPolicies?.[stage.id] ?? stage.toolPolicy ?? 'standard' : 'standard' as WorkflowToolPolicy,
  }));
  const activeStatuses = ['draft', 'running', 'paused', 'waiting_verification', 'waiting_confirmation', 'interrupted', 'failed'];
  const activeRuns = runs.filter(run => activeStatuses.includes(run.status));
  const historyRuns = runs.filter(run => !activeStatuses.includes(run.status));
  const visibleRuns = showHistory ? historyRuns : activeRuns;
  return <div className="panel-content">
    <div className="panel-heading"><strong>{creating ? '新建工作流' : '阶段工作流'}</strong>{creating ? <button className="text-button" disabled={busy} onClick={() => setCreating(false)}>返回工作流列表</button> : <><button className="secondary compact" disabled={session.archived || busy} onClick={() => setCreating(true)}><Plus size={13} />新建工作流</button><button className="icon-button" title="刷新工作流" disabled={refreshing || !!pending} onClick={() => void refresh()}><RefreshCw size={14} className={refreshing ? 'spin' : undefined} /></button></>}</div>
    {!creating && <><label className="inline-checkbox"><input type="checkbox" disabled={busy} checked={allRuns} onChange={event => { onDraft(current => ({ ...current, allRuns: event.target.checked })); setDeleteId(''); }} />全部工作流记录</label>
      <div className="workflow-list-tabs" role="group" aria-label="工作流记录范围"><button className="secondary compact" aria-pressed={!showHistory} onClick={() => setShowHistory(false)}>进行中与待处理（{activeRuns.length}）</button><button className="secondary compact" aria-pressed={showHistory} onClick={() => setShowHistory(true)}>已结束（{historyRuns.length}）</button></div></>}
    {(pending || refreshing) && <p className="panel-note" role="status" aria-live="polite">{pending?.label ?? '正在读取工作流…'}</p>}
    {actionError && <p className="chat-error" role="alert">{actionError}</p>}
    {notice && <p className="panel-note" role="status">{notice}</p>}
    <div className="workflow-create-view" hidden={!creating}>{session.execution.mode !== 'structured' ? <><p className="panel-note">自动阶段执行需要结构化会话。终端会话可以使用以下提示词。</p><button className="secondary compact full" onClick={() => onTemplate('请完成以下任务：\n\n【填写目标】\n\n按规划、实现、验证三个阶段执行；阅读项目规范，检查当前改动，完成实现并运行相关测试，最后报告结果与剩余问题。')}>添加完整开发提示词</button></> :
      <form className="workflow-create" onSubmit={event => { event.preventDefault(); if (disabled || busy) return; void act(async () => {
        await window.desktop.createWorkflow({ sessionId: session.id, goal, pauseAfterEachStage: pause, maxAttempts: attempts,
          ...(native || Object.values(draft.stageGates ?? {}).some(value => value !== 'none') ? { stages: stageDefinitions } : {}),
        }); onDraft(current => current.goal === goal ? { ...current, goal: '' } : current); setCreating(false); setShowHistory(false);
      }, '正在创建工作流…', `create:${session.id}`); }}>
        <textarea aria-label="工作流目标" placeholder="这次工作要交付什么？" value={goal} onChange={event => onDraft(current => ({ ...current, goal: event.target.value }))} maxLength={20000} />
        {stageDefinitions.map(stage => <div className="workflow-stage" key={stage.id}><div><strong>{stage.title}</strong>
          <label>阶段结束后<select aria-label={`${stage.title}验收门槛`} value={stage.gate} onChange={event => onDraft(current => ({ ...current, stageGates: { ...current.stageGates, [stage.id]: event.target.value as WorkflowGate } }))}>
            <option value="none">{gates.none}</option><option value="manual">{gates.manual}</option>{native && <option value="native_task">{gates.native_task}</option>}
          </select></label>
          {native && NATIVE_WORKFLOW_POLICIES_ENABLED && <label>工具权限<select aria-label={`${stage.title}工具权限`} value={stage.toolPolicy} onChange={event => onDraft(current => ({ ...current, stageToolPolicies: { ...current.stageToolPolicies, [stage.id]: event.target.value as WorkflowToolPolicy } }))}><option value="read_only">严格只读</option><option value="standard">按会话审批执行</option></select></label>}
        </div></div>)}
        <label className="inline-checkbox"><input type="checkbox" checked={pause} onChange={event => onDraft(current => ({ ...current, pauseAfterEachStage: event.target.checked }))} />每阶段结束后由我确认继续</label>
        <label>每阶段最多尝试<select aria-label="最大尝试次数" value={attempts} onChange={event => onDraft(current => ({ ...current, maxAttempts: Number(event.target.value) }))}><option value={1}>1 次</option><option value={2}>2 次</option><option value={3}>3 次</option></select></label>
        {native && <p className="panel-note">主 Agent 不限制执行时长、模型请求或工具调用次数。每个子 Agent 独立使用设置中的执行限制。</p>}
        <button className="primary compact full" disabled={disabled || busy || !goal.trim() || session.archived}>{actionLabel(`create:${session.id}`, '创建工作流')}</button>
        <p className="panel-note">规划 → 实现 → 审阅。执行成功与验收通过分别记录；验收等待不会重新执行。失败后由你发起重试。{native && NATIVE_WORKFLOW_POLICIES_ENABLED ? '规划与审阅默认严格只读。' : '阶段继承当前会话权限，规划指令不会强制只读。'}</p>
        <button type="button" className="secondary compact full" disabled={busy} onClick={() => setCreating(false)}>返回列表并保留草稿</button>
      </form>}</div>
    {!creating && !refreshing && !actionError && !visibleRuns.length && <p className="panel-note">{showHistory ? '暂无已结束的工作流。' : '暂无正在运行或等待处理的工作流。可新建工作流，按阶段推进任务。'}</p>}
    {!creating && visibleRuns.map(run => <section className="workflow-run" key={run.id}>
      <header><strong>{run.title}</strong><span className={'status-tag ' + (run.status === 'running' ? 'running' : '')}>{labels[run.status] ?? run.status}</span></header><p className="workflow-goal">{run.goal}</p>
      {run.error && <p className="chat-error">{run.error}</p>}
      {run.usage && <p className="panel-note">累计模型请求 {run.usage.modelRequests} · 工具调用 {run.usage.toolCalls} · 执行 {(run.usage.activeMs / 60_000).toFixed(1)} 分钟{!run.usage.complete ? ' · 用量不完整，需核查执行记录' : ''}</p>}
      {run.providerId === 'native' && run.budget && <p className="panel-note">此记录中的旧版工作流累计预算已停用；主 Agent 不再受其限制。</p>}
      <div className="workflow-stages">{run.stages.map((stage, index) => {
        const key = run.id + ':' + stage.id, reason = confirmationReasons[key] ?? '';
        const blocked = disabled || busy || executionBlocked?.(run);
        return <div className={'workflow-stage ' + stage.status} key={stage.id}><div className="stage-number">{stage.status === 'completed' ? <Check size={12} /> : stage.status === 'running' ? <Loader2 size={12} className="spin" /> : index + 1}</div><div>
          <strong>{stage.title}</strong><small>{labels[stage.status]} · {stage.attempts} / {stage.maxAttempts} 次 · {gates[stage.gate ?? 'none']}{stage.toolPolicy === 'read_only' ? ' · 严格只读' : ''}</small>
          {stage.error && <p className="chat-error">{stage.error}</p>}{stage.gateReason && <p className="panel-note">{stage.gateReason}</p>}
          {stage.artifacts.map(artifact => <details key={artifact.id}><summary>{artifact.title}</summary><MessageText text={artifact.content} /></details>)}
          {stage.nativeReceipts?.map(receipt => <WorkflowReceiptDetails receipt={receipt} key={receipt.identity.runId} />)}
          {stage.status === 'waiting_verification' && <><p className="panel-note">请在任务面板复核验收条件，再检查此阶段。检查只读取证据，不会重新调用模型或执行工具。</p><button className="secondary compact" disabled={blocked} onClick={() => void act(() => window.desktop.verifyWorkflowStage({ id: run.id, stageId: stage.id, expectedAttempt: stage.attempts }), '正在检查阶段验收…', `verify:${key}`)}>检查阶段验收</button></>}
          {stage.status === 'waiting_confirmation' && <div><textarea aria-label={`${stage.title}确认理由`} placeholder="核查了哪些产出，为什么通过或不予确认？" maxLength={4000} value={reason} onChange={event => setConfirmationReasons(current => ({ ...current, [key]: event.target.value }))} />
            <button className="primary compact" disabled={blocked || !reason.trim()} onClick={() => void act(() => window.desktop.confirmWorkflowStage({ id: run.id, stageId: stage.id, expectedAttempt: stage.attempts, decision: 'approve', reason }), '正在确认阶段产出…', `approve:${key}`)}>确认阶段产出</button>
            <button className="secondary compact" disabled={blocked || !reason.trim()} onClick={() => void act(() => window.desktop.confirmWorkflowStage({ id: run.id, stageId: stage.id, expectedAttempt: stage.attempts, decision: 'reject', reason }), '正在保存确认结果…', `reject:${key}`)}>不予确认</button>
          </div>}
          {editing === key ? <div><textarea aria-label="阶段指令" maxLength={20000} value={instruction} onChange={event => setInstruction(event.target.value)} /><button className="secondary compact" disabled={busy} onClick={() => onDraft(current => ({ ...current, editing: '' }))}>取消</button><button className="primary compact" disabled={disabled || busy || !instruction.trim()} onClick={() => void act(() => saveInstruction(run.id, stage.id), '正在保存阶段指令…', `instruction:${key}`)}>保存指令</button></div> : ['pending', 'failed', 'interrupted'].includes(stage.status) && !['running', 'cancelled', 'completed'].includes(run.status) && <button className="text-button" disabled={disabled} onClick={() => editStage(key, stage.instruction)}>编辑阶段指令</button>}
        </div></div>;
      })}</div>
      {run.stages.some(stage => ['failed', 'interrupted'].includes(stage.status) && stage.attempts >= stage.maxAttempts) && <p className="panel-note">执行次数已用完，请检查结果后新建工作流。</p>}
      <div className="panel-actions">
        {run.status === 'draft' && <button className="primary compact" disabled={disabled || busy || executionBlocked?.(run)} onClick={() => void act(() => window.desktop.startWorkflow(run.id), '正在启动工作流…', `start:${run.id}`)}><Play size={12} />{actionLabel(`start:${run.id}`, '开始')}</button>}
        {['paused', 'interrupted'].includes(run.status) && <button className="primary compact" disabled={disabled || busy || executionBlocked?.(run) || run.stages.some(stage => stage.status === 'interrupted' && stage.attempts >= stage.maxAttempts)} onClick={() => void act(() => window.desktop.continueWorkflow(run.id), '正在继续工作流…', `continue:${run.id}`)}><ChevronRight size={12} />{actionLabel(`continue:${run.id}`, '继续')}</button>}
        {run.status === 'failed' && <button className="secondary compact" disabled={disabled || busy || executionBlocked?.(run) || run.stages.some(stage => stage.status === 'failed' && stage.attempts >= stage.maxAttempts)} onClick={() => void act(() => window.desktop.retryWorkflow(run.id), '正在重试失败阶段…', `retry:${run.id}`)}><RefreshCw size={12} />{actionLabel(`retry:${run.id}`, '重试失败阶段')}</button>}
        {!['completed', 'cancelled'].includes(run.status) && <button className="secondary compact" disabled={busy} onClick={() => void act(() => window.desktop.cancelWorkflow(run.id), '正在取消工作流…', `cancel:${run.id}`)}><Square size={11} />{actionLabel(`cancel:${run.id}`, '取消工作流')}</button>}
        {run.status !== 'running' && <><button className="secondary compact" disabled={busy} onClick={() => void act(async () => { const file = await window.desktop.exportWorkflow(run.id); if (file) setNotice('工作流记录已导出'); }, '正在导出工作流…', `export:${run.id}`, false)}><ArrowDownToLine size={12} />导出</button><button className="secondary compact danger" disabled={busy} onClick={() => setDeleteId(run.id)}><Trash2 size={12} />删除记录</button></>}
      </div>
      {deleteId === run.id && <div className="action-confirm"><p>删除这条工作流及其阶段结果。需要保留时请先导出。</p><button className="secondary compact" disabled={busy} onClick={() => setDeleteId('')}>保留</button><button className="secondary compact danger" disabled={busy} onClick={() => void act(async () => { await window.desktop.deleteWorkflow(run.id); onDraft(current => ({ ...current, editing: current.editing.startsWith(run.id + ':') ? '' : current.editing, instructions: Object.fromEntries(Object.entries(current.instructions).filter(([key]) => !key.startsWith(run.id + ':'))) })); setDeleteId(''); }, '正在删除工作流…', `delete:${run.id}`)}>{actionLabel(`delete:${run.id}`, '确认删除工作流')}</button></div>}
    </section>)}
  </div>;
}
