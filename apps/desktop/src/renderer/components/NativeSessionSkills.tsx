import { useEffect } from 'react';
import type { Session } from '../../shared/types';
import type { EngineConfig } from '../../shared/execution';
import { NativeSessionSkillsDraftStore, savedLegacySkillPaths } from '../native-session-skills-drafts';
import { NativeProjectSkills } from './NativeProjectSkills';

interface Props {
  session: Session;
  store: NativeSessionSkillsDraftStore;
  disabled?: boolean;
  parentDirty?: boolean;
  canEdit?(): boolean;
  onSaved?(config: EngineConfig): void;
}

/** This surface manages the existing manual project guides; catalog activation remains unavailable. */
export function NativeSessionSkills({ session, store, disabled = false, parentDirty = false, canEdit, onSaved }: Props) {
  const entry = store.get(session.id), persisted = JSON.stringify(session.engineConfig);
  const api = typeof window === 'undefined' ? undefined : window.desktop.nativeSkills;
  useEffect(() => {
    store.observeConfig(session.id, session.engineConfig);
    if (api) void store.read(session.id, api);
  }, [store, session.id, persisted, api]);
  const v2 = session.engineConfig.schemaVersion === 2;
  const pending = entry?.saving ?? false, loading = entry?.loading ?? false;
  const locked = disabled || parentDirty;
  const read = () => { if (api && !pending && !loading) void store.read(session.id, api); };
  const save = () => {
    if (!api || locked || loading || pending || canEdit?.() === false || entry?.conflict && !entry.attempt) return;
    void store.save(session.id, api).then(result => { if (result && !store.get(session.id)?.conflict) onSaved?.(result.config); });
  };
  return <section className="native-session-skills" aria-label="会话技能配置" aria-busy={loading || pending}>
    <h4>{v2 ? '项目技能选择' : '升级技能配置'}</h4>
    <p className="panel-note">手动选择的项目技能会在下一轮读取完整文件，仍遵守 AGENTS.md / CLAUDE.md。技能目录与自动匹配尚未开放。</p>
    {!v2 && <p className="panel-note">升级会先备份原配置，保留已保存的全部路径，包括当前找不到的文件；技能读取方式保持不变。</p>}
    {loading && <p className="panel-note" role="status">正在读取技能配置…</p>}
    {parentDirty && <p className="panel-note" role="status">请先保存或放弃会话草稿，再单独操作技能配置。</p>}
    {entry?.error && <p className="panel-note warning" role="alert">{entry.error}</p>}
    {entry?.notice && <p className="panel-note" role="status">{entry.notice}{entry.dirty ? ' 当前还有未保存的技能选择。' : ''}</p>}
    {entry?.conflict && <div className="panel-note warning" role="alert">
      <p>此会话的已保存配置发生变化，当前技能选择已保留。请先核对最新配置，再决定如何保存。</p>
      <button type="button" className="secondary compact" disabled={locked || loading || pending || !entry.view} onClick={() => store.resolve(session.id, false)}>读取已保存技能选择</button>
      {v2 && <button type="button" className="secondary compact" disabled={locked || loading || pending || !entry.view} onClick={() => store.resolve(session.id, true)}>基于最新配置保留选择</button>}
    </div>}
    {(entry?.error || entry?.conflict && !entry.view) && <button type="button" className="secondary compact" disabled={locked || loading || pending || !api} onClick={read}>重新读取技能配置</button>}
    {v2 && <>
      <NativeProjectSkills sessionId={session.id} selected={entry?.selected ?? savedLegacySkillPaths(session.engineConfig)}
        disabled={locked || loading || !!entry?.conflict || !entry?.view} onChange={paths => { if (canEdit?.() !== false) store.change(session.id, paths); }} />
      {!!entry?.view?.pinDiagnostics.some(pin => pin.status !== 'available') && <div className="panel-note warning" role="status">
        <p>已选文件读取情况；全部选择已保留，可以预览核对或取消选择。</p>
        <ul>{entry.view.pinDiagnostics.filter(pin => pin.status !== 'available').map(pin => <li key={pin.path}>{pin.path} · {pin.status === 'unverified' ? '尚未核查' : '当前不可用'}：{pin.message ?? (pin.status === 'unverified' ? '本次尚未检查此文件' : '当前无法读取')}</li>)}</ul>
      </div>}
      {entry?.dirty && !entry.conflict && <p className="panel-note" role="status">技能选择尚未保存；切换分类或会话会保留选择。</p>}
      {entry?.dirty && !entry.conflict && <button type="button" className="secondary compact" disabled={locked || loading || pending} onClick={() => store.resolve(session.id, false)}>放弃技能选择修改</button>}
      <button type="button" className="secondary compact" disabled={locked || loading || pending || !entry?.attempt && (!entry?.view || entry.conflict || !entry.dirty)} onClick={save}>
        {pending ? '正在保存技能选择…' : entry?.attempt ? '重试保存技能选择' : '保存技能选择'}
      </button>
      {entry?.attempt && !pending && <p className="panel-note">重试会核对上次提交的选择；之后的新修改仍会保留。</p>}
    </>}
    {!v2 && <button type="button" className="secondary compact" disabled={locked || loading || pending || !entry?.attempt && (!entry?.view || entry.conflict)} onClick={save}>
      {pending ? '正在升级技能配置…' : entry?.attempt ? '重试升级技能配置' : '升级技能配置'}
    </button>}
    {!v2 && entry?.attempt && !pending && <button type="button" className="secondary compact" disabled={locked || loading || !entry.view} onClick={() => store.resolve(session.id, false)}>放弃本次升级重试</button>}
  </section>;
}
