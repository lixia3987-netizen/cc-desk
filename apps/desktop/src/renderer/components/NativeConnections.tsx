import { useCallback, useEffect, useRef, useState } from 'react';
import type { NativeConnectionInput, NativeConnectionList, NativeConnectionModelListCode, NativeConnectionModelListResult, NativeConnectionTestCode, NativeConnectionTestResult, NativeConnectionView, NativeModelCapabilitySnapshot } from '../../shared/native-connections';
import { nativeConnectionsChanged } from '../useNativeConnectionReadiness';
import { ModelCapabilityInfo } from './ModelCapabilityInfo';

function emptyConnection(): NativeConnectionInput {
  return { name: '', protocol: 'responses', baseURL: 'https://api.openai.com/v1', model: '', allowLoopbackHttp: false, enabled: true, auth: { mode: 'env', variable: 'OPENAI_API_KEY' } };
}
function editable(item: NativeConnectionView): NativeConnectionInput {
  const { id, revision, name, protocol, authHeader, baseURL, model, allowLoopbackHttp, enabled, auth, pricing } = item;
  return { id, revision, name, protocol, ...(authHeader ? { authHeader } : {}), baseURL, model, allowLoopbackHttp, enabled, auth: { ...auth }, ...(pricing ? { pricing: { ...pricing } } : {}) };
}
const protocolNames = { responses: 'Responses', 'chat-completions': 'Chat Completions', anthropic: 'Anthropic Messages' };

const modelListMessages: Record<NativeConnectionModelListCode, string> = {
  ok: '可用模型已读取。',
  configuration: '连接不可用、已修改或正在运行，请检查配置后重试。',
  busy: '已有连接请求进行中，请等待完成或取消。',
  cancelled: '读取模型已取消。',
  timeout: '读取模型超时，请检查网络或服务状态。',
  authentication: '认证失败，请检查 API Key。',
  permission: '服务拒绝读取模型，请检查账户权限。',
  endpoint: '服务未提供模型列表，请检查服务地址，或手动填写模型 ID。',
  rate_limit: '服务限流或额度不足，请稍后重试。',
  service: '服务暂时无法提供模型列表，请稍后重试。',
  http: '服务返回 HTTP 错误，请检查连接配置。',
  redirect: '服务要求重定向，请填写最终服务地址后重新读取。',
  protocol: '服务未返回有效的模型列表，可手动填写模型 ID。',
  credential_echo: '服务响应包含受保护凭据，已丢弃，请检查服务配置。',
  transport: '读取失败，请检查网络、证书和服务地址。',
  response_limit: '模型列表超过读取上限，可手动填写模型 ID。',
};

