import { useEffect, useLayoutEffect, useState } from 'react';
import { typography } from '../../shared/fonts';
import { normalizeThemeId } from '../../shared/theme';
import type { Settings } from '../../shared/types';
import { cacheSavedTheme, readCachedTheme } from '../theme-preferences';
import { applyTheme } from '../themes';
import { applyTypography, cacheSavedTypography, loadFont, readCachedTypography } from '../typography';
import type { ReportError } from './types';

export function useWorkspaceAppearance(settings: Settings | undefined, preview: Settings | undefined, report: ReportError) {
  const [startupTypography] = useState(readCachedTypography);
  const displayedTypography = typography(preview ?? settings ?? startupTypography);
  useLayoutEffect(() => { applyTypography(displayedTypography); }, [displayedTypography.chatFontFamily, displayedTypography.chatFontSize, displayedTypography.uiFontFamily, displayedTypography.uiFontSize]);
  useEffect(() => { if (settings) cacheSavedTypography(settings); }, [settings?.chatFontFamily, settings?.chatFontSize, settings?.uiFontFamily, settings?.uiFontSize, !!settings]);
  const [startupTheme] = useState(readCachedTheme);
  const savedTheme = settings ? normalizeThemeId(settings.theme) : startupTheme;
  const themeId = preview ? normalizeThemeId(preview.theme) : savedTheme;
  useLayoutEffect(() => { applyTheme(themeId); }, [themeId]);
  useEffect(() => { if (settings) cacheSavedTheme(normalizeThemeId(settings.theme)); }, [settings?.theme, !!settings]);
  useEffect(() => {
    if (!window.desktop) return;
    let active = true;
    for (const family of new Set([displayedTypography.chatFontFamily, displayedTypography.uiFontFamily])) void loadFont(family).catch(() => { if (active) report(new Error('所选字体无法加载，已使用系统字体显示。请重新选择或移除后重新导入。')); });
    return () => { active = false; };
  }, [displayedTypography.chatFontFamily, displayedTypography.uiFontFamily, report]);
  return themeId;
}
