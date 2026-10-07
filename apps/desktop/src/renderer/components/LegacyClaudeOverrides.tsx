import type { EngineConfig } from '../../shared/execution';

/** Allow existing overrides to return to CLI configuration without managing CLI models here. */
export function LegacyClaudeOverrides({ config, disabled, onChange }: { config: EngineConfig; disabled: boolean; onChange(config: EngineConfig): void }) {
  const model = config.options.model, effort = config.options.effort;
  const legacy = typeof model === 'string' && !!model || typeof effort === 'string' && !!effort && effort !== 'default';
  if (!legacy) return null;
  return <details className="legacy-claude-overrides">
    <summary>高级：旧版工作台覆盖</summary>
    <p className="hint">此前保存的模型：{typeof model === 'string' && model || '跟随 CLI'}；强度：{typeof effort === 'string' && effort || 'default'}。模型与强度由 Claude Code 管理，旧覆盖继续保留，直到主动清除。</p>
    <button type="button" className="secondary compact" disabled={disabled} onClick={() => onChange({ ...config, options: { ...config.options, model: '', effort: 'default' } })}>清除旧模型与强度覆盖</button>
    <p className="hint">清除后需保存配置，将跟随 CLI 设置。</p>
  </details>;
}
