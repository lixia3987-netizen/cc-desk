import { useCallback, useEffect, useRef, useState } from 'react';
import type { NativeConnectionInput, NativeConnectionList, NativeConnectionTestCode, NativeConnectionTestResult, NativeConnectionView } from '../../shared/native-connections';
import { nativeConnectionsChanged } from '../useNativeConnectionReadiness';

function emptyConnection(): NativeConnectionInput {
  return { name: '', protocol: 'responses', baseURL: 'https://api.openai.com/v1', model: '', allowLoopbackHttp: false, enabled: true, auth: { mode: 'env', variable: 'OPENAI_API_KEY' } };
}
function editable(item: NativeConnectionView): NativeConnectionInput {
  const { id, revision, name, protocol, baseURL, model, allowLoopbackHttp, enabled, auth } = item;
  return { id, revision, name, protocol, baseURL, model, allowLoopbackHttp, enabled, auth: { ...auth } };
}

const diagnosticMessages: Record<NativeConnectionTestCode, string> = {
  ok: 'Responses 文本流测试通过；尚未验证工具调用兼容性。',
  configuration: '连接配置不可用、修订已变化或正在运行，请刷新并检查配置后重试。',
  busy: '已有连接测试进行中，请等待完成或取消。',
  cancelled: '连接测试已取消；服务端可能已经产生用量。',
  timeout: '连接测试在 30 秒内未完成，请检查网络或服务状态。',
  authentication: '认证失败，请检查 API Key。',
  permission: '服务拒绝访问，请检查账户与模型权限。',
  endpoint: '服务端点不存在，请检查服务地址及 Responses 协议支持。',
  rate_limit: '服务限流或额度不足，请检查账户状态后手动重试。',
  service: '服务返回失败，请稍后手动重试。',
  http: '服务返回 HTTP 错误，请检查连接配置。',
  redirect: '服务要求重定向，已阻止转发凭据；请填写最终服务地址。',
  protocol: '服务未返回完整有效的 Responses 文本流，请检查协议支持。',
  incomplete: '模型响应未完成；可能是断流或达到测试输出上限，不能据此判定连接可用。',
  refused: '模型拒绝了测试请求，本次未完成文本响应验证。',
  unexpected_tool: '模型返回了未请求的工具调用，测试未通过且没有执行工具。',
  credential_echo: '服务响应包含受保护凭据，已丢弃响应；请检查服务配置。',
  transport: '网络连接失败，请检查网络、证书和服务地址。',
  response_limit: '服务响应超过测试大小上限，已中止。',
};

