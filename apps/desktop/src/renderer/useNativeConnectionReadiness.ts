import { useEffect, useState } from 'react';
import type { Session } from '../shared/types';
import type { NativeConnectionReadiness } from '../shared/native-connections';

export const nativeConnectionsChanged = 'native-connections-changed';
interface ConnectionRequest { sessionId: string; id: string; model?: string }
interface CheckedConnection { key: string; result: NativeConnectionReadiness }

export function nativeConnectionRequest(session: Session): ConnectionRequest | undefined {
  if (session.execution.providerId !== 'native') return undefined;
  const { connectionId, model } = session.engineConfig.options;
  return { sessionId: session.id, id: typeof connectionId === 'string' ? connectionId.trim() : '', ...(typeof model === 'string' && model.trim() ? { model: model.trim() } : {}) };
}
function keyOf(request: ConnectionRequest): string { return JSON.stringify([request.id, request.model]); }
export function nativeConnectionUnavailable(session: Session, checked?: CheckedConnection): string | undefined {
  const request = nativeConnectionRequest(session);
  if (!request) return undefined;
  if (!request.id) return '此 native 会话尚未选择模型连接。请先在设置中新增连接，并在会话运行配置中选择；已有记录和草稿仍可查看。';
  if (!checked || checked.key !== keyOf(request)) return '正在检查此会话的模型连接…';
  return checked.result.ready ? undefined : (checked.result.error || '此会话的模型连接尚未就绪，请检查设置。');
}

/** Readiness is per session, independent of the provider-wide execution capabilities. */
export function useNativeConnectionReadiness(sessions: readonly Session[] | undefined): (session: Session) => string | undefined {
  const requests = (sessions ?? []).flatMap(session => { const request = nativeConnectionRequest(session); return request ? [request] : []; });
  const encoded = JSON.stringify(requests);
  const [checked, setChecked] = useState<Record<string, CheckedConnection>>({});
  useEffect(() => {
    const current = JSON.parse(encoded) as ConnectionRequest[];
    let mounted = true, generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      const request = ++generation;
      const queries = new Map<string, Promise<NativeConnectionReadiness>>();
      for (const connection of current) {
        const key = keyOf(connection);
        if (queries.has(key)) continue;
        const result = !connection.id ? Promise.resolve({ ready: false }) : window.desktop.nativeConnections
          ? window.desktop.nativeConnections.readiness({ id: connection.id, model: connection.model }).catch(() => ({ ready: false, error: '读取此会话的模型连接状态失败，请在设置中刷新连接。' }))
          : Promise.resolve({ ready: false, error: '当前桌面版本未提供 native 模型连接，请更新应用。' });
        queries.set(key, result);
      }
      void Promise.all(current.map(async connection => [connection.sessionId, { key: keyOf(connection), result: await queries.get(keyOf(connection))! }] as const)).then(values => {
        if (mounted && request === generation) setChecked(Object.fromEntries(values));
      });
    };
    // State broadcasts are also used after connection mutations. Debouncing avoids
    // decrypting the same credential for every streamed chat projection event.
    const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(refresh, 150); };
    refresh();
    const off = window.desktop?.onState(schedule);
    window.addEventListener(nativeConnectionsChanged, refresh);
    window.addEventListener('focus', refresh);
    return () => { mounted = false; generation++; if (timer) clearTimeout(timer); off?.(); window.removeEventListener(nativeConnectionsChanged, refresh); window.removeEventListener('focus', refresh); };
  }, [encoded]);
  return session => nativeConnectionUnavailable(session, checked[session.id]);
}
