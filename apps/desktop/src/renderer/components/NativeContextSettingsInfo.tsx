import { useEffect, useState } from 'react';
import type { EngineConfig } from '../../shared/execution';
import type { NativeModelCapabilitySnapshot } from '../../shared/native-connections';
import { ModelCapabilityInfo } from './ModelCapabilityInfo';

/** Capability metadata is read-only and tied to the selected connection/model. */
export function NativeContextSettingsInfo({ config }: { config: EngineConfig }) {
  const [snapshot, setSnapshot] = useState<NativeModelCapabilitySnapshot>();
  const [loading, setLoading] = useState(false);
  const connectionId = typeof config.options.connectionId === 'string' ? config.options.connectionId : '';
  const model = typeof config.options.model === 'string' ? config.options.model : undefined;
  useEffect(() => {
    let cancelled = false;
    setSnapshot(undefined);
    const api = window.desktop?.nativeConnections;
    if (!connectionId || !api?.modelCapabilities) { setLoading(false); return; }
    setLoading(true);
    void api.list().then(async data => {
      const connection = data.connections.find(item => item.id === connectionId);
      if (!connection || cancelled) return;
      const result = await api.modelCapabilities({ id: connectionId, revision: connection.revision, model: model || undefined });
      if (!cancelled) setSnapshot(result);
    }).catch(() => { /* Unknown metadata keeps the bounded fallback policy available. */ }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [connectionId, model]);
  return <div className="settings-resource-note" aria-label="模型容量">
    <strong>模型窗口（只读）</strong>
    <p className="hint">{loading ? '正在读取模型能力…' : <ModelCapabilityInfo capabilities={snapshot?.capabilities} conservative={snapshot?.conservative}/>}</p>
    <p className="hint">优先采用服务端与模型目录元数据，缺失字段使用本地能力表。输入预算与模型窗口分别管理。</p>
  </div>;
}
