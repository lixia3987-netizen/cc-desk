import { useEffect, useRef, useState } from 'react';
import type { NativeSkillsListResult } from '../../shared/native-skills';

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

export function NativeProjectSkillChoices({ selected, disabled = false, onChange, result }: Omit<Props, 'sessionId'> & { result?: NativeSkillsListResult }) {
  const entries = result?.entries ?? [];
  const missing = selected.filter(path => !entries.some(entry => entry.path === path));
  const choice = (path: string, name: string, available: boolean) => {
    const checked = selected.includes(path);
    const locked = disabled || (!checked && (!available || selected.length >= selectionLimit));
    const issue = result?.issues.find(item => item.path === path);
    return <label className="native-project-skill" key={path}>
      <input type="checkbox" aria-label={path} checked={checked} disabled={locked} onChange={() => {
        if (!locked) onChange(toggleProjectSkill(selected, path));
      }} />
      <span><strong>{name}</strong><small>{path}</small>
        {!available && <small className={result ? 'native-skill-warning' : ''}>{result ? issue?.message ?? '当前列表中不可用，已保留选择；可取消勾选。' : '已保存的选择，尚未读取项目目录。'}</small>}
      </span>
    </label>;
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
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);
  const refresh = async () => {
    if (disabled || loading) return;
    const current = ++request.current;
    setLoading(true); setError('');
    try {
      const next = await window.desktop.nativeSkills.list({ sessionId });
      if (request.current === current) setResult(next);
    } catch {
      if (request.current === current) setError('读取项目 Skills 失败，请重试；已有选择已保留。');
    } finally {
      if (request.current === current) setLoading(false);
    }
  };
  return <section className="native-project-skills" aria-label="项目 Skills">
    <div className="native-project-skills-heading"><h4>项目 Skills</h4><span>已选 {selected.length} / {selectionLimit}</span></div>
    <p className="panel-note">从项目的 .agents/skills 与 .claude/skills 读取。读取目录不会请求模型。</p>
    <button type="button" className="secondary compact" disabled={disabled || loading} onClick={() => void refresh()}>{loading ? '正在读取项目 Skills…' : result ? '刷新项目 Skills' : '读取项目 Skills'}</button>
    {error && <p className="panel-note warning" role="alert">{error}</p>}
    <NativeProjectSkillChoices selected={selected} disabled={disabled || loading} onChange={onChange} result={result} />
    <p className="panel-note">默认不启用。保存配置后下一轮生效，仍遵守 AGENTS.md / CLAUDE.md。</p>
    <details className="native-skill-issues"><summary>读取规则</summary><p>名称来自目录，不解析 frontmatter 配置，不自动执行脚本。</p></details>
  </section>;
}

/** A session change unmounts pending discovery so late results cannot reach another session. */
export function NativeProjectSkills(props: Props) {
  return <NativeProjectSkillsForSession key={props.sessionId} {...props} />;
}
