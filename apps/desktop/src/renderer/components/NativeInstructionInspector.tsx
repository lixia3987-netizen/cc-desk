import { useEffect, useRef, useState } from 'react';
import type { NativeInstructionsPreview, NativeSkillPreview } from '../../shared/native-skills';

/** Plain text only: source content cannot create links, execute HTML, or trigger imports. */
export function NativeSourcePreview({ source }: { source: NativeSkillPreview | NativeInstructionsPreview['sources'][number] }) {
  return <details className="native-source-preview" open>
    <summary>{source.path}</summary>
    <p className="panel-note">{'scope' in source && <>作用域：{source.scope} · </>}{source.bytes} 字节<br />SHA-256：{source.hash}</p>
    <pre>{source.content}</pre>
  </details>;
}

export function NativeInstructionSources({ result }: { result: NativeInstructionsPreview }) {
  return <div className="native-instruction-sources">
    <p className="panel-note">目录：{result.targetPath}。以下按从项目根到目标目录的加载顺序排列；深层优先，同层 AGENTS.md 优先于 CLAUDE.md。用户指令优先。</p>
    {result.sources.map(source => <NativeSourcePreview key={source.path} source={source} />)}
    {!result.sources.length && <p className="panel-note" role="status">此目录未发现适用的 AGENTS.md 或 CLAUDE.md。</p>}
  </div>;
}

export function NativeInstructionInspector({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const [targetPath, setTargetPath] = useState('.');
  const [result, setResult] = useState<NativeInstructionsPreview>();
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const request = useRef(0);
  useEffect(() => {
    request.current++; setTargetPath('.'); setResult(undefined); setLoading(false); setError('');
    return () => { request.current++; };
  }, [sessionId]);
  const inspect = async () => {
    if (disabled || loading || !targetPath) return;
    const current = ++request.current;
    setLoading(true); setResult(undefined); setError('');
    try {
      const next = await window.desktop.nativeSkills.inspectInstructions({ sessionId, targetPath });
      if (request.current === current) setResult(next);
    } catch {
      if (request.current === current) setError('读取指令失败，请检查项目相对目录及文件权限、编码和大小。');
    } finally {
      if (request.current === current) setLoading(false);
    }
  };
  return <details className="native-skill-issues">
    <summary>检查项目指令来源</summary>
    <label>项目相对目录<input aria-label="指令目标目录" value={targetPath} disabled={disabled || loading} maxLength={4096} onChange={event => { setTargetPath(event.target.value); setResult(undefined); setError(''); }} /></label>
    <button type="button" className="secondary compact" disabled={disabled || loading || !targetPath} onClick={() => void inspect()}>{loading ? '正在检查指令…' : '读取适用指令'}</button>
    {error && <p className="panel-note warning" role="alert">{error}</p>}
    {result && <NativeInstructionSources result={result} />}
    <p className="panel-note">仅预览当前文件，不请求模型。修改请使用编辑器；下一回合和工具执行前重新读取适用来源。</p>
  </details>;
}
