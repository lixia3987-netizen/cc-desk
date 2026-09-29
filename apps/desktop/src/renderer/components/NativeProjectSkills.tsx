import { useEffect, useRef, useState } from 'react';
import type { NativeSkillPreview, NativeSkillsListResult } from '../../shared/native-skills';
import { NativeInstructionInspector, NativeSourcePreview } from './NativeInstructionInspector';

interface Props {
  sessionId: string;
  selected: readonly string[];
  disabled?: boolean;
  onChange(paths: string[]): void;
}

const selectionLimit = 16;

/** Discovery never rewrites the saved selection, including missing or rejected paths. */
export function toggleProjectSkill(selected: readonly string[], path: string): string[] {
  if (selected.includes(path)) return selected.filter(value => value !== path);
  return selected.length < selectionLimit ? [...selected, path] : [...selected];
}

export function NativeProjectSkillChoices({ selected, disabled = false, onChange, result, onInspect }: Omit<Props, 'sessionId'> & { result?: NativeSkillsListResult; onInspect?(path: string): void }) {
  const entries = result?.entries ?? [];
  const missing = selected.filter(path => !entries.some(entry => entry.path === path));
  const choice = (path: string, name: string, available: boolean) => {
    const checked = selected.includes(path);
    const locked = disabled || (!checked && (!available || selected.length >= selectionLimit));
    const issue = result?.issues.find(item => item.path === path);
    return <div className="native-project-skill-row" key={path}><label className="native-project-skill">
      <input type="checkbox" aria-label={path} checked={checked} disabled={locked} onChange={() => {
        if (!locked) onChange(toggleProjectSkill(selected, path));
      }} />
      <span><strong>{name}</strong><small>{path}</small>
        {!available && <small className={result ? 'native-skill-warning' : ''}>{result ? issue?.message ?? '不在默认目录列表或当前不可用，已保留选择；可预览检查或取消勾选。' : '已保存的选择，尚未读取项目目录。'}</small>}
      </span>
    </label>{onInspect && <button type="button" className="secondary compact" disabled={disabled} onClick={() => onInspect(path)} aria-label={`预览 ${path}`}>预览</button>}</div>;
  };
  return <>
    {(entries.length > 0 || missing.length > 0) && <div className="native-project-skill-list">
      {entries.map(entry => choice(entry.path, entry.name, true))}
      {missing.map(path => choice(path, path.split('/').at(-2) || path, false))}
    </div>}
    {result && entries.length === 0 && <p className="panel-note" role="status">未发现可选的项目 Skills。</p>}
    {selected.length >= selectionLimit && <p className="panel-note">最多选择 {selectionLimit} 项；可先取消已有选择。</p>}
    {result?.truncated && <p className="panel-note warning" role="status">目录列表已达读取上限，部分项目可能未显示；已有选择仍保留。</p>}
    {!!result?.issues.length && <details className="native-skill-issues"><summary>有 {result.issues.length} 项无法读取</summary>
      <ul>{result.issues.map((issue, index) => <li key={`${issue.path}:${index}`}><code>{issue.path}</code>：{issue.message}</li>)}</ul>
    </details>}
  </>;
}

function NativeProjectSkillsForSession({ sessionId, selected, disabled = false, onChange }: Props) {
  const [result, setResult] = useState<NativeSkillsListResult>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [customPath, setCustomPath] = useState('');
  const [preview, setPreview] = useState<NativeSkillPreview>();
  const request = useRef(0);
  useEffect(() => {
    request.current++; setResult(undefined); setLoading(false); setError(''); setCustomPath(''); setPreview(undefined);
    return () => { request.current++; };
  }, [sessionId]);
  const refresh = async () => {
    if (disabled || loading) return;
    const current = ++request.current;
    setLoading(true); setError(''); setPreview(undefined);
    try {
      const next = await window.desktop.nativeSkills.list({ sessionId });
      if (request.current === current) setResult(next);
    } catch {
      if (request.current === current) setError('读取项目 Skills 失败，请重试；已有选择已保留。');
    } finally {
      if (request.current === current) setLoading(false);
    }
  };
  const inspect = async (path: string) => {
    if (disabled || loading || !path) return;
    const current = ++request.current;
    setLoading(true); setError(''); setPreview(undefined); setCustomPath(path);
    try {
      const next = await window.desktop.nativeSkills.inspect({ sessionId, path });
      if (request.current === current) setPreview(next);
    } catch {
      if (request.current === current) setError('预览 Skill 失败。请检查项目相对路径、文件权限、编码和大小；已有选择已保留。');
    } finally {
      if (request.current === current) setLoading(false);
    }
  };
  const choices = preview ? { entries: [...(result?.entries ?? []).filter(entry => entry.path !== preview.path), preview].sort((a, b) => a.path.localeCompare(b.path)), issues: result?.issues ?? [], truncated: result?.truncated ?? false } : result;
  return <section className="native-project-skills" aria-label="项目 Skills">
    <div className="native-project-skills-heading"><h4>项目 Skills</h4><span>已选 {selected.length} / {selectionLimit}</span></div>
    <p className="panel-note">从项目的 .agents/skills 与 .claude/skills 读取。读取目录不会请求模型。</p>
    <button type="button" className="secondary compact" disabled={disabled || loading} onClick={() => void refresh()}>{loading ? '正在读取项目 Skills…' : result ? '刷新项目 Skills' : '读取项目 Skills'}</button>
    {error && <p className="panel-note warning" role="alert">{error}</p>}
    <NativeProjectSkillChoices selected={selected} disabled={disabled || loading} onChange={onChange} result={choices} onInspect={path => void inspect(path)} />
    <details className="native-skill-issues"><summary>添加其他项目 Skill</summary>
      <label>项目相对路径<input aria-label="其他 Skill 路径" placeholder="tools/skills/review/SKILL.md" maxLength={4096} value={customPath} disabled={disabled || loading} onChange={event => { setCustomPath(event.target.value); setPreview(undefined); setError(''); }} /></label>
      <button type="button" className="secondary compact" disabled={disabled || loading || !customPath} onClick={() => void inspect(customPath)}>读取 Skill 预览</button>
      <p className="panel-note">支持项目内普通目录中的 SKILL.md。仅按明确路径读取，不扫描其他目录或 HOME。</p>
    </details>
    {preview && <><NativeSourcePreview source={preview} /><button type="button" className="secondary compact" disabled={disabled || loading || selected.includes(preview.path) || selected.length >= selectionLimit} onClick={() => {
      if (!disabled && !loading && !selected.includes(preview.path)) onChange(toggleProjectSkill(selected, preview.path));
    }}>{selected.includes(preview.path) ? '已在选择中' : '加入 Skills 选择'}</button><p className="panel-note">预览是当前快照；加入选择后仍需保存配置。修改请使用编辑器，运行时重新读取文件。</p></>}
    <p className="panel-note">默认不启用。保存配置后下一轮生效，仍遵守 AGENTS.md / CLAUDE.md。</p>
    <details className="native-skill-issues"><summary>读取规则</summary><p>名称来自目录，不解析 frontmatter 配置，不自动执行脚本。</p></details>
    <NativeInstructionInspector sessionId={sessionId} disabled={disabled || loading} />
  </section>;
}

/** A session change unmounts pending discovery so late results cannot reach another session. */
export function NativeProjectSkills(props: Props) {
  return <NativeProjectSkillsForSession key={props.sessionId} {...props} />;
}
