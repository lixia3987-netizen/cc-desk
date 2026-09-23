import { useRef, useState } from 'react';
import { Bell, Check, FolderCog, FolderOpen, Layers, Loader2, Palette, Plug, RefreshCw, Trash2, Upload } from 'lucide-react';
import type { Capabilities, Settings } from '../shared/types';
import { BUILTIN_FONTS, DEFAULT_TYPOGRAPHY, fontFamily, typography, type FontId, type ImportedFont } from '../shared/fonts';
import { settingsSchema } from '../shared/schema';
import { normalizeThemeId } from '../shared/theme';
import { PermissionModeField } from './PermissionModeField';
import { ThemePicker } from './ThemePicker';

const pages = [
  { id: 'appearance', title: '外观与字体', icon: Palette, description: '选择主题，分别调整聊天内容与菜单界面的阅读体验。' },
  { id: 'connection', title: '连接与终端', icon: Plug, description: '连接本机 Claude Code，设置 Shell 与终端显示。' },
  { id: 'sessions', title: '会话与权限', icon: Layers, description: '管理并发数量和新会话的默认权限。' },
  { id: 'workspace', title: '工作区与 IDE', icon: FolderCog, description: '选择 Worktree 位置，以及打开项目的编辑器。' },
  { id: 'system', title: '通知与后台', icon: Bell, description: '设置任务通知、窗口关闭行为，并查看数据位置。' },
] as const;
export type SettingsPage = typeof pages[number]['id'];
interface Props {
  value: Settings; saved: Settings; onChange(value: Settings): void;
  page: SettingsPage; onPage(page: SettingsPage): void;
  fonts: ImportedFont[]; onImport(): void; onRemove(id: string): void;
  busy: boolean; error: string; capabilities: Capabilities; platform: string; dataPath: string;
  onSave(detect: boolean): void; onClose(): void; onChooseIde(): void; onChooseWorktree(): void;
}

function FontControl({scope, value, fonts, disabled, onChange}: {scope: 'chat' | 'ui'; value: Settings; fonts: ImportedFont[]; disabled: boolean; onChange(value: Settings): void}) {
  const settings = typography(value), isChat = scope === 'chat', title = isChat ? '聊天' : '菜单';
  const familyKey = isChat ? 'chatFontFamily' : 'uiFontFamily', sizeKey = isChat ? 'chatFontSize' : 'uiFontSize';
  const family = settings[familyKey], size = value[sizeKey] ?? DEFAULT_TYPOGRAPHY[sizeKey], maximum = isChat ? 28 : 20;
  const found = BUILTIN_FONTS.some(font => font.id === family) || fonts.some(font => font.id === family);
  return <section className="font-control" aria-label={title + '字体设置'}>
    <div className="settings-card-heading"><h4>{isChat ? '聊天内容' : '菜单与界面'}</h4><button type="button" className="text-button" disabled={disabled} aria-label={'重置' + title + '字体'} onClick={() => onChange({...value, [familyKey]: DEFAULT_TYPOGRAPHY[familyKey], [sizeKey]: DEFAULT_TYPOGRAPHY[sizeKey]})}>恢复默认</button></div>
    <p className="settings-description">{isChat ? '正文、输入框与工具内容；代码保留等宽字体。' : '侧栏、菜单、工具栏与设置；辅助文字按比例缩放。'}</p>
    <label>{title}字体<select aria-label={title + '字体'} value={family} disabled={disabled} onChange={event => onChange({...value, [familyKey]: event.target.value as FontId})}>
      <optgroup label="系统与内置字体">{BUILTIN_FONTS.map(font => <option key={font.id} value={font.id}>{font.name}</option>)}</optgroup>
      {!!fonts.length && <optgroup label="已导入字体">{fonts.map(font => <option key={font.id} value={font.id}>{font.name}</option>)}</optgroup>}
      {!found && <option value={family}>字体不可用 · 请重新选择</option>}
    </select></label>
    <label htmlFor={scope + '-font-size'}>{title}字号 <span className="settings-field-unit">px</span></label>
    <div className="font-size-control"><input type="range" aria-label={title + '字号滑块'} min={11} max={maximum} step={1} value={settings[sizeKey]} disabled={disabled} onChange={event => onChange({...value, [sizeKey]: Number(event.target.value)})}/><input id={scope + '-font-size'} aria-label={title + '字号'} type="number" min={11} max={maximum} step={1} required disabled={disabled} value={size} onChange={event => onChange({...value, [sizeKey]: Number(event.target.value)})}/></div>
    <div className={'font-preview ' + scope + '-font-preview'} style={{fontFamily: fontFamily(family), fontSize: settings[sizeKey]}} aria-label={title + '字体预览'}>
      <strong>{isChat ? '让每一行都清晰易读' : '项目 · 会话 · 设置'}</strong><p>{isChat ? '你好，世界。一起完成下一项任务。' : '新建会话　查看变更　保存设置'}</p><small>Aa Bb 0123456789 · {'{ code }'}</small>
    </div>
  </section>;
}

