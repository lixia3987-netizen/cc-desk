import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, Bot, Check, FolderCog, FolderOpen, Layers, Loader2, Palette, Plug, RefreshCw, Terminal, Trash2, Upload } from 'lucide-react';
import type { Capabilities, Session, Settings } from '../shared/types';
import { DEFAULT_TYPOGRAPHY, fontFamily, systemFontFamily, typography, type FontId, type ImportedFont, type SystemFont } from '../shared/fonts';
import { listSystemFonts } from './system-fonts';
import { settingsSchema } from '../shared/schema';
import { normalizeThemeId } from '../shared/theme';
import type { ExecutionDescriptor } from '../shared/execution';
import { EngineConfigFields, configurationSupported, engineDefaults, sameEngineDefaults } from './EngineConfiguration';
import { ThemePicker } from './ThemePicker';
import { NativeConnections } from './components/NativeConnections';
import { NativeModelImport } from './components/NativeModelImport';
import { NativeMcpConnections } from './components/NativeMcpConnections';
import { NativeContextSettingsInfo } from './components/NativeContextSettingsInfo';
import { LegacyClaudeOverrides } from './components/LegacyClaudeOverrides';
import { SessionConfig } from './SessionConfig';
import { engineFieldsForGroup, engineGroupForKey, engineGroupTitles, type EngineSettingsGroup, type SettingsScope } from './settings-organization';
import type { ReactNode } from 'react';

const pages = [
  { id: 'appearance', title: '外观与字体', icon: Palette, description: '选择主题，分别调整聊天内容与菜单界面的阅读体验。' },
  { id: 'models', title: '模型与上下文', icon: Bot, description: '配置自研 Agent 的模型连接、上下文预算与自动压缩。Claude Code 的模型由 CLI 配置管理，导入后创建自研 Agent 连接。' },
  { id: 'terminal', title: '终端与CLI', icon: Terminal, description: '设置 Claude Code 与 Shell 路径，调整终端显示并检测 CLI。' },
  { id: 'mcp', title: '工具与扩展', icon: Plug, description: '管理全局 MCP 连接，以及当前自研 Agent 会话启用的工具与项目 Skills。' },
  { id: 'sessions', title: '运行与权限', icon: Layers, description: '设置并发数量、运行限制、失败恢复与权限策略。' },
  { id: 'workspace', title: '工作区与IDE', icon: FolderCog, description: '选择 Worktree 位置，以及打开项目的编辑器。' },
  { id: 'system', title: '应用与数据', icon: Bell, description: '设置通知、窗口关闭行为，并查看本机数据位置。' },
] as const;
export type SettingsPage = typeof pages[number]['id'];
const subpages: Record<SettingsPage, Array<{ id: string; title: string; group?: EngineSettingsGroup }>> = {
  appearance: [{ id: 'fonts', title: '字体' }, { id: 'theme', title: '主题' }],
  models: [{ id: 'connections', title: '模型连接', group: 'model' }, { id: 'import', title: '模型导入' }, { id: 'context', title: '上下文预算', group: 'context' }, { id: 'compaction', title: '自动压缩', group: 'compaction' }],
  terminal: [{ id: 'cli', title: 'Claude Code' }, { id: 'shell', title: 'Shell 与终端' }],
  mcp: [{ id: 'connections', title: 'MCP 连接' }, { id: 'tools', title: '会话工具', group: 'tools' }],
  sessions: [{ id: 'limits', title: '运行限制', group: 'limits' }, { id: 'recovery', title: '失败恢复', group: 'recovery' }, { id: 'permissions', title: '权限与审批', group: 'permissions' }],
  workspace: [{ id: 'worktree', title: 'Worktree' }, { id: 'ide', title: '外部 IDE' }],
  system: [{ id: 'behavior', title: '应用行为' }, { id: 'data', title: '本机数据' }],
};
function locationForGroup(group: EngineSettingsGroup): { page: SettingsPage; subpage: string } {
  for (const page of Object.keys(subpages) as SettingsPage[]) {
    const item = subpages[page].find(item => item.group === group);
    if (item) return { page, subpage: item.id };
  }
  return { page: 'sessions', subpage: 'limits' };
}
export interface SettingsPanelProps {
  value: Settings; saved: Settings; onChange(value: Settings): void;
  page: SettingsPage; onPage(page: SettingsPage): void;
  fonts: ImportedFont[]; onImport(): void; onRemove(id: string): void;
  busy: boolean; error: string; capabilities: Capabilities; platform: string; dataPath: string;
  onSave(detect: boolean): void; onClose(): void; onChooseIde(): void; onChooseWorktree(): void;
  cliUpdate: ReactNode; executors: ExecutionDescriptor[]; cliBusy?: boolean;
  activeSession?: Session; onSessionError(error: unknown): void;
  initialScope?: SettingsScope; initialGroup?: EngineSettingsGroup; initialSubpage?: string;
}

