import type { NativeQualityFinding, NativeQualityReport, NativeQualityRole, NativeWorkflowQualityState } from '@cc-desk/contracts/native-workflow-quality';

const roleLabels: Record<NativeQualityRole, string> = { reviewer: '独立代码审阅', challenger: '独立反例检查', verifier: '隔离验证' };
const stateLabels = { pending: '等待审查', running: '审查中', changes_requested: '需要修复并重验', passed: '自动审查通过', blocked: '自动审查阻塞', cancelled: '已取消', unknown: '状态未知' };
const roleStateLabels = { pending: '待执行', running: '执行中', completed: '报告执行已结束', failed: '执行失败', cancelled: '已取消', unknown: '状态未知' };
const severityLabels = { blocking: '阻塞', high: '高', medium: '中', low: '低' };

function Finding({ finding }: { finding: NativeQualityFinding }) {
  return <details className={`native-quality-finding ${finding.severity}`}>
    <summary>{severityLabels[finding.severity]} · {finding.title} · {finding.id}</summary>
    <p>{finding.detail}</p><p>复现与检查：{finding.reproduction}</p>
    <ul>{finding.evidence.map((evidence, index) => <li key={`${evidence.toolCallId}:${evidence.path}:${index}`}><code>{evidence.path}:{evidence.startLine}–{evidence.endLine}</code><br />读取回执：<code>{evidence.toolCallId}</code> · 文件 SHA-256：<code>{evidence.fileHash}</code></li>)}</ul>
  </details>;
}

function Report({ report }: { report: NativeQualityReport }) {
  const declaration = report.declaration;
  return <>
    <p>审查者声明：{declaration.verdict === 'passed' ? '未发现待修复问题' : declaration.verdict === 'changes_requested' ? '要求修复' : '无法确认'}。声明由宿主核对材料与命令回执后用于自动审查。</p>
    <p>检查版本：<code>{report.snapshotCommit}</code></p>
    {report.deliveryDigest && <p>交付正文 SHA-256：<code>{report.deliveryDigest}</code></p>}
    {!!declaration.limitations.length && <><strong>验证限制</strong><ul>{declaration.limitations.map((value, index) => <li key={index}>{value}</li>)}</ul></>}
    {declaration.findings.map(finding => <Finding key={finding.id} finding={finding}/>)}
    {!!declaration.resolutions.length && <details><summary>此前问题的复核（{declaration.resolutions.length}）</summary>{declaration.resolutions.map((resolution, index) => <div key={`${resolution.findingId}:${index}`}>
      <p><code>{resolution.findingId}</code> · {resolution.status === 'resolved' ? '报告已复核修复' : resolution.status === 'unresolved' ? '仍未修复' : '无法确认'}：{resolution.explanation}</p>
      <ul>{resolution.evidence.map((evidence, index) => <li key={index}><code>{evidence.path}:{evidence.startLine}–{evidence.endLine}</code> · <code>{evidence.toolCallId}</code> · SHA-256 <code>{evidence.fileHash}</code></li>)}</ul>
    </div>)}</details>}
    <details><summary>宿主核对的材料与命令回执</summary>
      <p>实际材料读取 {report.materialReads.length} 项 · 命令回执 {report.commandReceipts.length} 项</p>
      <ul>{report.materialReads.map((read, index) => <li key={index}><code>{read.path}</code> · <code>{read.toolCallId}</code> · SHA-256 <code>{read.fileHash}</code></li>)}</ul>
      <ul>{report.commandReceipts.map(command => <li key={command.toolCallId}>命令 <code>{command.toolCallId}</code> · 退出码 {command.exitCode ?? '未知'} · {command.successful ? '执行成功' : '未确认成功'}</li>)}</ul>
      <p>验证方式声明：{declaration.verification.status === 'executed' ? '已执行命令' : declaration.verification.status === 'not_applicable' ? '命令不适用' : '未确认'} · {declaration.verification.reason}</p>
      <p>子回合：<code>{report.identity.runId}</code> · 子任务：<code>{report.taskId}</code></p>
    </details>
  </>;
}

/** 只展示宿主结构化记录；子任务完成、模型声明与人工验收分别呈现。 */
export function NativeWorkflowQualityPanel({ state, loadError, compact = false }: { state?: NativeWorkflowQualityState; loadError?: string; compact?: boolean }) {
  if (!state) return <p className="panel-note">此记录没有独立质量审查记录，无法据此确认自动审查通过。</p>;
  const status = loadError ? 'unknown' : state.status;
  return <section className={`native-workflow-quality${compact ? ' compact' : ''}`} aria-label="Native 工作流质量审查" data-quality-status={status}>
    <details open={!compact}><summary>独立质量审查 · {stateLabels[status]} · 第 {state.round} / {state.maxRounds} 轮</summary>
      {loadError && <p className="native-agent-warning" role="alert">状态读取失败：{loadError}。以下为上次同步的质量记录。</p>}
      <p>自动审查：{loadError ? '状态未知' : state.automaticReview === 'passed' ? '通过' : state.automaticReview === 'blocked' ? '阻塞' : state.automaticReview === 'unknown' ? '状态未知' : '待完成'} · 人工验收：未发起</p>
      <p className="panel-note">每轮使用新的独立审阅、反例检查与隔离验证上下文；执行结束不代表验收通过。自动审查结果不代替人工验收。</p>
      <p>验证范围：{state.validationMode === 'commands' ? '隔离工作区内执行命令并核对回执' : '静态材料检查，未运行命令'} · 更新于 <time dateTime={state.updatedAt}>{state.updatedAt}</time></p>
      {!!state.findings.length && <div aria-label="待处理质量问题"><strong>待处理问题（{state.findings.length}）</strong>{state.findings.map(finding => <Finding key={finding.id} finding={finding}/>)}</div>}
      {state.rounds.map(round => <details key={round.round} className="native-quality-round" open={round.round === state.round}>
        <summary>第 {round.round} 轮 · {stateLabels[round.status]}</summary>
        {round.snapshotCommit && <p>审查快照：<code>{round.snapshotCommit}</code></p>}
        {round.deliveryDigest && <p>交付正文 SHA-256：<code>{round.deliveryDigest}</code></p>}
        {!!round.issues.length && <ul className="native-agent-warning">{round.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
        {round.roles.map(role => <details key={role.childId} className="native-quality-role" data-quality-role={role.role}>
          <summary>{roleLabels[role.role]} · {roleStateLabels[role.status]}</summary>
          <p>执行身份：<code>{role.identity.runId}</code></p>
          {role.error && <p className="native-agent-warning">{role.error}</p>}
          {role.report ? <Report report={role.report}/> : <p>尚无已保存的结构化审查报告。</p>}
        </details>)}
      </details>)}
      <details><summary>质量审查保存位置</summary><p>父回合：<code>{state.parentIdentity.runId}</code></p><p>回执：<code>{state.receiptPath}</code></p></details>
    </details>
  </section>;
}