/** Secrets remain in the uncontrolled password field only until the one write-only IPC. */
export function NativeConnections({ disabled = false }: { disabled?: boolean }) {
  const api = window.desktop.nativeConnections;
  const [data, setData] = useState<NativeConnectionList>();
  const [draft, setDraft] = useState<NativeConnectionInput>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [testing, setTesting] = useState<{ id: string; requestId: string }>();
  const activeTest = useRef<{ id: string; requestId: string } | undefined>(undefined);
  const [testResults, setTestResults] = useState<Record<string, { revision: number; result: NativeConnectionTestResult }>>({});
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
    return () => {
      mounted.current = false;
      if (credential.current) credential.current.value = '';
      if (activeTest.current) void api?.cancelTest({ requestId: activeTest.current.requestId }).catch(() => {});
      activeTest.current = undefined;
    };
  }, [api, refresh]);
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
  const testConnection = (item: NativeConnectionView) => {
    if (disabled || busy || activeTest.current || !item.ready) return;
    clearSecret(); setError(''); setNotice('');
    const current = { id: item.id, requestId: crypto.randomUUID() };
    activeTest.current = current; setTesting(current);
    setTestResults(results => { const next = { ...results }; delete next[item.id]; return next; });
    void api.test({ id: item.id, revision: item.revision, requestId: current.requestId }).then(result => {
      if (mounted.current && activeTest.current === current) setTestResults(results => ({ ...results, [item.id]: { revision: item.revision, result } }));
    }).catch(() => {
      if (mounted.current && activeTest.current === current) setError('无法完成连接测试，请刷新连接后重试。');
    }).finally(() => {
      if (activeTest.current !== current) return;
      activeTest.current = undefined;
      if (mounted.current) {
        setTesting(undefined);
        window.dispatchEvent(new Event(nativeConnectionsChanged));
        void refresh().catch(() => { if (mounted.current) setError('读取模型连接失败，请刷新重试。'); });
      }
    });
  };
  const cancelTest = () => {
    if (!activeTest.current) return;
    void api.cancelTest({ requestId: activeTest.current.requestId }).catch(() => {
      if (mounted.current) setError('取消请求未能送达，连接测试将在超时后结束。');
    });
  };
  const locked = disabled || busy || Boolean(testing) || Boolean(data?.error);
  return <section className="settings-section native-connections" aria-label="Native 模型连接">
    <div className="settings-card-heading"><h4>Native Agent Alpha · 模型连接</h4><button type="button" className="secondary compact" disabled={locked || !api} onClick={() => void action(refresh)}>刷新</button></div>
    <p className="hint">使用独立的 OpenAI Responses 文本与工具协议。填写服务地址、模型和认证后，在新建会话时选择 native；不会使用 Claude 登录。打开设置、保存和刷新都不会请求模型。</p>
    <p className="hint">点击“测试连接（可能计费）”才会发送一次固定文本请求，输出上限 256 tokens，30 秒超时；不发送项目内容、不执行工具、不自动重试。仅验证 Responses 文本流，不代表工具调用兼容性。费用以服务商计费为准，取消不保证免计费。</p>
    {!api && <p role="status" className="hint">当前桌面版本尚未提供模型连接管理。</p>}
    {data?.storage.reason && <p className="hint">{data.storage.reason}</p>}
    {(error || data?.error) && <p className="settings-error" role="alert">{error || data?.error}</p>}
    {notice && <p role="status" className="hint">{notice}</p>}
    {data?.connections.map(item => <div className={'connection-box ' + (item.ready ? 'connected' : '')} key={item.id}>
      <div><strong>{item.name}</strong><span> · {item.enabled ? item.ready ? '就绪' : '未就绪' : '已禁用'} · 修订 {item.revision}</span></div>
      <p>{item.model} · {item.baseURL}</p>
      <small>连接 ID：{item.id}<br/>认证：{item.auth.mode === 'env' ? '环境变量 ' + item.auth.variable : item.auth.mode === 'memory' ? '仅本次内存' : '系统加密保存'}{item.credentialConfigured ? '' : ' · 尚未设置凭据'}</small>
      {item.error && <p className="hint">{item.error}</p>}
      <div className="settings-footer-actions"><button type="button" className="secondary compact" disabled={locked} onClick={() => select(editable(item))}>编辑</button><button type="button" className="secondary compact" disabled={locked} onClick={() => { clearSecret(); void action(async () => { const next = await api.upsert({ ...editable(item), enabled: !item.enabled }); if (draft?.id === next.id) setDraft(editable(next)); }); }}>{item.enabled ? '禁用' : '启用'}</button><button type="button" className="secondary compact" disabled={locked} onClick={() => { clearSecret(); void action(async () => { await api.remove({ id: item.id, revision: item.revision }); if (draft?.id === item.id) setDraft(undefined); }); }}>删除</button><button type="button" className="secondary compact" disabled={locked || !item.ready} onClick={() => testConnection(item)}>测试连接（可能计费）</button>{testing?.id === item.id && <button type="button" className="secondary compact" onClick={cancelTest}>取消连接测试</button>}</div>
      {testing?.id === item.id && <p className="hint" role="status">正在测试 Responses 文本流…</p>}
      {testResults[item.id]?.revision === item.revision && <p className="hint native-connection-test-result" role="status">
        {diagnosticMessages[testResults[item.id].result.code]} 耗时 {testResults[item.id].result.durationMs} ms。
        {testResults[item.id].result.httpStatus !== undefined && <> HTTP {testResults[item.id].result.httpStatus}。</>}
        {testResults[item.id].result.usage ? <> 服务报告用量：输入 {testResults[item.id].result.usage?.inputTokens ?? '未提供'}，输出 {testResults[item.id].result.usage?.outputTokens ?? '未提供'}，合计 {testResults[item.id].result.usage?.totalTokens ?? '未提供'} tokens。</> : <> 服务未提供用量。</>}
      </p>}
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
    <p className="hint">模型连接与凭据的操作立即保存。运行或测试中的连接需先停止并等待清理完成才能修改；已有会话引用的连接可禁用，替换引用后才能删除。就绪仅检查本机配置，不代表远程服务可用；测试结果只对应本次连接修订，不会跨重启保存。</p>
  </section>;
}