export function EngineDefaultsGroup({ value, onChange, executors, group, disabled }: {
  value: Settings; onChange(value: Settings): void; executors: ExecutionDescriptor[];
  group: EngineSettingsGroup; disabled: boolean;
}) {
  const defaults = [...new Map(executors.filter(item => item.configuration?.fields.length).map(item => [item.providerId, item])).values()];
  if (group === 'tools') return <p className="hint">工具按会话启用，暂不提供全局默认工具选择。切换到“当前会话”可选择 MCP 与项目 Skills。</p>;
  return <>{defaults.map(descriptor => {
    const config = engineDefaults(descriptor, value);
    const fields = engineFieldsForGroup(descriptor, group, config);
    if (!fields.length) return null;
    const controls = configurationSupported(descriptor, config) ? <EngineConfigFields value={config} fields={fields} prefix="默认" disabled={disabled || descriptor.maintenance} onChange={engineConfig => onChange({ ...value, engineDefaults: { ...value.engineDefaults, [descriptor.providerId]: engineConfig } })} /> : <p className="hint">已保存的默认配置版本暂不受支持，原值已保留。</p>;
    return <div className="settings-engine-defaults" key={descriptor.providerId}><h5>{descriptor.displayName ?? descriptor.providerId}</h5>{group === 'context' && <NativeContextSettingsInfo config={config}/>} {controls}
      {group === 'context' && config.options.inputBudgetMode === 'model' && <p className="hint">自动使用已知模型窗口，并为输出预留空间；窗口未知时采用 {Number(config.options.maxInputTokens ?? 64000).toLocaleString()} tokens 输入上限。实际预算不会超过模型输入限制。</p>}
    </div>;
  })}</>;
}

function EnginePolicySection({ scope, onScope, group, props }: { scope: SettingsScope; onScope(scope: SettingsScope): void; group: EngineSettingsGroup; props: SettingsPanelProps }) {
  const active = props.activeSession;
  const descriptor = active && props.executors.find(item => item.providerId === active.execution.providerId && item.mode === active.execution.mode);
  const currentAllowed = !!active && active.kind === 'agent';
  const nativeOnly = group !== 'permissions' && group !== 'limits';
  const current = scope === 'session'
    ? !currentAllowed ? <p className="hint">请选择一个 Agent 会话后编辑当前会话配置。</p>
      : nativeOnly && active.execution.providerId !== 'native' ? <p className="hint">此设置仅用于自研 Agent。Claude Code 的模型与工具配置由 CLI 管理。</p>
        : <SessionConfig session={active} descriptor={descriptor} onError={props.onSessionError} group={group} settings={props.saved}/>
    : <EngineDefaultsGroup value={props.value} onChange={props.onChange} executors={props.executors} group={group} disabled={props.busy}/>;
  return <section className="settings-section settings-policy-section" aria-label={engineGroupTitles[group] + '设置'}>
    <div className="settings-policy-heading"><h4>{engineGroupTitles[group]}</h4><div className="settings-scope" role="radiogroup" aria-label="设置作用范围">
      <button type="button" role="radio" aria-checked={scope === 'defaults'} disabled={props.busy} onClick={() => onScope('defaults')}>新会话默认</button>
      <button type="button" role="radio" aria-checked={scope === 'session'} disabled={props.busy || !currentAllowed} onClick={() => onScope('session')}>当前会话</button>
    </div></div>
    <p className="settings-scope-description">{scope === 'session' ? currentAllowed ? `当前会话：${active.title || active.id}。配置由下方按钮单独保存；切换分类或作用范围会放弃未保存的会话编辑。` : '尚未选择 Agent 会话。' : group === 'model' || group === 'permissions' ? '保存设置后用于新会话，已有会话的配置保持不变。' : '保存设置后用于新会话。已有会话的自定义配置保持不变；跟随默认的自研 Agent 会话在下一回合使用已保存策略。'}</p>
    {group === 'model' && scope === 'defaults' ? <details className="native-model-defaults"><summary>新会话默认模型</summary>{current}</details> : current}
    {group === 'permissions' && <p className="hint">自研 Agent 的文件写入与命令执行始终逐次审批；Claude Code 的权限模式独立设置。</p>}
  </section>;
}