export function SettingsPanel(props: Props) {
  const {value, saved, onChange, page, onPage, fonts, busy, error, capabilities: cap, platform, dataPath} = props;
  const [validation, setValidation] = useState('');
  const content = useRef<HTMLDivElement>(null);
  const selected = pages.find(item => item.id === page)!;
  const dirty = (Object.keys({...saved,...value}) as (keyof Settings)[]).some(key => value[key] !== saved[key]);
  const changePage = (next: SettingsPage) => { onPage(next); content.current?.scrollTo(0, 0); };
  const save = (detect: boolean) => {
    const result = settingsSchema.safeParse(value);
    if (!result.success) {
      const issue = result.error.issues[0], key = String(issue.path[0]);
      const target: SettingsPage = /^(chatFont|uiFont|theme)/.test(key) ? 'appearance' : /^(worktree|ide)/.test(key) ? 'workspace' : /^(maxSessions|defaultPermissionMode)/.test(key) ? 'sessions' : /^(notifications|closeToTray)/.test(key) ? 'system' : 'connection';
      const sizeHints: Record<string, string> = {chatFontSize:'聊天字号须为 11–28 的整数。',uiFontSize:'菜单字号须为 11–20 的整数。',fontSize:'终端字号须为 11–24 的整数。',maxSessions:'并发会话数须为 1–12 的整数。',scrollback:'终端回滚行数须为 1000–50000 的整数。'};
      setValidation(sizeHints[key] || issue.message); changePage(target); return;
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
        {page === 'appearance' && <>
          <div className="font-controls"><FontControl scope="chat" value={value} fonts={fonts} disabled={busy} onChange={onChange}/><FontControl scope="ui" value={value} fonts={fonts} disabled={busy} onChange={onChange}/></div>
          <section className="settings-section font-library" aria-label="字体库">
            <div className="settings-card-heading"><h4>本机字体库</h4><button type="button" className="secondary compact" disabled={busy} onClick={props.onImport}><Upload size={15}/>导入字体</button></div>
            <p className="settings-description">支持 TTF、OTF、WOFF、WOFF2，单个最多 20 MiB。导入后可在聊天和菜单中选择，无需安装到系统。</p>
            <div className="builtin-fonts">{BUILTIN_FONTS.filter(font => font.id !== 'system').map(font => <div key={font.id}><strong>{font.name}</strong><span>内置 · OFL 开源许可</span><small>{font.description}</small></div>)}</div>
            {fonts.length ? <ul className="imported-fonts">{fonts.map(font => <li key={font.id}><div><strong>{font.name}</strong><small>{font.format.toUpperCase()} · {(font.bytes / 1024 / 1024).toFixed(2)} MiB{[value.chatFontFamily,value.uiFontFamily].includes(font.id) ? ' · 当前已选' : ''}</small></div><button type="button" className="icon-button danger" aria-label={'移除字体 ' + font.name} title="移除后，使用此字体的区域恢复系统默认；原文件不受影响。" disabled={busy} onClick={() => props.onRemove(font.id)}><Trash2 size={16}/></button></li>)}</ul> : <p className="font-library-empty">还没有导入字体。内置字体可直接离线使用。</p>}
            <p className="settings-description">字体库的导入、移除会立即保存；只管理应用内副本，不修改原文件。关闭设置只撤销尚未保存的字体选择、字号与主题。</p>
          </section>
          <ThemePicker value={normalizeThemeId(value.theme)} disabled={busy} onChange={theme => onChange({...value, theme})}/>
        </>}
        {page === 'connection' && <>
          <section className="settings-section"><h4>Claude Code</h4><label>Claude Code 可执行文件<input aria-label="Claude Code 路径" disabled={busy} value={value.claudePath} placeholder="留空自动检测" onChange={event => onChange({...value,claudePath:event.target.value})}/></label>
            <p className="hint">{value.claudePath !== saved.claudePath ? '路径尚未保存；点击“保存并检测”以检查当前输入。' : '检测路径：' + (saved.claudePath || '自动查找')}</p>
            <div className={'connection-box ' + (cap.available ? 'connected' : '')}><div><span className={'dot ' + (cap.available ? 'running' : 'error')}/><strong>{busy ? '正在保存并检查设置…' : cap.available ? cap.version : '未检测到 CLI'}</strong></div><p>{busy ? '请稍候…' : cap.available ? cap.executable : cap.error || '保存设置后自动检测 CLI。'}</p>{cap.available && <small>可用强度：{cap.efforts.filter(value => value !== 'default').join(' / ') || '跟随 CLI'}</small>}</div>
            <p className="hint">在终端完成 Claude 登录。API Key、MCP 与 provider 沿用 Claude Code 配置；客户端不保存凭据。路径变更用于后续启动的进程。</p>
          </section>
          <section className="settings-section"><h4>Shell 与终端显示</h4><label>Shell 可执行文件<input aria-label="Shell 可执行文件" disabled={busy} value={value.shellPath} placeholder="留空自动使用 PowerShell / Bash / Zsh" onChange={event => onChange({...value,shellPath:event.target.value})}/></label>
            <div className="form-grid"><label>终端字号<input aria-label="终端字号" type="number" min={11} max={24} disabled={busy} value={value.fontSize} onChange={event => onChange({...value,fontSize:Number(event.target.value)})}/></label><label>终端回滚行数<input aria-label="终端回滚行数" type="number" min={1000} max={50000} step={1000} disabled={busy} value={value.scrollback} onChange={event => onChange({...value,scrollback:Number(event.target.value)})}/></label></div>
            <p className="hint">终端字号保存后即时更新，不重启会话。结构化聊天的字体请在「外观与字体」中修改。</p>
          </section>
        </>}
        {page === 'sessions' && <>
          <section className="settings-section"><h4>并发任务</h4><label>最大并发会话<input aria-label="最大并发会话" type="number" min={1} max={12} disabled={busy} value={value.maxSessions} onChange={event => onChange({...value,maxSessions:Number(event.target.value)})}/></label><p className="hint">限制同时连接的会话数量。降低上限不会停止已有任务。</p></section>
          <section className="settings-section"><h4>默认权限</h4><PermissionModeField label="默认权限模式" value={value.defaultPermissionMode ?? 'default'} disabled={busy} onChange={defaultPermissionMode => onChange({...value,defaultPermissionMode})}/><p className="hint">用于新建和首次导入的 Claude 会话，可在创建时调整。已有会话保留自己的模式，创建分支时继承原会话模式。</p></section>
        </>}
        {page === 'workspace' && <>
          <section className="settings-section worktree-preferences"><h4>Worktree 位置</h4><label>Worktree 位置<select aria-label="Worktree 位置" aria-describedby="worktree-location-help" disabled={busy} value={value.worktreeLocation ?? 'project'} onChange={event => onChange({...value,worktreeLocation:event.target.value as 'project' | 'custom'})}><option value="project">项目目录内（.claude/worktrees）</option><option value="custom">统一目录</option></select></label>
            {value.worktreeLocation === 'custom' && <><label htmlFor="worktree-root-path">统一 Worktree 根目录</label><div className="worktree-path-row"><input id="worktree-root-path" aria-label="统一 Worktree 根目录" aria-describedby="worktree-location-help" disabled={busy} required maxLength={4096} spellCheck={false} value={value.worktreeRoot ?? ''} placeholder={platform === 'win32' ? '例如 D:\\Worktrees' : '例如 /Users/你/Worktrees'} onChange={event => onChange({...value,worktreeRoot:event.target.value})}/><button type="button" className="secondary" disabled={busy} onClick={props.onChooseWorktree}><FolderOpen size={14}/>选择 Worktree 目录</button></div></>}
            <p className="hint" id="worktree-location-help">{value.worktreeLocation === 'custom' ? '统一目录下按「项目名-短标识 / Worktree 名称-短标识」创建子目录，区分同名项目与会话。' : '在项目 Git 根目录的 .claude/worktrees 下创建独立目录。'}保存后仅用于新建 Worktree，已有会话的目录保持不变。</p>
          </section>
          <section className="settings-section ide-preferences"><h4>外部编辑器</h4><label htmlFor="ide-application-path">外部 IDE 应用</label><div className="ide-path-row"><input id="ide-application-path" aria-label="IDE 应用路径" aria-describedby="ide-path-help" disabled={busy} maxLength={4096} value={value.idePath ?? ''} placeholder={platform === 'win32' ? '例如 C:\\Apps\\Code.exe' : platform === 'darwin' ? '/Applications/WebStorm.app' : '例如 /opt/WebStorm/bin/webstorm.sh'} onChange={event => onChange({...value,idePath:event.target.value})}/><button type="button" className="secondary" disabled={busy} onClick={props.onChooseIde}><FolderOpen size={14}/>选择 IDE 应用</button></div><p className="hint" id="ide-path-help">选择 VS Code、WebStorm 或定制版应用。保存后，顶部「IDE」打开当前工作目录，包括独立 Worktree。{platform === 'win32' ? '请选择 .exe 程序。' : platform === 'darwin' ? '请选择 .app 应用或可执行文件。' : '请选择可执行文件或启动脚本。'}无需追加参数，留空可清除。</p></section>
        </>}
        {page === 'system' && <>
          <section className="settings-section"><h4>提醒与窗口行为</h4><label className="checkbox"><input type="checkbox" disabled={busy} checked={value.notifications ?? false} onChange={event => onChange({...value,notifications:event.target.checked})}/><span>任务完成与等待审批时显示通知</span></label><label className="checkbox"><input type="checkbox" disabled={busy} checked={value.closeToTray ?? false} onChange={event => onChange({...value,closeToTray:event.target.checked})}/><span>关闭窗口后保留到系统托盘<small>任务继续运行，可从托盘重新打开。</small></span></label></section>
          <section className="settings-section"><h4>本机数据</h4><label>工作台数据目录<code className="data-path">{dataPath}</code></label><p className="hint">会话、设置与导入的字体副本保存在此目录。字体选择不会修改系统字体。</p></section>
        </>}
      </div>
    </div>
    <footer className="settings-footer">
      {(validation || error) && <div className="settings-error" role="alert">{validation || error}</div>}
      <div className="settings-footer-actions"><span className="settings-save-state">{busy ? '正在处理…' : dirty ? '有未保存的更改' : '设置已同步'}</span><button type="button" className="secondary" disabled={busy} onClick={props.onClose}>取消</button>{page === 'connection' && <button type="button" className="secondary" disabled={busy} onClick={() => save(true)}><RefreshCw size={14}/>保存并检测</button>}<button type="submit" className="primary" disabled={busy}>{busy ? <Loader2 className="spin" size={15}/> : <Check size={15}/>}保存设置</button></div>
    </footer>
  </form>;
}