const diagnosticMessages: Record<NativeConnectionTestCode, string> = {
  ok: '所选协议文本流测试通过；尚未验证工具调用兼容性。',
  configuration: '连接配置不可用、修订已变化或正在运行，请刷新并检查配置后重试。',
  busy: '已有连接测试进行中，请等待完成或取消。',
  cancelled: '连接测试已取消；服务端可能已经产生用量。',
  timeout: '连接测试在 30 秒内未完成，请检查网络或服务状态。',
  authentication: '认证失败，请检查 API Key。',
  permission: '服务拒绝访问，请检查账户与模型权限。',
  endpoint: '服务端点不存在，请检查服务地址及 所选协议支持。',
  rate_limit: '服务限流或额度不足，请检查账户状态后手动重试。',
  service: '服务返回失败，请稍后手动重试。',
  http: '服务返回 HTTP 错误，请检查连接配置。',
  redirect: '服务要求重定向，已阻止转发凭据；请填写最终服务地址。',
  protocol: '服务未返回完整有效的 所选协议文本流，请检查协议支持。',
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
  const [listing, setListing] = useState<{ id: string; requestId: string }>();
  const activeList = useRef<{ id: string; requestId: string } | undefined>(undefined);
  const [modelLists, setModelLists] = useState<Record<string, { result: NativeConnectionModelListResult; selected: string }>>({});
  const [modelCapabilities, setModelCapabilities] = useState<Record<string, NativeModelCapabilitySnapshot>>({});
  const [capabilityRefresh, setCapabilityRefresh] = useState(0);
  const credential = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const refreshRequest = useRef(0);
  const refresh = useCallback(async () => {
    if (!api) return;
    const request = ++refreshRequest.current;
    const next = await api.list();
    if (mounted.current && request === refreshRequest.current) { setData(next); setCapabilityRefresh(value => value + 1); }
  }, [api]);
  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => { if (mounted.current) setError('读取模型连接失败，请刷新重试。'); });
    const onChanged = () => { void refresh().catch(() => { if (mounted.current) setError('读取模型连接失败，请刷新重试。'); }); };
    window.addEventListener(nativeConnectionsChanged, onChanged);
    return () => {
      mounted.current = false;
      refreshRequest.current++;
      window.removeEventListener(nativeConnectionsChanged, onChanged);
      if (credential.current) credential.current.value = '';
      if (activeTest.current) void api?.cancelTest({ requestId: activeTest.current.requestId }).catch(() => {});
      activeTest.current = undefined;
      if (activeList.current) void api?.cancelListModels({ requestId: activeList.current.requestId }).catch(() => {});
      activeList.current = undefined;
    };
  }, [api, refresh]);
  const capabilityBindings = data?.connections.filter(item => item.ready).map(item => JSON.stringify([item.id, item.revision, item.model])).join('|');
  useEffect(() => {
    if (!api?.modelCapabilities || !data) return;
    let cancelled = false;
    // Read one saved connection at a time; the main process bounds and caches
    // metadata GETs. This never populates or selects the available-model picker.
    void (async () => {
      for (const item of data.connections.filter(item => item.ready)) {
        if (cancelled) return;
        try {
          const result = await api.modelCapabilities({ id: item.id, revision: item.revision });
          if (!cancelled && mounted.current && result.connectionId === item.id && result.revision === item.revision && result.model === item.model) {
            setModelCapabilities(values => ({ ...values, [item.id]: result }));
          }
        } catch { /* Unknown metadata keeps the configured budget and connection usable. */ }
      }
    })();
    return () => { cancelled = true; };
  }, [api, capabilityBindings, capabilityRefresh]);
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
    if (disabled || busy || activeTest.current || activeList.current || !item.ready) return;
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
  const loadModels = (item: NativeConnectionView) => {
    if (disabled || busy || activeList.current || activeTest.current || !item.ready) return;
    clearSecret(); setError(''); setNotice('');
    const current = { id: item.id, requestId: crypto.randomUUID() };
    activeList.current = current; setListing(current);
    setModelLists(results => { const next = { ...results }; delete next[item.id]; return next; });
    void api.listModels({ id: item.id, revision: item.revision, requestId: current.requestId }).then(result => {
      if (!mounted.current || activeList.current !== current) return;
      if (result.requestId !== current.requestId || result.connectionId !== item.id || result.revision !== item.revision) {
        setError('连接已变化，请重新读取可用模型。'); return;
      }
      setModelLists(results => ({ ...results, [item.id]: { result, selected: result.models?.some(model => model.id === item.model) ? item.model : '' } }));
    }).catch(() => {
      if (mounted.current && activeList.current === current) setError('无法读取可用模型，请刷新连接后重试。');
    }).finally(() => {
      if (activeList.current !== current) return;
      activeList.current = undefined;
      if (mounted.current) {
        setListing(undefined);
        window.dispatchEvent(new Event(nativeConnectionsChanged));
        void refresh().catch(() => { if (mounted.current) setError('读取模型连接失败，请刷新重试。'); });
      }
    });
  };
  const cancelList = () => {
    if (!activeList.current) return;
    void api.cancelListModels({ requestId: activeList.current.requestId }).catch(() => {
      if (mounted.current) setError('取消请求未能送达，读取将在超时后结束。');
    });
  };
  const switchModel = (item: NativeConnectionView) => {
    const entry = modelLists[item.id];
    if (!entry || entry.result.revision !== item.revision || entry.result.code !== 'ok' || !entry.result.models?.some(model => model.id === entry.selected) || entry.selected === item.model) return;
    clearSecret();
    void action(async () => {
      const next = await api.upsert({ ...editable(item), model: entry.selected });
      if (mounted.current) {
        if (draft?.id === item.id) setDraft(editable(next));
        setNotice('默认模型已切换为 ' + next.model + '。已有对话切换模型需新建会话；单独指定的会话模型保持原选择。');
      }
    });
  };
  const draftHasChanges = Boolean(draft && (!draft.id || !data?.connections.some(item => item.id === draft.id && JSON.stringify(editable(item)) === JSON.stringify(draft))));
  const locked = disabled || busy || Boolean(testing) || Boolean(listing) || Boolean(data?.error);
  return <section className="settings-section native-connections" aria-label="Native 模型连接">
    <div className="settings-card-heading"><h4>自研 Agent 模型连接</h4><button type="button" className="secondary compact" disabled={locked || !api} onClick={() => void action(refresh)}>刷新</button></div>
    <p className="settings-description">管理自研 Agent 的模型连接，手动新增或编辑服务地址、模型与凭据。</p>
    {!api && <p role="status" className="hint">当前桌面版本尚未提供模型连接管理。</p>}
    {data?.storage.reason && <p className="hint">{data.storage.reason}</p>}
    {(error || data?.error) && <p className="settings-error" role="alert">{error || data?.error}</p>}
    {notice && <p role="status" className="hint">{notice}</p>}
    <div className="model-connection-actions">
      {api && <button type="button" className="primary" disabled={locked || !data} onClick={() => select(emptyConnection())}>新增模型连接</button>}
    </div>
    {data?.connections.map(item => {
      const modelList = modelLists[item.id]?.result.revision === item.revision ? modelLists[item.id] : undefined;
      const capability = modelCapabilities[item.id]?.revision === item.revision && modelCapabilities[item.id]?.model === item.model ? modelCapabilities[item.id] : undefined;
      return <div className={'connection-box model-connection-card ' + (item.ready ? 'connected' : '')} key={item.id}>
      <div className="model-connection-title"><strong>{item.name}</strong><span>{item.enabled ? item.ready ? '就绪' : '未就绪' : '已禁用'}</span></div>
      <p>{item.model} · {protocolNames[item.protocol]}</p>
      <p className="hint"><ModelCapabilityInfo capabilities={capability?.capabilities} conservative={capability?.conservative}/></p>
      <p className="model-connection-endpoint">{item.baseURL}</p>
      <details className="model-connection-metadata"><summary>连接信息</summary><small>连接 ID：{item.id}<br/>修订：{item.revision}<br/>认证：{item.auth.mode === 'env' ? '环境变量 ' + item.auth.variable : item.auth.mode === 'memory' ? '仅本次内存' : '系统加密保存'}{item.credentialConfigured ? '' : ' · 尚未设置凭据'}</small></details>
      {item.error && <p className="hint">{item.error}</p>}
      <div className="settings-footer-actions">
        <button type="button" className="secondary compact" disabled={locked} onClick={() => select(editable(item))}>编辑</button>
        <button type="button" className="secondary compact" disabled={locked || !item.ready || draftHasChanges} onClick={() => loadModels(item)}>读取可用模型</button>
        {listing?.id === item.id && <button type="button" className="secondary compact" onClick={cancelList}>取消读取模型</button>}
        <button type="button" className="secondary compact" disabled={locked || !item.ready} onClick={() => testConnection(item)}>测试连接（可能计费）</button>
        {testing?.id === item.id && <button type="button" className="secondary compact" onClick={cancelTest}>取消连接测试</button>}
        <button type="button" className="secondary compact" disabled={locked} onClick={() => { clearSecret(); void action(async () => { const next = await api.upsert({ ...editable(item), enabled: !item.enabled }); if (draft?.id === next.id) setDraft(editable(next)); }); }}>{item.enabled ? '禁用' : '启用'}</button>
        <button type="button" className="secondary compact" disabled={locked} onClick={() => { clearSecret(); void action(async () => { await api.remove({ id: item.id, revision: item.revision }); if (draft?.id === item.id) setDraft(undefined); }); }}>删除</button>
      </div>
      {listing?.id === item.id && <p className="hint" role="status">正在从服务地址读取可用模型…</p>}
      {modelList && <div className="model-list-result">
        {modelList.result.code === 'ok' && modelList.result.models?.length ? <>
          <div className="model-list-picker"><label>可用模型<select aria-label="可用模型" value={modelList.selected} disabled={locked || draftHasChanges} onChange={event => {
            const selected = event.target.value;
            setModelLists(results => ({ ...results, [item.id]: { ...results[item.id], selected } }));
          }}><option value="">请选择模型</option>{modelList.result.models.map(model => <option key={model.id} value={model.id}>{model.name && model.name !== model.id ? model.name + ' · ' : ''}{model.id}</option>)}</select></label><button type="button" className="primary compact" disabled={locked || draftHasChanges || !modelList.selected || modelList.selected === item.model} onClick={() => switchModel(item)}>切换模型</button></div>
          <p className="hint">读取到 {modelList.result.models.length} 个模型。{!modelList.result.models.some(model => model.id === item.model) && '当前模型未在列表中，原配置已保留。'}切换保存为此连接的默认模型，已有对话更换模型需新建会话。</p>
        </> : <p className="hint" role="status">{modelList.result.code === 'ok' ? '服务返回空模型列表，原配置已保留，可手动填写模型 ID。' : modelListMessages[modelList.result.code]}{modelList.result.httpStatus !== undefined && <> HTTP {modelList.result.httpStatus}。</>}</p>}
      </div>}
      {testing?.id === item.id && <p className="hint" role="status">正在测试 所选协议文本流…</p>}
      {testResults[item.id]?.revision === item.revision && <p className="hint native-connection-test-result" role="status">
        {diagnosticMessages[testResults[item.id].result.code]} 耗时 {testResults[item.id].result.durationMs} ms。
        {testResults[item.id].result.estimatedCostUSD !== undefined && <> 按用户价格估算 ${testResults[item.id].result.estimatedCostUSD!.toFixed(6)}。</>}
        {testResults[item.id].result.httpStatus !== undefined && <> HTTP {testResults[item.id].result.httpStatus}。</>}
        {testResults[item.id].result.usage ? <> 服务报告用量：输入 {testResults[item.id].result.usage?.inputTokens ?? '未提供'}，输出 {testResults[item.id].result.usage?.outputTokens ?? '未提供'}，合计 {testResults[item.id].result.usage?.totalTokens ?? '未提供'} tokens。</> : <> 服务未提供用量。</>}
      </p>}
    </div>; })}
    {api && !data?.connections.length && !data?.error && !draft && <p className="model-connections-empty">还没有模型连接。可手动新增，或前往“模型导入”读取 Claude Code 配置。</p>}
    {draft && <div className="native-connection-editor">
      <h4>{draft.id ? '编辑模型连接' : '新增模型连接'}</h4>
      <label>连接名称<input aria-label="Native 连接名称" value={draft.name} maxLength={200} disabled={locked} onChange={event => setDraft({ ...draft, name: event.target.value })}/></label>
      <label>模型协议<select aria-label="Native 模型协议" value={draft.protocol} disabled={locked} onChange={event => {
        const protocol = event.target.value as NativeConnectionInput['protocol'];
        setDraft({ ...draft, protocol, authHeader: protocol === 'anthropic' ? draft.authHeader ?? 'x-api-key' : undefined,
          baseURL: protocol === 'anthropic' && draft.baseURL === 'https://api.openai.com/v1' ? 'https://api.anthropic.com' : protocol !== 'anthropic' && draft.baseURL === 'https://api.anthropic.com' ? 'https://api.openai.com/v1' : draft.baseURL,
          auth: draft.auth.mode === 'env' && ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'].includes(draft.auth.variable) ? { mode: 'env', variable: protocol === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY' } : draft.auth });
      }}><option value="responses">Responses</option><option value="chat-completions">Chat Completions</option><option value="anthropic">Anthropic Messages</option></select></label>
      <p className="hint">地址填写 API 基础路径；{draft.protocol === 'anthropic' ? '请求 /v1/messages（已有 /v1 时只追加 /messages）' : '将追加 ' + (draft.protocol === 'responses' ? '/responses' : '/chat/completions')}。已有对话更改模型、协议或服务地址后需新建会话。</p>
      {draft.protocol === 'anthropic' && <label>Anthropic 认证头<select aria-label="Anthropic 认证头" value={draft.authHeader ?? 'x-api-key'} disabled={locked} onChange={event => setDraft({ ...draft, authHeader: event.target.value as 'x-api-key' | 'authorization' })}><option value="x-api-key">API Key（x-api-key）</option><option value="authorization">Auth Token（Bearer）</option></select></label>}
      <label>服务地址<input aria-label="Native 服务地址" type="url" autoComplete="off" spellCheck={false} value={draft.baseURL} maxLength={2048} disabled={locked} onChange={event => setDraft({ ...draft, baseURL: event.target.value })}/></label>
      <label>默认模型<input aria-label="Native 默认模型" value={draft.model} placeholder="填写服务提供的模型 ID" maxLength={200} disabled={locked} onChange={event => setDraft({ ...draft, model: event.target.value })}/></label>
      <p className="hint">保存连接并设置凭据后，可在连接卡片读取可用模型。{draftHasChanges && draft.id ? '请先保存或关闭当前编辑，再读取或切换模型。' : ''}</p>
      <label>认证方式<select aria-label="Native 认证方式" value={draft.auth.mode} disabled={locked} onChange={event => { clearSecret(); setDraft({ ...draft, auth: event.target.value === 'env' ? { mode: 'env', variable: draft.protocol === 'anthropic' ? draft.authHeader === 'authorization' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY' } : { mode: event.target.value as 'memory' | 'encrypted' } }); }}><option value="env">环境变量名称（密钥不经过界面）</option><option value="memory">仅本次应用内存</option><option value="encrypted" disabled={!data?.storage.persistentAvailable}>系统安全存储加密保存{data?.storage.persistentAvailable ? '' : '（不可用）'}</option></select></label>
      {draft.auth.mode === 'env' ? <label>环境变量名称<input aria-label="Native 环境变量名称" autoComplete="off" spellCheck={false} value={draft.auth.variable} maxLength={128} disabled={locked} onChange={event => setDraft({ ...draft, auth: { mode: 'env', variable: event.target.value } })}/></label> : <p className="hint">保存连接后单独设置凭据；既有凭据不回显。</p>}
      <details className="model-config-details model-connection-advanced" key={draft.id ?? 'new'}>
      <summary>高级设置（价格与本地代理）</summary>
      <label className="checkbox"><input aria-label="填写模型价格" type="checkbox" checked={Boolean(draft.pricing)} disabled={locked} onChange={event => setDraft({ ...draft, pricing: event.target.checked ? { model: draft.model, inputUSDPerMillion: 0, outputUSDPerMillion: 0 } : undefined })}/><span>自行填写模型价格（可选，仅估算）</span></label>
      {draft.pricing && <fieldset disabled={locked}>
        <label>价格对应模型<input aria-label="价格对应模型" value={draft.pricing.model} maxLength={200} onChange={event => setDraft({ ...draft, pricing: { ...draft.pricing!, model: event.target.value } })}/></label>
        <label>输入 USD / 百万 tokens<input aria-label="输入单价" type="number" min="0" max="1000000" step="any" value={draft.pricing.inputUSDPerMillion} onChange={event => setDraft({ ...draft, pricing: { ...draft.pricing!, inputUSDPerMillion: event.target.valueAsNumber } })}/></label>
        <label>输出 USD / 百万 tokens<input aria-label="输出单价" type="number" min="0" max="1000000" step="any" value={draft.pricing.outputUSDPerMillion} onChange={event => setDraft({ ...draft, pricing: { ...draft.pricing!, outputUSDPerMillion: event.target.valueAsNumber } })}/></label>
        <p className="hint">仅用于名称完全匹配的模型，按服务报告的输入和输出用量估算。保存每回合价格快照，不追溯修改历史；未含缓存折扣、工具或其他附加费用，压缩请求另计。请以账单为准。</p>
      </fieldset>}
      <label className="checkbox"><input type="checkbox" checked={draft.allowLoopbackHttp} disabled={locked} onChange={event => setDraft({ ...draft, allowLoopbackHttp: event.target.checked })}/><span>明确允许本地回环 HTTP（localhost、127.0.0.1 或 ::1）</span></label>
      </details>
      <div className="settings-footer-actions"><button type="button" className="secondary" disabled={locked} onClick={() => select()}>关闭编辑</button><button type="button" className="primary" disabled={locked} onClick={save}>保存模型连接</button></div>
      {draft.id && draft.auth.mode !== 'env' && <div>
        <label>新的 API Key<input ref={credential} aria-label="Native 新的 API Key" type="password" autoComplete="off" spellCheck={false} maxLength={16384} disabled={locked}/></label>
        <button type="button" className="secondary" disabled={locked || (draft.auth.mode === 'encrypted' && !data?.storage.persistentAvailable)} onClick={saveCredential}>设置凭据并清空输入</button>
      </div>}
    </div>}
    <details className="model-config-details model-connection-help"><summary>连接与测试说明</summary>
      <p className="hint">支持 Responses、Chat Completions 和 Anthropic Messages。连接与凭据立即保存；运行中的连接需停止后修改，已有会话引用的连接可以禁用，替换引用后才能删除。</p>
      <p className="hint">“就绪”只表示本机配置完整。打开设置和保存不会请求模型。测试仅验证所选协议的文本流，不代表工具调用兼容性。</p>
      <p className="hint">“读取可用模型”使用已保存的服务地址与凭据请求模型列表，支持 OpenAI 兼容和 Anthropic 服务，不发送对话或项目内容。列表不保证所有模型都支持所选协议、图片或工具调用；服务不支持列表时可手动填写模型 ID。读取结果仅对应当前修订，切换模型后原模型价格不会套用到新模型。</p>
      <p className="hint">“测试连接（可能计费）”发送一次固定文本请求，上限 256 tokens、30 秒超时，不发送项目内容、不调用工具、不自动重试。取消不保证免计费，测试结果仅对应当前修订。</p>
      <p className="hint">仅本次内存的凭据会在退出后清除；系统加密保存需可用的安全存储。</p>
    </details>
  </section>;
}