function FontControl({scope, value, fonts, systemFonts, systemQuery, systemLoaded, disabled, onChange}: {scope: 'chat' | 'ui'; value: Settings; fonts: ImportedFont[]; systemFonts: SystemFont[]; systemQuery: string; systemLoaded: boolean; disabled: boolean; onChange(value: Settings): void}) {
  const settings = typography(value), isChat = scope === 'chat', title = isChat ? '聊天' : '菜单';
  const familyKey = isChat ? 'chatFontFamily' : 'uiFontFamily', sizeKey = isChat ? 'chatFontSize' : 'uiFontSize';
  const family = settings[familyKey], size = value[sizeKey] ?? DEFAULT_TYPOGRAPHY[sizeKey], maximum = isChat ? 28 : 20;
  const found = family === 'system' || fonts.some(font => font.id === family) || systemFonts.some(font => font.id === family);
  const systemName = systemFontFamily(family);
  const matches = systemFonts.filter(font => font.id === family || font.name.toLocaleLowerCase().includes(systemQuery.trim().toLocaleLowerCase()));
  return <section className="font-control" aria-label={title + '字体设置'}>
    <div className="settings-card-heading"><h4>{isChat ? '聊天内容' : '菜单与界面'}</h4><button type="button" className="text-button" disabled={disabled} aria-label={'重置' + title + '字体'} onClick={() => onChange({...value, [familyKey]: DEFAULT_TYPOGRAPHY[familyKey], [sizeKey]: DEFAULT_TYPOGRAPHY[sizeKey]})}>恢复默认</button></div>
    <p className="settings-description">{isChat ? '正文、输入框与工具内容；代码保留等宽字体。' : '侧栏、菜单、工具栏与设置；辅助文字按比例缩放。'}</p>
    <label>{title}字体<select aria-label={title + '字体'} value={family} disabled={disabled} onChange={event => onChange({...value, [familyKey]: event.target.value as FontId})}>
      <option value="system">系统默认</option>
      {!!matches.length && <optgroup label="系统已安装">{matches.map(font => <option key={font.id} value={font.id}>{font.name}</option>)}</optgroup>}
      {!!fonts.length && <optgroup label="已导入字体">{fonts.map(font => <option key={font.id} value={font.id}>{font.name}</option>)}</optgroup>}
      {!found && <option value={family}>{systemName ? systemName + (systemLoaded ? ' · 未检测到，使用系统默认' : ' · 系统字体') : '字体不可用 · 请重新选择'}</option>}
    </select></label>
    <label htmlFor={scope + '-font-size'}>{title}字号 <span className="settings-field-unit">px</span></label>
    <div className="font-size-control"><input type="range" aria-label={title + '字号滑块'} min={11} max={maximum} step={1} value={settings[sizeKey]} disabled={disabled} onChange={event => onChange({...value, [sizeKey]: Number(event.target.value)})}/><input id={scope + '-font-size'} aria-label={title + '字号'} type="number" min={11} max={maximum} step={1} required disabled={disabled} value={size} onChange={event => onChange({...value, [sizeKey]: Number(event.target.value)})}/></div>
    <div className={'font-preview ' + scope + '-font-preview'} style={{fontFamily: fontFamily(family), fontSize: settings[sizeKey]}} aria-label={title + '字体预览'}>
      <strong>{isChat ? '让每一行都清晰易读' : '项目 · 会话 · 设置'}</strong><p>{isChat ? '你好，世界。一起完成下一项任务。' : '新建会话　查看变更　保存设置'}</p><small>Aa Bb 0123456789 · {'{ code }'}</small>
    </div>
  </section>;
}

