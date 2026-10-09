import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClaudeModelImportPreview, ClaudeModelImportResult } from '../../shared/claude-model-import';
import type { NativeConnectionList } from '../../shared/native-connections';
import { nativeConnectionsChanged } from '../useNativeConnectionReadiness';

/** Configuration previews contain metadata only; credentials stay in the main process. */
export function NativeModelImport({ disabled = false, onConnections }: { disabled?: boolean; onConnections(): void }) {
  const api = window.desktop.claudeModelImport;
  const connections = window.desktop.nativeConnections;
  const [data, setData] = useState<NativeConnectionList>();
  const [preview, setPreview] = useState<ClaudeModelImportPreview>();
  const [model, setModel] = useState('');
  const [credentialMode, setCredentialMode] = useState<'memory' | 'encrypted'>('memory');
  const [allowLoopbackHttp, setAllowLoopbackHttp] = useState(false);
  const [result, setResult] = useState<ClaudeModelImportResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const pending = useRef(false);
  const refresh = useCallback(async () => {
    if (!connections) return;
    const next = await connections.list();
    if (mounted.current) setData(next);
  }, [connections]);
  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => { if (mounted.current) setError('读取导入设置失败，请刷新重试。'); });
    return () => { mounted.current = false; };
  }, [refresh]);
  const action = async (work: () => Promise<void>) => {
    if (disabled || pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { await work(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '模型导入失败，请重新读取配置。'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const locked = disabled || busy || !data || Boolean(data.error);
  const readClaude = (source: 'default' | 'file') => {
    if (!api || locked || pending.current) return;
    setPreview(undefined); setResult(undefined);
    void action(async () => {
      const next = await api.preview({ source });
      if (!mounted.current || !next) return;
      const choices = next.models.filter(item => item.nativeImportable);
      setModel(choices.find(item => item.model === next.model)?.model ?? (choices.length === 1 ? choices[0].model : ''));
      setCredentialMode('memory'); setAllowLoopbackHttp(false); setPreview(next);
    });
  };
  const importModel = () => {
    if (!api || locked || pending.current || !preview || !model || (preview.requiresLoopbackHttp && !allowLoopbackHttp)) return;
    const selected = preview;
    // Every confirmation consumes its preview, including a failed attempt.
    setPreview(undefined);
    void action(async () => {
      const imported = await api.import({ token: selected.token, model, credentialMode, allowLoopbackHttp });
      window.dispatchEvent(new Event(nativeConnectionsChanged));
      if (mounted.current) setResult(imported);
    });
  };
  return <section className="settings-section native-model-import" aria-label="Native 模型导入">
    <div className="settings-card-heading"><h4>从 Claude Code 导入模型</h4><button type="button" className="secondary compact" disabled={disabled || busy || !connections} onClick={() => void action(refresh)}>刷新</button></div>
    <p className="settings-description">读取 Claude Code 配置，将服务地址、模型和 API 凭据转换为自研 Agent 模型连接。</p>
    {(!api || !connections) && <p role="status" className="hint">当前桌面版本尚未提供模型导入。</p>}
    {data?.storage.reason && <p className="hint">{data.storage.reason}</p>}
    {(error || data?.error) && <p className="settings-error" role="alert">{error || data?.error}</p>}
    <div className="model-connection-actions">
      {api && <><button type="button" className="primary" disabled={locked} onClick={() => readClaude('default')}>从 Claude 默认配置导入</button><button type="button" className="secondary" disabled={locked} onClick={() => readClaude('file')}>选择 Claude 配置文件</button></>}
    </div>
    {busy && <p className="hint" role="status">正在处理模型配置…</p>}
    {preview && <section className="native-connection-editor" aria-label="Claude 模型导入预览">
      <h4>导入为自研 Agent 模型</h4>
      <p className="hint">来源：{preview.sourcePath}<br/>服务地址：{preview.baseURL}<br/>协议：Anthropic Messages<br/>凭据：{preview.credential.configured ? '已读取（内容不显示）' : '未读取，导入后需单独设置'}</p>
      <label>导入模型<select aria-label="导入模型" value={model} disabled={locked} onChange={event => setModel(event.target.value)}>
        <option value="">请选择模型</option>{preview.models.map(item => <option key={item.model} value={item.model} disabled={!item.nativeImportable}>{item.model}{item.nativeImportable ? '' : '（需配置具体模型 ID）'}</option>)}
      </select></label>
      {preview.credential.configured && <label>凭据保存方式<select aria-label="导入凭据保存方式" value={credentialMode} disabled={locked} onChange={event => setCredentialMode(event.target.value as 'memory' | 'encrypted')}>
        <option value="memory">仅本次应用内存</option><option value="encrypted" disabled={!data?.storage.persistentAvailable}>系统安全存储加密保存{data?.storage.persistentAvailable ? '' : '（不可用）'}</option>
      </select></label>}
      {preview.requiresLoopbackHttp && <label className="checkbox"><input aria-label="允许导入本地回环 HTTP" type="checkbox" checked={allowLoopbackHttp} disabled={locked} onChange={event => setAllowLoopbackHttp(event.target.checked)}/><span>明确允许此本地回环地址使用 HTTP</span></label>}
      {preview.warnings.map((warning, index) => <p className="hint" key={index}>{warning}</p>)}
      <p className="hint">预览五分钟有效。确认后保存为独立模型连接。</p>
      <div className="settings-footer-actions"><button type="button" className="secondary" disabled={locked} onClick={() => setPreview(undefined)}>取消导入</button><button type="button" className="primary" disabled={locked || !model || Boolean(preview.requiresLoopbackHttp && !allowLoopbackHttp)} onClick={importModel}>确认导入模型连接</button></div>
    </section>}
    {result && <section className="native-connection-editor" aria-label="模型导入结果">
      <h4>模型连接已导入</h4>
      <p className="hint" role="status">{result.notice ?? '已从 Claude Code 配置创建自研 Agent 模型连接。'}</p>
      <p className="hint">模型：{result.connection.model}<br/>服务地址：{result.connection.baseURL}</p>
      {!result.connection.ready && <p className="hint">此连接尚未就绪，请前往“模型连接”编辑并补充凭据。</p>}
      <div className="settings-footer-actions"><button type="button" className="secondary" disabled={disabled || busy} onClick={onConnections}>前往模型连接</button></div>
    </section>}
    <p className="hint">Claude Code 仅作为配置来源。导入不会修改其配置，也不会读取 Claude 登录凭据。</p>
  </section>;
}
