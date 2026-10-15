import { useEffect, useRef, useState } from 'react';
import type { Session } from '../../shared/types';
import type { ChatSnapshot } from '../../shared/chat';
import { NativeCommandPanel } from '../NativeCommandPanel';
import { ChatSnapshotSync, type ChatSyncState } from '../chat-snapshot-sync';
import { sessionReadLifecycle } from '../session-read-lifecycle';
import '../native-command.css';

export function NativeCommandInspector({ session, open }: { session: Session; open: boolean }) {
  const [snapshot, setSnapshot] = useState<ChatSnapshot>();
  const [state, setState] = useState<ChatSyncState>({ loading: true, failures: 0 });
  const current = useRef<ChatSnapshotSync | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    setSnapshot(undefined); setState({ loading: true, failures: 0 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sync = new ChatSnapshotSync(session.id, {
      read: () => sessionReadLifecycle.read(session.id, () => window.desktop.chatSnapshot(session.id)),
      apply: setSnapshot, state: setState,
    });
    current.current = sync;
    const off = window.desktop.onChat((id, _task, version) => {
      if (id === session.id && sync.notify(version) && sync.canAutoRefresh && !timer) {
        timer = setTimeout(() => { timer = undefined; if (sync.canAutoRefresh) void sync.refresh(); }, 80);
      }
    });
    const resume = sessionReadLifecycle.subscribe(session.id, () => { void sync.refresh(); });
    const recover = () => { if (document.visibilityState !== 'hidden') void sync.refresh(); };
    window.addEventListener('focus', recover); window.addEventListener('online', recover);
    document.addEventListener('visibilitychange', recover);
    void sync.refresh();
    return () => {
      clearTimeout(timer); off(); resume(); sync.dispose();
      if (current.current === sync) current.current = undefined;
      window.removeEventListener('focus', recover); window.removeEventListener('online', recover);
      document.removeEventListener('visibilitychange', recover);
    };
  }, [session.id, session.execution.conversationId, open]);
  return <div className="panel-content native-command-inspector">
    <p className="panel-note">查看构建、测试及临时服务等持续运行命令的状态与结果。关闭面板不会停止命令。</p>
    {state.error && <div className="panel-note" role="alert">后台命令状态暂时无法读取。<button className="secondary compact" disabled={state.loading} onClick={() => void current.current?.refresh()}>重新读取</button></div>}
    {state.loading && !snapshot && <p className="panel-note" role="status">正在读取后台命令…</p>}
    {!state.loading && !state.error && !snapshot?.nativeCommands?.items.length && <p className="panel-note">暂无后台命令记录。</p>}
    <NativeCommandPanel commands={snapshot?.nativeCommands} currentRunId={snapshot?.nativeRun?.runId} loadError={state.error}/>
  </div>;
}
