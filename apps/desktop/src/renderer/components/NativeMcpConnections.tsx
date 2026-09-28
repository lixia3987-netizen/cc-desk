import { useCallback, useEffect, useRef, useState } from 'react';
import type { NativeMcpConnectionInput, NativeMcpConnectionList, NativeMcpConnectionsAPI, NativeMcpConnectionView } from '../../shared/native-mcp';

function emptyConnection(): NativeMcpConnectionInput {
  return { name: '', endpoint: '', allowLoopbackHttp: false, enabled: true, auth: { mode: 'none' } };
}

function editable(item: NativeMcpConnectionView): NativeMcpConnectionInput {
  const { id, revision, name, endpoint, allowLoopbackHttp, enabled, auth } = item;
  return { id, revision, name, endpoint, allowLoopbackHttp, enabled, auth: { ...auth } };
}

/** The only bridge call that receives the secret; clear even when invoke throws synchronously. */
export function submitMcpCredential(api: Pick<NativeMcpConnectionsAPI, 'setCredential'>, draft: NativeMcpConnectionInput, input: { value: string }): Promise<NativeMcpConnectionView> {
  try {
    if (!draft.id || !draft.revision || (draft.auth.mode !== 'memory' && draft.auth.mode !== 'encrypted')) throw new Error('请先保存需要凭据的 MCP 连接。');
    return api.setCredential({ id: draft.id, revision: draft.revision, mode: draft.auth.mode, secret: input.value });
  } finally { input.value = ''; }
}

