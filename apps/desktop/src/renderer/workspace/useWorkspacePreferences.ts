import { useEffect, useRef, useState } from 'react';
import type { ImportedFont } from '../../shared/fonts';
import type { Settings } from '../../shared/types';
import type { SettingsPage } from '../SettingsPanel';
import { loadFont, unloadImportedFont } from '../typography';
import type { Perform, ReportError } from './types';
import { useWorkspaceAppearance } from './useWorkspaceAppearance';

interface Options {
  settings?: Settings; open: boolean; refresh: () => Promise<void>;
  perform: Perform; report: ReportError; notify: (message: string) => void;
}

export function useWorkspacePreferences({ settings, open, refresh, perform, report, notify }: Options) {
  const [value, onChange] = useState<Settings>();
  const [page, onPage] = useState<SettingsPage>('appearance');
  const [fonts, setFonts] = useState<ImportedFont[]>([]);
  const focusIde = useRef(false);
  const themeId = useWorkspaceAppearance(settings, open ? value : undefined, report);
  useEffect(() => {
    if (window.desktop) void window.desktop.listFonts().then(setFonts).catch(report);
  }, [report]);
  useEffect(() => {
    if (open && focusIde.current) {
      focusIde.current = false;
      const input = document.getElementById('ide-application-path');
      input?.focus(); input?.scrollIntoView({ block: 'center' });
    }
  }, [open]);
  const begin = (nextPage: SettingsPage = 'appearance', focusIdePath = false) => {
    if (!settings) return;
    onChange({ ...settings }); onPage(nextPage); focusIde.current = focusIdePath;
  };
  const onSave = (detect: boolean) => void perform(async () => {
    if (!value) return;
    const cliChanged = value.claudePath !== settings?.claudePath;
    await window.desktop.saveSettings(value);
    if (detect && !cliChanged) await window.desktop.detect();
    await refresh(); notify(detect ? '设置已保存并完成检测' : '设置已保存');
  });
  const onChooseIde = () => void perform(async () => {
    const idePath = await window.desktop.chooseIdeApplication();
    if (idePath !== null) onChange(current => current ? { ...current, idePath } : current);
  });
  const onChooseWorktree = () => void perform(async () => {
    const worktreeRoot = await window.desktop.chooseWorktreeRoot();
    if (worktreeRoot !== null) onChange(current => current ? { ...current, worktreeRoot } : current);
  });
  const onImport = () => void perform(async () => {
    const font = await window.desktop.importFont();
    if (!font) return;
    try { await loadFont(font.id); }
    catch {
      await window.desktop.removeFont(font.id); unloadImportedFont(font.id);
      setFonts(await window.desktop.listFonts());
      throw new Error('此字体无法被显示引擎读取，已撤销导入。请选择完整有效的字体文件。');
    }
    setFonts(await window.desktop.listFonts()); notify('字体已导入，可分别为聊天和菜单选择');
  });
  const onRemove = (id: string) => void perform(async () => {
    await window.desktop.removeFont(id); unloadImportedFont(id);
    onChange(current => current ? {
      ...current, chatFontFamily: current.chatFontFamily === id ? 'system' : current.chatFontFamily,
      uiFontFamily: current.uiFontFamily === id ? 'system' : current.uiFontFamily
    } : current);
    setFonts(await window.desktop.listFonts()); await refresh(); notify('字体副本已移除，原文件保持不变');
  });
  return { value, themeId, begin, editor: { onChange, page, onPage, fonts, onSave, onChooseIde, onChooseWorktree, onImport, onRemove } };
}
