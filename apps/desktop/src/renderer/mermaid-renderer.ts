import type { MermaidConfig } from 'mermaid';
import { getTheme, type ThemeId } from './themes';

export const MAX_MERMAID_SOURCE = 32_000;
let libraries: Promise<{ mermaid: typeof import('mermaid').default; purify: typeof import('dompurify').default }> | undefined;
let queue: Promise<unknown> = Promise.resolve();
let sequence = 0;

function loadLibraries() {
  return libraries ??= Promise.all([import('mermaid'), import('dompurify')])
    .then(([mermaid, purify]) => ({ mermaid: mermaid.default, purify: purify.default }))
    .catch(error => { libraries = undefined; throw error; });
}

function configuration(themeId: ThemeId): MermaidConfig {
  const { colors: c, scheme } = getTheme(themeId);
  const config: MermaidConfig = {
    startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
    maxTextSize: MAX_MERMAID_SOURCE, maxEdges: 300, htmlLabels: false, arrowMarkerAbsolute: false,
    theme: 'base', themeCSS: '', fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
    dompurifyConfig: {},
    themeVariables: {
      darkMode: scheme === 'dark', background: c['code-bg'],
      primaryColor: c.surface, primaryTextColor: c.text, primaryBorderColor: c['control-border'],
      secondaryColor: c.selected, secondaryTextColor: c.text, secondaryBorderColor: c['control-border'],
      tertiaryColor: c.panel, tertiaryTextColor: c.text, tertiaryBorderColor: c.border,
      textColor: c.text, lineColor: c['text-secondary'], mainBkg: c.surface,
      nodeBorder: c['control-border'], clusterBkg: c.panel, clusterBorder: c['control-border'],
      edgeLabelBackground: c['code-bg'], titleColor: c['text-strong'],
      actorBkg: c.surface, actorBorder: c['control-border'], actorTextColor: c.text,
      actorLineColor: c['text-secondary'], signalColor: c.text, signalTextColor: c.text,
      labelBoxBkgColor: c.surface, labelBoxBorderColor: c['control-border'], labelTextColor: c.text,
      loopTextColor: c.text, noteBkgColor: c.selected, noteTextColor: c.text, noteBorderColor: c['control-border'],
      activationBkgColor: c.selected, activationBorderColor: c['control-border'],
      fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif', fontSize: '14px',
    },
    flowchart: { useMaxWidth: false }, sequence: { useMaxWidth: false },
  };
  // Diagram directives/frontmatter cannot override host security or theme choices.
  config.secure = ['secure', ...Object.keys(config)];
  return config;
}

/** Keep internal SVG references (markers/filters), never external resources. */
function localUrls(value: string): string {
  return value.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_match, _quote, target: string) =>
    /^#[\w:.-]+$/.test(target.trim()) ? `url(${target.trim()})` : 'none');
}

/** Render in a measurable temporary host: chat tools/workflow details may be hidden. */
export function renderMermaid(source: string, themeId: ThemeId, signal: AbortSignal): Promise<string> {
  const work = async () => {
    signal.throwIfAborted();
    if (source.length > MAX_MERMAID_SOURCE) throw new Error('图表源码超过 32,000 个字符，请切换到源码查看。');
    const { mermaid, purify } = await loadLibraries();
    signal.throwIfAborted();
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;visibility:hidden;pointer-events:none';
    document.body.appendChild(host);
    try {
      // Mermaid has global configuration. Serialize initialize + render together.
      mermaid.initialize(configuration(themeId));
      const { svg } = await mermaid.render(`cc-mermaid-${++sequence}`, source, host);
      signal.throwIfAborted();
      if (svg.length > 2 * 1024 * 1024) throw new Error('图表过大，请切换到源码查看。');
      const fragment = purify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true }, RETURN_DOM_FRAGMENT: true,
        FORBID_TAGS: ['a', 'foreignObject', 'image', 'script', 'iframe', 'animate', 'animateMotion', 'animateTransform', 'set'],
        ADD_ATTR: ['dominant-baseline'],
      });
      const root = fragment.querySelector('svg');
      if (!root) throw new Error('图表未生成有效预览，请切换到源码查看。');
      for (const element of [root, ...root.querySelectorAll('*')]) {
        for (const attribute of [...element.attributes]) {
          if (/^on/i.test(attribute.name) || /^(?:xlink:)?href$/i.test(attribute.name) && !/^#[\w:.-]+$/.test(attribute.value)) element.removeAttribute(attribute.name);
          else if (/url\(/i.test(attribute.value)) element.setAttribute(attribute.name, localUrls(attribute.value));
        }
        if (element.localName === 'style') element.textContent = localUrls(element.textContent ?? '');
      }
      root.setAttribute('role', 'img');
      root.setAttribute('aria-label', 'Mermaid 图表');
      root.style.maxWidth = 'none';
      return root.outerHTML;
    } finally { host.remove(); }
  };
  const result = queue.then(work);
  queue = result.catch(() => {});
  return result;
}