export function SettingsPanel(props: SettingsPanelProps) {
  const {value, saved, onChange, page, onPage, fonts, busy, error, capabilities: cap, platform, dataPath} = props;
  const [validation, setValidation] = useState('');
  const [scope, setScope] = useState<SettingsScope>(props.initialScope ?? 'defaults');
  const [subpageByPage, setSubpageByPage] = useState<Partial<Record<SettingsPage, string>>>(() => {
    if (props.initialGroup) {
      const location = locationForGroup(props.initialGroup);
      return { [location.page]: location.subpage };
    }
    return props.initialSubpage ? { [props.page]: props.initialSubpage } : {};
  });
  useEffect(() => {
    setScope(props.initialScope ?? 'defaults');
    if (props.initialGroup) {
      const location = locationForGroup(props.initialGroup);
      setSubpageByPage(current => ({ ...current, [location.page]: location.subpage }));
    } else if (props.initialSubpage) setSubpageByPage(current => ({ ...current, [props.page]: props.initialSubpage }));
  }, [props.initialScope, props.initialGroup, props.initialSubpage]);
  const [systemFonts, setSystemFonts] = useState<SystemFont[]>([]);
  const [systemQuery, setSystemQuery] = useState('');
  const [systemLoading, setSystemLoading] = useState(false);
  const [systemLoaded, setSystemLoaded] = useState(false);
  const [systemError, setSystemError] = useState('');
  const systemRequest = useRef(0);
  const refreshSystemFonts = useCallback(async () => {
    const request = ++systemRequest.current;
    setSystemLoading(true); setSystemError('');
    try {
      const next = await listSystemFonts();
      if (request === systemRequest.current) { setSystemFonts(next); setSystemLoaded(true); }
    } catch {
      if (request === systemRequest.current) setSystemError('读取系统字体失败，请刷新重试。你仍可使用系统默认或导入字体。');
    } finally { if (request === systemRequest.current) setSystemLoading(false); }
  }, []);
  useEffect(() => { void refreshSystemFonts(); return () => { systemRequest.current++; }; }, [refreshSystemFonts]);
  const content = useRef<HTMLDivElement>(null);
  const selected = pages.find(item => item.id === page)!;
  const selectedSubpage = subpages[page].find(item => item.id === subpageByPage[page]) ?? subpages[page][0];
  const dirty = (Object.keys({...saved,...value}) as (keyof Settings)[]).some(key => key === 'engineDefaults'
    ? !sameEngineDefaults(value.engineDefaults, saved.engineDefaults) : value[key] !== saved[key]);
  const changePage = (next: SettingsPage) => { onPage(next); content.current?.scrollTo(0, 0); };
  const changeSubpage = (next: string) => { setSubpageByPage(current => ({ ...current, [page]: next })); content.current?.scrollTo(0, 0); };
  const save = (detect: boolean) => {
    const result = settingsSchema.safeParse(value);
    if (!result.success) {
      const issue = result.error.issues[0], key = String(issue.path[0]);
      const group = key === 'engineDefaults' ? engineGroupForKey(String(issue.path[3])) : undefined;
      const location = group ? locationForGroup(group) : undefined;
      const target: SettingsPage = location?.page ?? (/^(chatFont|uiFont|theme)/.test(key) ? 'appearance' : /^(worktree|ide)/.test(key) ? 'workspace' : /^(maxSessions|engineDefaults)/.test(key) ? 'sessions' : /^(notifications|closeToTray)/.test(key) ? 'system' : 'terminal');
      const targetSubpage = location?.subpage ?? (key === 'theme' ? 'theme' : target === 'appearance' ? 'fonts' : key === 'idePath' ? 'ide' : target === 'workspace' ? 'worktree' : target === 'terminal' ? /^(shellPath|fontSize|scrollback)$/.test(key) ? 'shell' : 'cli' : target === 'system' ? 'behavior' : 'limits');
      const sizeHints: Record<string, string> = {chatFontSize:'聊天字号须为 11–28 的整数。',uiFontSize:'菜单字号须为 11–20 的整数。',fontSize:'终端字号须为 11–24 的整数。',maxSessions:'并发会话数须为 1–12 的整数。',scrollback:'终端回滚行数须为 1000–50000 的整数。'};
      setValidation(sizeHints[key] || issue.message); setScope('defaults'); setSubpageByPage(current => ({ ...current, [target]: targetSubpage })); changePage(target); return;
    }
    setValidation(''); props.onSave(detect);
  };
  return <form className="settings-form" noValidate onSubmit={event => {event.preventDefault();save(false);}}>
    <header className="settings-header"><span className="eyebrow">PREFERENCES</span><h2>设置与连接</h2><p>按你的习惯组织工作台</p></header>
    <div className="settings-layout">
      <nav className="settings-nav" role="tablist" aria-label="设置分类" aria-orientation="vertical">
        {pages.map((item, index) => <button type="button" role="tab" key={item.id} id={'settings-tab-' + item.id} aria-controls={'settings-page-' + item.id} aria-selected={page === item.id} tabIndex={page === item.id ? 0 : -1} disabled={busy} onClick={() => changePage(item.id)} onKeyDown={event => {
          const next = event.key === 'ArrowDown' ? (index + 1) % pages.length : event.key === 'ArrowUp' ? (index + pages.length - 1) % pages.length : event.key === 'Home' ? 0 : event.key === 'End' ? pages.length - 1 : undefined;
          if (next !== undefined) { event.preventDefault(); changePage(pages[next].id); document.getElementById('settings-tab-' + pages[next].id)?.focus(); }
        }}><item.icon size={18}/><span>{item.title}</span></button>)}
        <p>外观与字体即时预览<br/>保存后下次继续使用</p>
      </nav>
      <div ref={content} className="settings-content" role="tabpanel" id={'settings-page-' + page} aria-labelledby={'settings-tab-' + page}>
        <div className="settings-page-heading"><h3>{selected.title}</h3><p>{selected.description}</p></div>
        <nav className="settings-subnav" role="tablist" aria-label={selected.title + '分类'}>
          {subpages[page].map((item, index) => <button type="button" role="tab" key={item.id} id={`settings-subtab-${page}-${item.id}`} aria-controls={`settings-subpage-${page}-${item.id}`} aria-selected={selectedSubpage.id === item.id} tabIndex={selectedSubpage.id === item.id ? 0 : -1} disabled={busy} onClick={() => changeSubpage(item.id)} onKeyDown={event => {
            const next = event.key === 'ArrowRight' ? (index + 1) % subpages[page].length : event.key === 'ArrowLeft' ? (index + subpages[page].length - 1) % subpages[page].length : event.key === 'Home' ? 0 : event.key === 'End' ? subpages[page].length - 1 : undefined;
            if (next !== undefined) { event.preventDefault(); changeSubpage(subpages[page][next].id); document.getElementById(`settings-subtab-${page}-${subpages[page][next].id}`)?.focus(); }
          }}>{item.title}</button>)}
        </nav>
        <div className="settings-subpage" role="tabpanel" id={`settings-subpage-${page}-${selectedSubpage.id}`} aria-labelledby={`settings-subtab-${page}-${selectedSubpage.id}`}>
        {page === 'appearance' && selectedSubpage.id === 'fonts' && <>
          <section className="system-font-picker" aria-label="系统字体">
            <div className="settings-card-heading"><h4>系统已安装字体</h4><button type="button" className="secondary compact" disabled={busy || systemLoading} onClick={()=>void refreshSystemFonts()}><RefreshCw size={15}/>刷新系统字体</button></div>
            <p className="settings-description" role="status">{systemLoading ? '正在读取系统字体…' : systemError || (systemLoaded ? `已读取 ${systemFonts.length} 款字体，可在下方分别选择。` : '读取本机已安装字体后，可分别用于聊天和菜单。')}</p>
            <input type="search" aria-label="搜索系统字体" placeholder="搜索系统字体名称" value={systemQuery} disabled={busy || !systemLoaded} onChange={event=>setSystemQuery(event.target.value)}/>
            {systemQuery.trim() && !systemFonts.some(font=>font.name.toLocaleLowerCase().includes(systemQuery.trim().toLocaleLowerCase())) && <p className="settings-description">没有匹配的系统字体。已选字体仍保留在选项中。</p>}
          </section>
          <div className="font-controls"><FontControl scope="chat" value={value} fonts={fonts} systemFonts={systemFonts} systemQuery={systemQuery} systemLoaded={systemLoaded} disabled={busy} onChange={onChange}/><FontControl scope="ui" value={value} fonts={fonts} systemFonts={systemFonts} systemQuery={systemQuery} systemLoaded={systemLoaded} disabled={busy} onChange={onChange}/></div>
          <section className="settings-section font-library" aria-label="字体库">
            <div className="settings-card-heading"><h4>本机字体库</h4><button type="button" className="secondary compact" disabled={busy} onClick={props.onImport}><Upload size={15}/>导入字体</button></div>
            <p className="settings-description">支持 TTF、OTF、WOFF、WOFF2，单个最多 20 MiB。导入后可在聊天和菜单中选择，无需安装到系统。</p>
            {fonts.length ? <ul className="imported-fonts">{fonts.map(font => <li key={font.id}><div><strong>{font.name}</strong><small>{font.format.toUpperCase()} · {(font.bytes / 1024 / 1024).toFixed(2)} MiB{[value.chatFontFamily,value.uiFontFamily].includes(font.id) ? ' · 当前已选' : ''}</small></div><button type="button" className="icon-button danger" aria-label={'移除字体 ' + font.name} title="移除后，使用此字体的区域恢复系统默认；原文件不受影响。" disabled={busy} onClick={() => props.onRemove(font.id)}><Trash2 size={16}/></button></li>)}</ul> : <p className="font-library-empty">还没有导入字体。可在上方选择系统字体，也可以导入本机字体文件。</p>}
            <p className="settings-description">字体库的导入、移除会立即保存；只管理应用内副本，不修改原文件。关闭设置只撤销尚未保存的字体选择、字号与主题。</p>
          </section>
        </>}
        {page === 'appearance' && selectedSubpage.id === 'theme' && <ThemePicker value={normalizeThemeId(value.theme)} disabled={busy} onChange={theme => onChange({...value, theme})}/>}
        {page === 'models' && selectedSubpage.id === 'connections' && <>
          <p className="settings-resource-note"><span>全局资源</span>模型连接与凭据独立保存，供自研 Agent 会话选择。</p>
          <NativeConnections disabled={busy}/>
          <EnginePolicySection props={props} group="model" scope={scope} onScope={setScope}/>
        </>}
        {page === 'models' && selectedSubpage.id === 'import' && <NativeModelImport disabled={busy} onConnections={() => changeSubpage('connections')}/>}
        {page === 'models' && (selectedSubpage.id === 'context' || selectedSubpage.id === 'compaction') && <EnginePolicySection props={props} group={selectedSubpage.group!} scope={scope} onScope={setScope}/>}
        {page === 'mcp' && selectedSubpage.id === 'connections' && <><p className="settings-resource-note"><span>全局资源</span>MCP 连接与凭据独立保存；新增连接不会自动启用到会话。</p><NativeMcpConnections disabled={busy}/></>}
        {page === 'mcp' && selectedSubpage.id === 'tools' && <EnginePolicySection props={props} group="tools" scope={scope} onScope={setScope}/>}
        {page === 'terminal' && selectedSubpage.id === 'cli' && <>
          {props.cliUpdate}
          <section className="settings-section"><h4>Claude Code</h4><label>Claude Code 可执行文件<input aria-label="Claude Code 路径" disabled={busy || props.cliBusy} value={value.claudePath} placeholder="留空自动检测" onChange={event => onChange({...value,claudePath:event.target.value})}/></label>
            <p className="hint">{value.claudePath !== saved.claudePath ? '路径尚未保存；点击“保存并检测”以检查当前输入。' : '检测路径：' + (saved.claudePath || '自动查找')}</p>
            <div className={'connection-box ' + (cap.available ? 'connected' : '')}><div><span className={'dot ' + (cap.available ? 'running' : 'error')}/><strong>{busy ? '正在保存并检查设置…' : cap.available ? cap.version : '未检测到 CLI'}</strong></div><p>{busy ? '请稍候…' : cap.available ? cap.executable : cap.error || '保存设置后自动检测 CLI。'}</p>{cap.available && <small>可用强度：{cap.efforts.filter(value => value !== 'default').join(' / ') || '跟随 CLI'}</small>}</div>
            <p className="hint">在终端完成 Claude 登录。Claude 会话的 API Key、MCP 与 provider 沿用 Claude Code 配置；其登录凭据由 CLI 管理。路径变更用于后续启动的进程。</p>
            <LegacyClaudeOverrides config={engineDefaults(props.executors.find(item => item.providerId === 'claude' && item.mode === 'structured'), value)} disabled={busy || !!props.cliBusy} onChange={engineConfig => onChange({ ...value, engineDefaults: { ...value.engineDefaults, claude: engineConfig } })}/>
          </section>
        </>}
        {page === 'terminal' && selectedSubpage.id === 'shell' && <section className="settings-section"><h4>Shell 与终端显示</h4><label>Shell 可执行文件<input aria-label="Shell 可执行文件" disabled={busy} value={value.shellPath} placeholder="留空自动使用 PowerShell / Bash / Zsh" onChange={event => onChange({...value,shellPath:event.target.value})}/></label>
            <div className="form-grid"><label>终端字号<input aria-label="终端字号" type="number" min={11} max={24} disabled={busy} value={value.fontSize} onChange={event => onChange({...value,fontSize:Number(event.target.value)})}/></label><label>终端回滚行数<input aria-label="终端回滚行数" type="number" min={1000} max={50000} step={1000} disabled={busy} value={value.scrollback} onChange={event => onChange({...value,scrollback:Number(event.target.value)})}/></label></div>
            <p className="hint">终端字号保存后即时更新，不重启会话。结构化聊天的字体请在「外观与字体」中修改。</p>
          </section>}
        {page === 'sessions' && <>
          {selectedSubpage.id === 'limits' && <section className="settings-section"><h4>并发任务 <span className="settings-global-badge">全局</span></h4><label>最大并发会话<input aria-label="最大并发会话" type="number" min={1} max={12} disabled={busy} value={value.maxSessions} onChange={event => onChange({...value,maxSessions:Number(event.target.value)})}/></label><p className="hint">限制同时连接的会话数量。降低上限不会停止已有任务。</p></section>}
          <EnginePolicySection props={props} group={selectedSubpage.group!} scope={scope} onScope={setScope}/>
        </>}
        {page === 'workspace' && selectedSubpage.id === 'worktree' && <>
          <section className="settings-section worktree-preferences"><h4>Worktree 位置</h4><label>Worktree 位置<select aria-label="Worktree 位置" aria-describedby="worktree-location-help" disabled={busy} value={value.worktreeLocation ?? 'project'} onChange={event => onChange({...value,worktreeLocation:event.target.value as 'project' | 'custom'})}><option value="project">项目目录内（.claude/worktrees）</option><option value="custom">统一目录</option></select></label>
            {value.worktreeLocation === 'custom' && <><label htmlFor="worktree-root-path">统一 Worktree 根目录</label><div className="worktree-path-row"><input id="worktree-root-path" aria-label="统一 Worktree 根目录" aria-describedby="worktree-location-help" disabled={busy} required maxLength={4096} spellCheck={false} value={value.worktreeRoot ?? ''} placeholder={platform === 'win32' ? '例如 D:\\Worktrees' : '例如 /Users/你/Worktrees'} onChange={event => onChange({...value,worktreeRoot:event.target.value})}/><button type="button" className="secondary" disabled={busy} onClick={props.onChooseWorktree}><FolderOpen size={14}/>选择 Worktree 目录</button></div></>}
            <p className="hint" id="worktree-location-help">{value.worktreeLocation === 'custom' ? '统一目录下按「项目名-短标识 / Worktree 名称-短标识」创建子目录，区分同名项目与会话。' : '在项目 Git 根目录的 .claude/worktrees 下创建独立目录。'}保存后仅用于新建 Worktree，已有会话的目录保持不变。</p>
          </section>
        </>}
        {page === 'workspace' && selectedSubpage.id === 'ide' && <section className="settings-section ide-preferences"><h4>外部编辑器</h4><label htmlFor="ide-application-path">外部 IDE 应用</label><div className="ide-path-row"><input id="ide-application-path" aria-label="IDE 应用路径" aria-describedby="ide-path-help" disabled={busy} maxLength={4096} value={value.idePath ?? ''} placeholder={platform === 'win32' ? '例如 C:\\Apps\\Code.exe' : platform === 'darwin' ? '/Applications/WebStorm.app' : '例如 /opt/WebStorm/bin/webstorm.sh'} onChange={event => onChange({...value,idePath:event.target.value})}/><button type="button" className="secondary" disabled={busy} onClick={props.onChooseIde}><FolderOpen size={14}/>选择 IDE 应用</button></div><p className="hint" id="ide-path-help">选择 VS Code、WebStorm 或定制版应用。保存后，顶部「IDE」打开当前工作目录，包括独立 Worktree。{platform === 'win32' ? '请选择 .exe 程序。' : platform === 'darwin' ? '请选择 .app 应用或可执行文件。' : '请选择可执行文件或启动脚本。'}无需追加参数，留空可清除。</p></section>}
        {page === 'system' && selectedSubpage.id === 'behavior' && <>
          <section className="settings-section"><h4>提醒与窗口行为</h4><label className="checkbox"><input type="checkbox" disabled={busy} checked={value.notifications ?? false} onChange={event => onChange({...value,notifications:event.target.checked})}/><span>任务完成与等待审批时显示通知</span></label><label className="checkbox"><input type="checkbox" disabled={busy} checked={value.closeToTray ?? false} onChange={event => onChange({...value,closeToTray:event.target.checked})}/><span>关闭窗口后保留到系统托盘<small>任务继续运行，可从托盘重新打开。</small></span></label></section>
        </>}
        {page === 'system' && selectedSubpage.id === 'data' && <section className="settings-section"><h4>本机数据</h4><label>工作台数据目录<code className="data-path">{dataPath}</code></label><p className="hint">会话、设置与导入的字体副本保存在此目录。字体选择不会修改系统字体。</p></section>}
        </div>
      </div>
    </div>
    <footer className="settings-footer">
      {(validation || error) && <div className="settings-error" role="alert">{validation || error}</div>}
      <p className="settings-save-help">保存设置应用全局偏好与默认策略。关闭会丢弃未保存的编辑；连接、MCP、字体库及当前会话已保存的更改不会撤销。</p>
      <div className="settings-footer-actions"><span className="settings-save-state">{busy ? '正在处理…' : dirty ? '全局设置有未保存的更改' : '全局设置已同步'}</span><button type="button" className="secondary" disabled={busy} onClick={props.onClose}>关闭</button>{page === 'terminal' && selectedSubpage.id === 'cli' && <button type="button" className="secondary" disabled={busy || props.cliBusy} onClick={() => save(true)}><RefreshCw size={14}/>保存并检测</button>}<button type="submit" className="primary" disabled={busy}>{busy ? <Loader2 className="spin" size={15}/> : <Check size={15}/>}保存设置</button></div>
    </footer>
  </form>;
}
