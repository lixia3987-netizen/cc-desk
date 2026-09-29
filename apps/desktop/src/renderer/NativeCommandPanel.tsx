import type { NativeCommandSnapshot, NativeCommandView } from '../shared/chat';

const states: Record<NativeCommandView['status'], string> = {
  prepared: '已记录启动意图', running: '运行中', finished: '已结束', unknown: '结果未知，待核查',
};

export function NativeCommandPanel({ commands, currentRunId, loadError }: {
  commands?: NativeCommandSnapshot; currentRunId?: string; loadError?: string;
}) {
  if (!commands?.items.length) return null;
  return <section className="native-command-panel" aria-label="Native 长命令状态">
    <details open><summary>长命令状态（{commands.items.length}）</summary>
      <p className="native-command-note">启动确认和命令结束仅记录执行事实，不代表任务验收通过。命令限定于所属回合，中断或停止会话会清理本轮命令。</p>
      {loadError && <p className="native-command-warning" role="alert">当前状态未知：{loadError}。下方为上次保存的快照，请刷新会话状态后核查。</p>}
      {commands.omitted > 0 && <p className="native-command-note">仅展示最近 {commands.items.length} 条，另有 {commands.omitted} 条历史命令保留在执行记录中。</p>}
      {commands.items.map(command => {
        const result = command.result, status = loadError ? 'unknown' : command.status;
        return <details key={`${command.runId}:${command.commandId}`} className="native-command-entry" data-command-id={command.commandId} data-command-status={status}>
          <summary><span>{command.runId === currentRunId ? '当前回合' : '历史回合'}</span><code>{command.command.executable}</code><span className={'native-command-state ' + status}>{loadError ? '当前状态未知' : states[status]}</span></summary>
          <p>命令：<code>{command.commandId}</code> · 任务：<code>{command.taskId}</code></p>
          <p>回合：<code>{command.runId}</code> · 启动工具调用：<code>{command.toolCallId}</code></p>
          <p>程序：<code>{command.command.executable}</code></p>
          <p>参数：<code>{JSON.stringify(command.command.argv)}</code></p>
          <p>项目内工作目录：<code>{command.command.cwd}</code></p>
          <p>超时限制：{command.timeoutMs} 毫秒 · 输出保留上限：{command.maxOutputBytes} 字节（stdout 与 stderr 合计）</p>
          <p>启动意图：<time dateTime={command.preparedAt}>{command.preparedAt}</time>{command.runningAt && <> · 已启动：<time dateTime={command.runningAt}>{command.runningAt}</time></>}</p>
          {command.finishedAt && <p>终局记录：<time dateTime={command.finishedAt}>{command.finishedAt}</time></p>}
          {command.missingTerminal && <p className="native-command-warning">缺少已保存的终局回执。无法确认进程是否结束或清理完成；不会根据旧 PID 接管或自动重启。</p>}
          {status === 'prepared' && <p className="native-command-note">尚未收到宿主确认进程已启动。</p>}
          {status === 'running' && <p className="native-command-note">此面板展示生命周期通知；最终输出将在命令收束并保存后显示。</p>}
          {result && <>
            {loadError && <p className="native-command-note">以下为上次保存的命令结果。</p>}
            <p>退出码：{result.exitCode === null ? '未知' : result.exitCode} · 信号：{result.signal || '无记录'}</p>
            <p>取消：{result.cancelled ? '是' : '否'} · 超时：{result.timedOut ? '是' : '否'} · 清理：{result.cleanup === 'released' ? '已确认' : '未确认'}</p>
            <p>收到输出：{result.outputBytes} 字节 · {result.truncated ? '输出已截断，日志不完整' : '输出未截断'}</p>
            {result.cleanup !== 'released' && <p className="native-command-warning">进程清理未确认，需要人工核查；此记录不能证明进程已经停止。</p>}
            {result.error && <p className="native-command-warning">执行说明：{result.error}</p>}
            <details className="native-command-output"><summary>最终保留日志</summary>
              <pre aria-label="命令标准输出">{result.stdout || '（无标准输出）'}</pre>
              <pre aria-label="命令标准错误">{result.stderr || '（无标准错误）'}</pre>
            </details>
          </>}
        </details>;
      })}
    </details>
  </section>;
}