export function NativeMcpConnections({ disabled = false }: { disabled?: boolean }) {
  const api = typeof window === 'undefined' ? undefined : window.desktop.nativeMcp;
  const [data, setData] = useState<NativeMcpConnectionList>();
  const [draft, setDraft] = useState<NativeMcpConnectionInput>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const credential = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const working = useRef(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!api) return;
    const current = ++generation.current;
    const next = await api.list();
    if (mounted.current && current === generation.current) setData(next);
  }, [api]);
  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => { if (mounted.current) setError('读取 MCP 连接失败，请刷新重试。'); });
    return () => { mounted.current = false; generation.current++; if (credential.current) credential.current.value = ''; };
  }, [refresh]);
  const clearSecret = () => { if (credential.current) credential.current.value = ''; };
  const select = (next?: NativeMcpConnectionInput) => { clearSecret(); setDraft(next); setError(''); setNotice(''); };
  const change = (next: NativeMcpConnectionInput) => { clearSecret(); setDraft(next); setNotice(''); };
  const action = async (work: () => Promise<void>) => {
    if (disabled || working.current || !api) return;
    working.current = true; setBusy(true); setError(''); setNotice('');
    try { await work(); if (mounted.current) await refresh(); }
    catch { if (mounted.current) setError('MCP 连接操作失败，请刷新后重试；运行中的连接需先停止，已被会话引用的连接需先移除引用。'); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  };
  const save = () => {
    if (!draft || !api) return;
    clearSecret();
    void action(async () => { const next = await api.upsert(draft); if (mounted.current) { setDraft(editable(next)); setNotice('MCP 连接已保存。'); } });
  };
  const saved = draft?.id ? data?.connections.find(item => item.id === draft.id) : undefined;
  const credentialReady = saved && draft && JSON.stringify(editable(saved)) === JSON.stringify(draft);
  const saveCredential = () => {
    if (!draft || !credential.current || !api || !credentialReady) return;
    const input = credential.current;
    void action(async () => {
      const next = await submitMcpCredential(api, draft, input);
      if (mounted.current) { setDraft(editable(next)); setNotice('MCP 凭据已设置，输入内容已清空。'); }
    });
  };
  const locked = disabled || busy || Boolean(data?.error);
  return <section className="settings-section native-connections native-mcp-connections" aria-label="Native MCP 连接">
    <div className="settings-card-heading"><h4>Native Agent Alpha · MCP 连接</h4><button type="button" className="secondary compact" disabled={disabled || busy || !api} onClick={() => { clearSecret(); void action(async () => {}); }}>刷新</button></div>
    <p className="hint">支持 MCP HTTP 2026-07-28 工具。旧协议与 stdio 暂不支持。在会话运行配置中明确选择后，发送任务才会连接服务；默认引擎仍为 Claude。</p>
    <p className="hint">打开设置、刷新和保存只操作本机配置，不访问远端。每次 MCP 工具调用都需要审批。</p>
    {!api && <p className="hint" role="status">当前桌面版本尚未提供 MCP 连接管理。</p>}
    {data?.storage.reason && <p className="hint">{data.storage.reason}</p>}
    {(error || data?.error) && <p className="settings-error" role="alert">{error || data?.error}</p>}
    {notice && <p className="hint" role="status">{notice}</p>}
    {data?.connections.map(item => <div className={'connection-box ' + (item.ready ? 'connected' : '')} key={item.id}>
      <div><strong>{item.name}</strong><span> · {item.enabled ? item.ready ? '本机配置就绪' : '未就绪' : '已禁用'} · 修订 {item.revision}</span></div>
      <p>{item.endpoint}</p>
      <small>连接 ID：{item.id}<br/>认证：{item.auth.mode === 'none' ? '无认证' : item.auth.mode === 'env' ? 'Bearer 环境变量 ' + item.auth.variable : item.auth.mode === 'memory' ? 'Bearer 仅本次内存' : 'Bearer 系统加密保存'}{item.credentialConfigured ? '' : ' · 尚未设置凭据'}</small>
      {item.error && <p className="hint">{item.error}</p>}
      <div className="settings-footer-actions">
        <button type="button" className="secondary compact" disabled={locked} onClick={() => select(editable(item))}>编辑</button>
        <button type="button" className="secondary compact" disabled={locked} onClick={() => { clearSecret(); void action(async () => { const next = await api!.upsert({ ...editable(item), enabled: !item.enabled }); if (mounted.current && draft?.id === next.id) setDraft(editable(next)); }); }}>{item.enabled ? '禁用' : '启用'}</button>
        <button type="button" className="secondary compact" disabled={locked} onClick={() => { clearSecret(); void action(async () => { await api!.remove({ id: item.id, revision: item.revision }); if (mounted.current && draft?.id === item.id) setDraft(undefined); }); }}>删除</button>
      </div>
    </div>)}
    {api && data && !data.connections.length && !data.error && <p className="hint">尚无 MCP 连接。新增服务不会自动启用到会话。</p>}
    {api && !draft && <button type="button" className="secondary" disabled={locked || !data} onClick={() => select(emptyConnection())}>新增 MCP 连接</button>}
    {draft && <div className="native-connection-editor">
      <h4>{draft.id ? '编辑 MCP 连接' : '新增 MCP 连接'}</h4>
      <label>连接名称<input aria-label="MCP 连接名称" value={draft.name} maxLength={200} disabled={locked} onChange={event => change({ ...draft, name: event.target.value })}/></label>
      <label>服务端点<input aria-label="MCP 服务端点" type="url" autoComplete="off" spellCheck={false} placeholder="https://example.com/mcp" value={draft.endpoint} maxLength={2048} disabled={locked} onChange={event => change({ ...draft, endpoint: event.target.value })}/></label>
      <label className="checkbox"><input type="checkbox" aria-label="MCP 允许本地回环 HTTP" checked={draft.allowLoopbackHttp} disabled={locked} onChange={event => change({ ...draft, allowLoopbackHttp: event.target.checked })}/><span>明确允许本地回环 HTTP（localhost、127.0.0.1 或 ::1）</span></label>
      <label>认证方式<select aria-label="MCP 认证方式" value={draft.auth.mode} disabled={locked} onChange={event => change({ ...draft, auth: event.target.value === 'env' ? { mode: 'env', variable: 'MCP_API_KEY' } : { mode: event.target.value as 'none' | 'memory' | 'encrypted' } })}>
        <option value="none">无认证</option><option value="env">Bearer 环境变量名称（密钥不经过界面）</option><option value="memory">Bearer 仅本次应用内存</option><option value="encrypted" disabled={!data?.storage.persistentAvailable}>Bearer 系统安全存储{data?.storage.persistentAvailable ? '' : '（不可用）'}</option>
      </select></label>
      {draft.auth.mode === 'env' && <label>环境变量名称<input aria-label="MCP 环境变量名称" autoComplete="off" spellCheck={false} value={draft.auth.variable} maxLength={128} disabled={locked} onChange={event => change({ ...draft, auth: { mode: 'env', variable: event.target.value } })}/></label>}
      {(draft.auth.mode === 'memory' || draft.auth.mode === 'encrypted') && <p className="hint">先保存连接，再单独输入 Bearer 凭据。内存凭据在退出后清除，既有凭据不会回显。</p>}
      <div className="settings-footer-actions"><button type="button" className="secondary" disabled={busy} onClick={() => select()}>关闭 MCP 编辑</button><button type="button" className="primary" disabled={locked} onClick={save}>保存 MCP 连接</button></div>
      {draft.id && (draft.auth.mode === 'memory' || draft.auth.mode === 'encrypted') && <div>
        {!credentialReady && <p className="hint">请先保存当前连接配置，再设置凭据。</p>}
        <label>新的 Bearer 凭据<input ref={credential} aria-label="MCP 新的 Bearer 凭据" type="password" autoComplete="off" spellCheck={false} maxLength={8192} disabled={locked || !credentialReady}/></label>
        <button type="button" className="secondary" disabled={locked || !credentialReady || (draft.auth.mode === 'encrypted' && !data?.storage.persistentAvailable)} onClick={saveCredential}>设置 MCP 凭据并清空输入</button>
      </div>}
    </div>}
    <p className="hint">MCP 连接与凭据立即保存。“本机配置就绪”不代表服务兼容或在线。运行中的连接需先停止才能修改；移除所有会话引用后才能删除。</p>
  </section>;
}
