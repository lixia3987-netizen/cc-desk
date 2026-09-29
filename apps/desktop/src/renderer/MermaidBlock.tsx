import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { DEFAULT_THEME, normalizeThemeId, type ThemeId } from '../shared/theme';
import { MAX_MERMAID_SOURCE, renderMermaid } from './mermaid-renderer';

const themeListeners = new Set<() => void>();
let themeObserver: MutationObserver | undefined;
const currentTheme = () => normalizeThemeId(document.documentElement.dataset.theme);
function subscribeTheme(listener: () => void) {
  themeListeners.add(listener);
  if (!themeObserver) {
    themeObserver = new MutationObserver(() => themeListeners.forEach(notify => notify()));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  return () => { themeListeners.delete(listener); if (!themeListeners.size) { themeObserver?.disconnect(); themeObserver = undefined; } };
}
interface Preview { source: string; theme: ThemeId; svg?: string; error?: string }

export function MermaidBlock({ source }: { source: string }) {
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const [preview, setPreview] = useState<Preview>();
  const [copied, setCopied] = useState(false), [copyFailed, setCopyFailed] = useState(false);
  const [visible, setVisible] = useState(false);
  const block = useRef<HTMLDivElement>(null);
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, () => DEFAULT_THEME);
  const current = preview?.source === source && preview.theme === theme ? preview : undefined;
  const oversized = source.length > MAX_MERMAID_SOURCE;
  useEffect(() => { setCopied(false); setCopyFailed(false); }, [source]);
  useEffect(() => {
    if (!block.current) return;
    const details: HTMLDetailsElement[] = [];
    for (let parent = block.current.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) details.push(parent);
    }
    let intersecting = typeof IntersectionObserver === 'undefined';
    const update = () => setVisible(intersecting && details.every(parent => parent.open));
    // Chromium may report intersection for descendants of a closed <details>.
    details.forEach(parent => parent.addEventListener('toggle', update));
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(([entry]) => {
      intersecting = entry.isIntersecting; update();
    }, { rootMargin: '300px' });
    observer?.observe(block.current); update();
    return () => { observer?.disconnect(); details.forEach(parent => parent.removeEventListener('toggle', update)); };
  }, []);
  useEffect(() => {
    if (mode !== 'preview' || !visible || current || oversized) return;
    const controller = new AbortController();
    // A stream may update a fence many times; only render after a short quiet period.
    const timer = setTimeout(() => {
      void renderMermaid(source, theme, controller.signal).then(svg => {
        if (!controller.signal.aborted) setPreview({ source, theme, svg });
      }).catch(error => {
        if (!controller.signal.aborted) setPreview({ source, theme, error: error instanceof Error ? error.message.slice(0, 500) : '图表渲染失败。' });
      });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [source, theme, mode, visible, current, oversized]);
  const copy = async () => {
    try { await window.desktop.copyText(source); setCopied(true); setCopyFailed(false); }
    catch { setCopyFailed(true); }
  };
  const error = oversized ? '图表源码超过 32,000 个字符，请切换到源码查看。' : current?.error;
  return <div className="message-code mermaid-block" ref={block}>
    <div className="message-code-heading"><span>Mermaid</span><div className="mermaid-actions">
      <div className="mermaid-mode" role="group" aria-label="Mermaid 显示模式">
        <button type="button" className="text-button" aria-pressed={mode==='preview'} onClick={()=>{if(current?.error)setPreview(undefined);setMode('preview');}}>预览</button>
        <button type="button" className="text-button" aria-pressed={mode==='source'} onClick={()=>setMode('source')}>源码</button>
      </div>
      <button type="button" className="text-button" aria-label="复制代码" onClick={()=>void copy()}>{copied?<Check size={13}/>:<Copy size={13}/>} {copyFailed?'复制失败':copied?'已复制':'复制代码'}</button>
    </div></div>
    {mode==='source'?<pre className="mermaid-source"><code>{source}</code></pre>:<div className="mermaid-preview" data-theme={theme} aria-busy={!current&&!oversized}>
      {error?<div className="mermaid-error" role="status"><p>暂时无法预览，源码可能尚未完整或存在语法错误。可切换到源码查看。</p><pre>{error}</pre></div>
        :current?.svg?<div className="mermaid-svg" dangerouslySetInnerHTML={{__html:current.svg}}/>
        :<div className="mermaid-loading" role="status"><Loader2 size={14} className="spin"/>正在绘制图表…</div>}
    </div>}
  </div>;
}
