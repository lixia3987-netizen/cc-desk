import type { NativeRecoveryStatus } from '../shared/chat';

export function NativeRecoveryPanel({ recovery, disabled, pending, onResume, onConfirm }: {
  recovery: NativeRecoveryStatus;
  disabled: boolean;
  pending: boolean;
  onResume: () => void;
  onConfirm: () => void;
}) {
  return <section className="chat-recovery native-recovery" aria-label="中断任务恢复">
    <strong>{recovery.status === 'recoverable' ? '上次任务已中断，可以恢复会话' : recovery.status === 'acknowledged' ? '已核查现场 · 此会话只读' : '需要核查执行现场 · 此会话只读'}</strong>
    <p className="panel-note">已记录结果 {recovery.tools.completed} 项 · 未执行 {recovery.tools.notExecuted} 项 · 结果未知 {recovery.tools.unknown} 项。可在上方工具记录中查看详情。</p>
    {recovery.tools.unknown > 0 && <p className="panel-note">若包含多文件变更，可能已部分写入；请查看工具记录中的逐文件状态。结果未知不等于全部失败或未执行，不能整批重放。</p>}
    {recovery.status === 'recoverable' ? <>
      <p className="panel-note">请先核查文件修改，并确认旧命令及其子进程已停止。恢复将保留已有上下文和确定的工具结果；已完成工具不会重放，未执行工具不会自动运行，旧审批不再有效。</p>
      <p className="panel-note">恢复后请发送新指令继续；排队消息保持暂停。</p>
      <button className="secondary compact" disabled={disabled || pending} onClick={onResume}>{pending ? '正在恢复…' : '已核查，恢复会话'}</button>
    </> : recovery.status === 'blocked' ? <>
      <p className="panel-note">请核查上次工具执行涉及的文件、命令和残留进程。确认只解除工作目录隔离，旧会话仍为只读；需新建会话继续，不会重放结果未知的工具。</p>
      <button className="secondary compact" disabled={disabled || pending} onClick={onConfirm}>{pending ? '正在确认…' : '确认已核查执行现场'}</button>
    </> : <p className="panel-note">工作目录隔离已解除，原始记录继续保留。请新建会话继续；未知工具不会重放。</p>}
  </section>;
}
