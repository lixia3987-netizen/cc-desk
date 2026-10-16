import type { Session } from '../../shared/types';
import { NativeCommandPanel } from '../NativeCommandPanel';
import { sharedChatSnapshots } from '../shared-chat-snapshot';
import { useSharedChatSnapshot } from '../useSharedChatSnapshot';
import '../native-command.css';

export function NativeCommandInspector({ session, open }: { session: Session; open: boolean }) {
  const {snapshot,state}=useSharedChatSnapshot(session.id,session.execution.conversationId,open);
  return <div className="panel-content native-command-inspector">
    <p className="panel-note">查看构建、测试及临时服务等持续运行命令的状态与结果。关闭面板不会停止命令。</p>
    {state.error && <div className="panel-note" role="alert">后台命令状态暂时无法读取。<button className="secondary compact" disabled={state.loading} onClick={() => void sharedChatSnapshots.refresh(session.id)}>重新读取</button></div>}
    {state.loading && !snapshot && <p className="panel-note" role="status">正在读取后台命令…</p>}
    {!state.loading && !state.error && !snapshot?.nativeCommands?.items.length && <p className="panel-note">暂无后台命令记录。</p>}
    <NativeCommandPanel commands={snapshot?.nativeCommands} currentRunId={snapshot?.nativeRun?.runId} loadError={state.error}/>
  </div>;
}
