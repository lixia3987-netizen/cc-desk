import { Check } from 'lucide-react';
import type { ThemeId } from '../shared/theme';
import { THEMES } from './themes';

export function ThemePicker({value, onChange, disabled = false}: {value: ThemeId; onChange: (value: ThemeId) => void; disabled?: boolean}) {
  return <fieldset className="theme-picker" disabled={disabled} aria-describedby="theme-picker-help">
    <legend>外观主题</legend>
    <p id="theme-picker-help" className="theme-picker-help">选择后即时预览，保存设置后记住。关闭弹窗可取消未保存的更改。</p>
    <div className="theme-grid">{THEMES.map(theme => <label className="theme-card" key={theme.id}>
      <input type="radio" name="appearance-theme" aria-label={theme.name} value={theme.id} checked={value === theme.id} onChange={() => onChange(theme.id)}/>
      <span className="theme-preview" data-theme={theme.id} aria-hidden="true">
        <span className="theme-preview-sidebar"><span className="theme-preview-accent"/><span className="theme-preview-line"/><span className="theme-preview-line"/></span>
        <span className="theme-preview-content"><span className="theme-preview-line"/><span className="theme-preview-line"/><span className="theme-preview-line"/><span className="theme-preview-accent"/></span>
      </span>
      <span className="theme-card-title"><strong>{theme.name}</strong><span className="theme-card-mode">{theme.scheme === 'light' ? '浅色' : '深色'}</span>{value === theme.id && <Check className="theme-selected" size={14} aria-hidden="true"/>}</span>
      <span className="theme-card-description">{theme.description}</span>
    </label>)}</div>
  </fieldset>;
}
