import { useState, type MouseEvent } from 'react';
import type { NativeAgentSnapshot, NativeAgentView } from '../shared/chat';

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
function Agent({ agent, loadError }: { agent: NativeAgentView; loadError?: string }) {
  const status = loadError ? 'unknown' : agent.status;
  const links = [{ kind: 'task', label: '子任务' }, { kind: 'run', label: '执行回合' }, { kind: 'receipt', label: '执行回执' },
    ...(agent.worktree ? [{ kind: 'worktree', label: '隔离工作区' }] : []), ...(agent.artifact ? [{ kind: 'patch', label: '文件差异' }] : [])];
  return <details className="native-agent-entry" data-agent-id={agent.childId} data-agent-status={status}>
    <summary><strong>{agent.title}</strong><span>{agent.mode === 'review' ? '只读审阅' : '隔离实现'}</span><span className={`native-agent-state ${status}`}>{labels[status]}</span></summary>
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
      <Reference id={referenceId(agent.childId, 'worktree-branch')} label="成果分支" value={agent.worktree.branch}/>
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

export function NativeAgentPanel({ agents, loadError }: { agents?: NativeAgentSnapshot; loadError?: string }) {
  if (!agents?.items.length && !agents?.incomplete) return null;
  return <section className="native-agent-panel" aria-label="Native Agent 协作">
    <details open><summary>子 Agent（{agents.items.length}）</summary>
      <p className="native-agent-note">子 Agent 执行完成后，结果、命令回执及隔离工作区保留供审阅；任务验收需另行确认。</p>
      {(agents.incomplete || loadError) && <p className="native-agent-warning" role="alert">{loadError ? `当前状态未知：${loadError}。` : '部分子 Agent 记录无法读取或校验。'}请核查保存的执行回执。</p>}
      {agents.items.map(agent => <Agent key={agent.childId} agent={agent} loadError={loadError}/>)}
      {agents.omitted > 0 && <p className="native-agent-note">仅显示最近 {agents.items.length} 个子 Agent（运行中的优先），另有 {agents.omitted} 个结果保留在父回合记录中。</p>}
      {agents.omitted > 0 && <Reference id={`native-agent-history-${agents.parentRunId}`} label="父回合子 Agent 记录目录" value={agents.receiptDirectory}/>}
    </details>
  </section>;
}
