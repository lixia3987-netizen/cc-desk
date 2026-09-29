import { useEffect, useRef, useState } from 'react';
import type { NativeMcpConnectionList } from '../../shared/native-mcp';

interface Props {
  sessionId: string;
  selected: readonly string[];
  disabled?: boolean;
  onChange(ids: string[]): void;
}

const selectionLimit = 4;

export function toggleMcpConnection(selected: readonly string[], id: string): string[] {
  if (selected.includes(id)) return selected.filter(value => value !== id);
  return selected.length < selectionLimit ? [...selected, id] : [...selected];
}

/** Missing or disabled choices are retained until the user explicitly removes them. */
export function NativeMcpChoices({ selected, disabled = false, onChange, result }: Omit<Props, 'sessionId'> & { result?: NativeMcpConnectionList }) {
  const entries = result?.connections ?? [];
  const missing = selected.filter(id => !entries.some(entry => entry.id === id));
  const choice = (id: string, name: string, ready: boolean, detail: string) => {
    const checked = selected.includes(id);
    const locked = disabled || (!checked && (!ready || selected.length >= selectionLimit));
    return <label className="native-project-skill" key={id}>
      <input type="checkbox" aria-label={`MCP ${name} (${id})`} checked={checked} disabled={locked} onChange={() => {
        if (!locked) onChange(toggleMcpConnection(selected, id));
      }} />
      <span><strong>{name}</strong><small>连接 ID：{id}</small><small className={!ready && result ? 'native-skill-warning' : ''}>{detail}</small></span>
    </label>;
  };
  return <>
    {(entries.length > 0 || missing.length > 0) && <div className="native-project-skill-list">
      {entries.map(item => choice(item.id, item.name, item.ready && !result?.error,
        `${item.enabled ? item.ready ? '本机配置就绪' : '未就绪' : '已禁用'} · ${item.transport === 'stdio' ? 'stdio' : 'HTTP'} · 协议 ${item.protocolVersion} · ${item.transport === 'stdio' ? item.executable : item.endpoint}${item.error ? ` · ${item.error}` : ''}`))}
      {missing.map(id => choice(id, id, false, result ? '连接当前不可用，已保留选择；可取消勾选。' : '已保存的选择，尚未读取连接列表。'))}
    </div>}
    {result && entries.length === 0 && !result.error && <p className="panel-note" role="status">尚无 MCP 连接，请先在“设置与连接”中新增。</p>}
    {selected.length >= selectionLimit && <p className="panel-note">最多选择 {selectionLimit} 项；可先取消已有选择。</p>}
  </>;
}

function NativeMcpSelectionForSession({ selected, disabled = false, onChange }: Props) {
  const [result, setResult] = useState<NativeMcpConnectionList>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const reading = useRef(false);
  useEffect(() => () => { request.current++; }, []);
  const refresh = async () => {
    if (disabled || reading.current) return;
    const current = ++request.current;
    reading.current = true; setLoading(true); setError('');
    try {
      const next = await window.desktop.nativeMcp.list();
      if (request.current === current) { setResult(next); if (next.error) setError(next.error); }
    } catch {
      if (request.current === current) { setResult(undefined); setError('读取 MCP 连接失败，请重试；已有选择已保留。'); }
    } finally {
      if (request.current === current) { reading.current = false; setLoading(false); }
    }
  };
  return <section className="native-project-skills native-mcp-selection" aria-label="会话 MCP 工具">
    <div className="native-project-skills-heading"><h4>MCP 工具</h4><span>已选 {selected.length} / {selectionLimit}</span></div>
    <p className="panel-note">读取列表只查看本机保存的连接，不访问远端服务或启动本地程序。</p>
    <button type="button" className="secondary compact" disabled={disabled || loading} onClick={() => void refresh()}>{loading ? '正在读取 MCP 连接…' : result ? '刷新 MCP 连接' : '读取 MCP 连接'}</button>
    {error && <p className="panel-note warning" role="alert">{error}</p>}
    <NativeMcpChoices selected={selected} disabled={disabled || loading} onChange={onChange} result={result} />
    <p className="panel-note">默认不启用。停止会话后修改并保存，下一轮任务连接所选服务。stdio 每回合启动前需审批，每次工具调用仍需审批。</p>
  </section>;
}

/** A new session owns a fresh request generation; late responses cannot cross sessions. */
export function NativeMcpSelection(props: Props) {
  return <NativeMcpSelectionForSession key={props.sessionId} {...props} />;
}
