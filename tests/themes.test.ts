import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { THEME_IDS, THEME_APPEARANCE, DEFAULT_THEME, normalizeThemeId } from '../src/shared/theme';
import { THEMES, getTheme, getTerminalTheme } from '../src/renderer/themes';

// WCAG relative luminance. Every foreground/background here is opaque; overlays
// and disabled controls are not used to claim normal-text contrast compliance.
function luminance(hex: string): number {
  assert.match(hex, /^#[\da-f]{6}$/i);
  const [r, g, b] = [1, 3, 5].map(offset => {
    const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}
function contrast(a: string, b: string): number {
  const [low, high] = [luminance(a), luminance(b)].sort((left, right) => left - right);
  return (high + 0.05) / (low + 0.05);
}
function minimum(theme: string, foreground: string, background: string, a: string, b: string, threshold = 4.5) {
  const actual = contrast(a, b);
  assert.ok(actual >= threshold, `${theme} ${foreground} on ${background}: ${actual.toFixed(2)} < ${threshold}`);
}
const surfaces = ['background', 'sidebar', 'panel', 'surface', 'elevated', 'input-bg', 'code-bg', 'code-header', 'inline-code-bg', 'hover', 'selected', 'user-bg', 'success-bg', 'warning-bg', 'danger-bg', 'info-bg'];

test('five themes preserve native-window appearance, safe fallback, and distinct palettes', () => {
  assert.deepEqual(THEMES.map(theme => theme.id), [...THEME_IDS]);
  assert.equal(new Set(THEMES.map(theme => theme.name)).size, 5);
  assert.equal(new Set(THEMES.map(theme => theme.colors.background)).size, 5);
  assert.equal(new Set(THEMES.map(theme => theme.colors.accent)).size, 5);
  assert.equal(THEMES.filter(theme => theme.scheme === 'light').length, 2);
  for (const theme of THEMES) {
    assert.equal(theme.colors.background, THEME_APPEARANCE[theme.id].background);
    assert.equal(theme.scheme, THEME_APPEARANCE[theme.id].scheme);
    assert.equal(normalizeThemeId(theme.id), theme.id);
  }
  for (const invalid of [null, undefined, '', 'removed-theme', 5, {}, '__proto__']) {
    assert.equal(normalizeThemeId(invalid), DEFAULT_THEME);
    assert.equal(getTheme(invalid).id, DEFAULT_THEME);
  }
});

test('normal text, small captions, placeholders and selected labels retain at least 4.5:1 contrast', () => {
  for (const { id, colors } of THEMES) {
    for (const foreground of ['text', 'text-strong', 'text-secondary', 'text-muted']) {
      for (const background of surfaces) minimum(id, foreground, background, colors[foreground], colors[background]);
    }
    for (const background of ['background', 'sidebar', 'panel', 'surface', 'elevated', 'hover', 'selected']) {
      minimum(id, 'accent', background, colors.accent, colors[background]);
    }
    for (const background of ['accent', 'accent-hover']) minimum(id, 'on-accent', background, colors['on-accent'], colors[background]);
  }
});

test('approval, error, success, diff and syntax colors retain readable semantic foregrounds', () => {
  for (const { id, colors } of THEMES) {
    for (const status of ['success', 'warning', 'danger', 'info']) {
      minimum(id, status, `${status}-bg`, colors[status], colors[`${status}-bg`]);
      minimum(id, status, 'background', colors[status], colors.background);
      minimum(id, status, 'surface', colors[status], colors.surface);
    }
    for (const diff of ['added', 'removed', 'hunk']) {
      minimum(id, `diff-${diff}-text`, `diff-${diff}-bg`, colors[`diff-${diff}-text`], colors[`diff-${diff}-bg`]);
    }
    for (const token of ['syntax-keyword', 'syntax-string', 'syntax-number', 'syntax-comment', 'syntax-title']) {
      minimum(id, token, 'code-bg', colors[token], colors['code-bg']);
    }
  }
});

test('focus rings, selected outlines and control boundaries retain at least 3:1 contrast', () => {
  for (const { id, colors } of THEMES) {
    for (const background of surfaces) minimum(id, 'focus', background, colors.focus, colors[background], 3);
    for (const background of ['input-bg', 'surface', 'elevated', 'background', 'selected', 'warning-bg']) {
      minimum(id, 'control-border', background, colors['control-border'], colors[background], 3);
    }
    for (const background of ['background', 'sidebar', 'panel', 'surface', 'code-bg']) {
      minimum(id, 'scrollbar', background, colors.scrollbar, colors[background], 3);
    }
    for (const background of ['sidebar', 'selected']) {
      minimum(id, 'selected-border', background, colors['selected-border'], colors[background], 3);
    }
  }
});

test('terminal default, all 16 ANSI colors, cursor and selected text meet contrast targets', () => {
  const ansi = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const;
  for (const theme of THEMES) {
    const terminal = getTerminalTheme(theme.id);
    assert.equal(terminal.background, theme.colors.background);
    for (const foreground of ['foreground', 'cursor', ...ansi] as const) {
      minimum(theme.id, foreground, 'terminal background', terminal[foreground]!, terminal.background!);
    }
    minimum(theme.id, 'selectionForeground', 'selectionBackground', terminal.selectionForeground!, terminal.selectionBackground!);
    minimum(theme.id, 'cursorAccent', 'cursor', terminal.cursorAccent!, terminal.cursor!);
    terminal.background = '#ff0000';
    assert.equal(getTerminalTheme(theme.id).background, theme.colors.background);
  }
});

test('CSS palettes match audited colors and component styles have no fixed color literals', () => {
  const css = readFileSync(new URL('../src/renderer/themes.css', import.meta.url), 'utf8');
  const components = ['style.css','settings.css'].map(file => readFileSync(new URL('../src/renderer/' + file, import.meta.url), 'utf8')).join('\n');
  for (const { id, colors } of THEMES) {
    const start = css.indexOf(`.theme-preview[data-theme="${id}"] {`);
    assert.ok(start >= 0, `missing root and preview palette for ${id}`);
    const block = css.slice(start, css.indexOf('}', start));
    for (const [token, value] of Object.entries(colors)) assert.ok(block.includes(`--${token}: ${value};`), `${id} ${token} differs from audited palette`);
  }
  assert.doesNotMatch(components, /#[\da-f]{3,8}\b|rgba?\(/i);
  const defined = new Set([...(css + components).matchAll(/--([a-z-]+)\s*:/g)].map(match => match[1]));
  for (const [, token] of (components + css).matchAll(/var\(--([a-z-]+)\)/g)) assert.ok(defined.has(token), `undefined CSS token ${token}`);
});
