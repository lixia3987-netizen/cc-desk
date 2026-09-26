import { useCallback, useEffect, useRef, useState } from 'react';
import type { NativeConnectionInput, NativeConnectionList, NativeConnectionView } from '../../shared/native-connections';
import { nativeConnectionsChanged } from '../useNativeConnectionReadiness';

function emptyConnection(): NativeConnectionInput {
  return { name: '', protocol: 'responses', baseURL: 'https://api.openai.com/v1', model: '', allowLoopbackHttp: false, enabled: true, auth: { mode: 'env', variable: 'OPENAI_API_KEY' } };
}
function editable(item: NativeConnectionView): NativeConnectionInput {
  const { id, revision, name, protocol, baseURL, model, allowLoopbackHttp, enabled, auth } = item;
  return { id, revision, name, protocol, baseURL, model, allowLoopbackHttp, enabled, auth: { ...auth } };
}

/** Secrets remain in the uncontrolled password field only until the one write-only IPC. */
export function NativeConnections({ disabled = false }: { disabled?: boolean }) {
  const api = window.desktop.nativeConnections;
  const [data, setData] = useState<NativeConnectionList>();
  const [draft, setDraft] = useState<NativeConnectionInput>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const credential = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    if (!api) return;
    const next = await api.list();
    if (mounted.current) setData(next);
  }, [api]);
  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => { if (mounted.current) setError('读取模型连接失败，请刷新重试。'); });
    return () => { mounted.current = false; if (credential.current) credential.current.value = ''; };
  }, [refresh]);
  const clearSecret = () => { if (credential.current) credential.current.value = ''; };
  const select = (value?: NativeConnectionInput) => { clearSecret(); setDraft(value); setError(''); setNotice(''); };
  const action = async (work: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await work(); await refresh(); window.dispatchEvent(new Event(nativeConnectionsChanged)); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '连接操作失败，请重试。'); }
    finally { if (mounted.current) setBusy(false); }
  };
  const save = () => {
    if (!draft) return;
    clearSecret();
    void action(async () => { const next = await api.upsert(draft); if (mounted.current) { setDraft(editable(next)); setNotice('连接已保存。'); } });
  };
  const saveCredential = () => {
    if (!draft?.id || !draft.revision || draft.auth.mode === 'env' || !credential.current) return;
    const input = credential.current;
    // Clear immediately after invoke, including synchronous bridge errors. Never keep a form draft.
    void action(async () => {
      let request: Promise<NativeConnectionView>;
      try { request = api.setCredential({ id: draft.id!, revision: draft.revision!, mode: draft.auth.mode as 'memory' | 'encrypted', secret: input.value }); }
      finally { input.value = ''; }
      const next = await request;
      if (mounted.current) { setDraft(editable(next)); setNotice('凭据已设置，输入内容已清空。'); }
    });
  };
  const locked = disabled || busy || Boolean(data?.error);
  return <section className="settings-section native-connections" aria-label="Native 模型连接">
    <div className="settings-card-heading"><h4>Native Agent Alpha · 模型连接</h4><button type="button" className="secondary compact" disabled={disabled || busy || !api} onClick={() => void action(refresh)}>刷新</button></div>
    <p className="hint">使用独立的 OpenAI Responses 文本与工具协议。填写服务地址、模型和认证后，在新建会话时选择 native；不会使用 Claude 登录，也不会在这里发起付费模型请求。</p>
    {!api && <p role="status" className="hint">当前桌面版本尚未提供模型连接管理。</p>}
    {data?.storage.reason && <p className="hint">{data.storage.reason}</p>}
    {(error || data?.error) && <p className="settings-error" role="alert">{error || data?.error}</p>}
    {notice && <p role="status" className="hint">{notice}</p>}
    {data?.connections.map(item => <div className={'connection-box ' + (item.ready ? 'connected' : '')} key={item.id}>
      <div><strong>{item.name}</strong><span> · {item.enabled ? item.ready ? '就绪' : '未就绪' : '已禁用'} · 修订 {item.revision}</span></div>
      <p>{item.model} · {item.baseURL}</p>
      <small>连接 ID：{item.id}<br/>认证：{item.auth.mode === 'env' ? '环境变量 ' + item.auth.variable : item.auth.mode === 'memory' ? '仅本次内存' : '系统加密保存'}{item.credentialConfigured ? '' : ' · 尚未设置凭据'}</small>
      {item.error && <p className="hint">{item.error}</p>}
      <div className="settings-footer-actions"><button type="button" className="secondary compact" disabled={locked} onClick={() => select(editable(item))}>编辑</button><button type="button" className="secondary compact" disabled={locked} onClick={() => { clearSecret(); void action(async () => { const next = await api.upsert({ ...editable(item), enabled: !item.enabled }); if (draft?.id === next.id) setDraft(editable(next)); }); }}>{item.enabled ? '禁用' : '启用'}</button><button type="button" className="secondary compact" disabled={locked} onClick={() => { clearSecret(); void action(async () => { await api.remove({ id: item.id, revision: item.revision }); if (draft?.id === item.id) setDraft(undefined); }); }}>删除</button></div>
    </div>)}
    {api && !data?.connections.length && !data?.error && <p className="hint">尚无模型连接。新增连接后，仍需自行提供有权限的模型与凭据。</p>}
    {api && !draft && <button type="button" className="secondary" disabled={locked || !data} onClick={() => select(emptyConnection())}>新增模型连接</button>}
    {draft && <div className="native-connection-editor">
      <h4>{draft.id ? '编辑模型连接' : '新增模型连接'}</h4>
      <label>连接名称<input aria-label="Native 连接名称" value={draft.name} maxLength={200} disabled={locked} onChange={event => setDraft({ ...draft, name: event.target.value })}/></label>
      <label>服务地址<input aria-label="Native 服务地址" type="url" autoComplete="off" spellCheck={false} value={draft.baseURL} maxLength={2048} disabled={locked} onChange={event => setDraft({ ...draft, baseURL: event.target.value })}/></label>
      <label>默认模型<input aria-label="Native 默认模型" value={draft.model} placeholder="填写服务提供的模型 ID" maxLength={200} disabled={locked} onChange={event => setDraft({ ...draft, model: event.target.value })}/></label>
      <label className="checkbox"><input type="checkbox" checked={draft.allowLoopbackHttp} disabled={locked} onChange={event => setDraft({ ...draft, allowLoopbackHttp: event.target.checked })}/><span>明确允许本地回环 HTTP（localhost、127.0.0.1 或 ::1）</span></label>
      <label>认证方式<select aria-label="Native 认证方式" value={draft.auth.mode} disabled={locked} onChange={event => { clearSecret(); setDraft({ ...draft, auth: event.target.value === 'env' ? { mode: 'env', variable: 'OPENAI_API_KEY' } : { mode: event.target.value as 'memory' | 'encrypted' } }); }}><option value="env">环境变量名称（密钥不经过界面）</option><option value="memory">仅本次应用内存</option><option value="encrypted" disabled={!data?.storage.persistentAvailable}>系统安全存储加密保存{data?.storage.persistentAvailable ? '' : '（不可用）'}</option></select></label>
      {draft.auth.mode === 'env' ? <label>环境变量名称<input aria-label="Native 环境变量名称" autoComplete="off" spellCheck={false} value={draft.auth.variable} maxLength={128} disabled={locked} onChange={event => setDraft({ ...draft, auth: { mode: 'env', variable: event.target.value } })}/></label> : <p className="hint">先保存连接，再单独输入凭据。仅本次内存的密钥会在退出后清除；既有密钥不会回显。</p>}
      <div className="settings-footer-actions"><button type="button" className="secondary" disabled={locked} onClick={() => select()}>关闭编辑</button><button type="button" className="primary" disabled={locked} onClick={save}>保存模型连接</button></div>
      {draft.id && draft.auth.mode !== 'env' && <div>
        <label>新的 API Key<input ref={credential} aria-label="Native 新的 API Key" type="password" autoComplete="off" spellCheck={false} maxLength={16384} disabled={locked}/></label>
        <button type="button" className="secondary" disabled={locked || (draft.auth.mode === 'encrypted' && !data?.storage.persistentAvailable)} onClick={saveCredential}>设置凭据并清空输入</button>
      </div>}
    </div>}
    <p className="hint">模型连接与凭据的操作立即保存。运行中的连接需先停止相关回合才能修改；已有会话引用的连接可禁用，替换引用后才能删除。就绪仅检查本机配置，不代表远程服务可用。</p>
  </section>;
}
