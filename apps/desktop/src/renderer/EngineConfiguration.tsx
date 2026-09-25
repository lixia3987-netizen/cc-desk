import type { EngineConfig, EngineConfigField, ExecutionDescriptor, JsonValue } from '../shared/execution';
import type { Session, Settings } from '../shared/types';

export function engineDefaults(descriptor: ExecutionDescriptor | undefined, settings: Settings | undefined): EngineConfig {
  return structuredClone((descriptor && settings?.engineDefaults[descriptor.providerId]) ?? descriptor?.configuration?.defaults ?? { schemaVersion: 1, options: {} });
}

function sameJsonValue(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((value, index) => sameJsonValue(value, right[index]));
  if (Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameJsonValue(left[key], right[key]));
}

/** Saving re-parses objects; property order and object identity are not edits. */
export function sameEngineDefaults(left: Settings['engineDefaults'], right: Settings['engineDefaults']): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) &&
    left[key].schemaVersion === right[key].schemaVersion && sameJsonValue(left[key].options, right[key].options));
}

export function configurationSupported(descriptor: ExecutionDescriptor | undefined, config: EngineConfig): boolean {
  return !!descriptor && config.schemaVersion > 0 && (!descriptor.configuration || descriptor.configuration.schemaVersion === config.schemaVersion);
}

export function executionUnavailable(descriptor: ExecutionDescriptor | undefined, session: Session): string | undefined {
  if (!descriptor) return `未安装会话执行器：${session.execution.providerId} / ${session.execution.mode}。仅查看已保存的记录。`;
  if (!configurationSupported(descriptor, session.engineConfig)) return `${descriptor.displayName ?? descriptor.providerId} 不支持此会话的配置版本 ${session.engineConfig.schemaVersion}。原配置与记录已保留。`;
  if (descriptor.maintenance) return `${descriptor.displayName ?? descriptor.providerId} 正在维护，请在完成后手动继续。草稿与已有记录仍可查看。`;
  if (!descriptor.capabilities.available) return descriptor.capabilities.error || `${descriptor.displayName ?? descriptor.providerId} 尚未就绪，请检查该引擎的连接设置。`;
  return undefined;
}

interface Props {
  value: EngineConfig; fields: EngineConfigField[]; onChange(value: EngineConfig): void;
  disabled?: boolean; prefix?: string; running?: boolean;
}

/** Descriptions contain presentation data; providers still validate every write. */
export function EngineConfigFields({ value, fields, onChange, disabled = false, prefix = '', running = false }: Props) {
  return <>{fields.map(field => {
    const raw = value.options[field.key];
    const scalar = raw === undefined || typeof raw === 'string';
    const text = raw === undefined ? '' : typeof raw === 'string' ? raw : JSON.stringify(raw);
    const label = prefix + field.label;
    const locked = disabled || !scalar || (running && field.apply === 'stopped');
    const change = (next: string) => onChange({ ...value, options: { ...value.options, [field.key]: next } });
    return <div className="engine-config-field" key={field.key}>
      <label>{label}{field.type === 'select' ? <select aria-label={label} value={text} disabled={locked} onChange={event => change(event.target.value)}>
        {!field.options?.some(option => option.value === text) && <option value={text}>{text || '未设置'} · 当前保存值</option>}
        {field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select> : <input aria-label={label} value={text} placeholder={field.placeholder} disabled={locked} onChange={event => change(event.target.value)} />}</label>
      {field.description && <p className="hint">{field.description}</p>}
      {!scalar && <p className="hint">当前值无法使用此控件编辑，原始配置已保留。</p>}
      {running && field.apply === 'stopped' && <p className="hint">停止会话后可修改此项。</p>}
    </div>;
  })}</>;
}
