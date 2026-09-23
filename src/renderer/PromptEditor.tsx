import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { composerKeyAction, insertComposerNewline } from './composer-keyboard';
import type { SessionCommand } from '../shared/execution';
import { insertCommand, matchingCommands, slashQuery } from '../shared/session-commands';

export function PromptEditor({ value, onChange, onSend, placeholder, disabled, commands, loadCommands }: {
  value: string; onChange: (value: string) => void; onSend: () => void;
  placeholder: string; disabled?: boolean;
  commands?: SessionCommand[]; loadCommands?: () => Promise<void>;
}) {
  const composing = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const pendingSelection = useRef<{ value: string; caret: number } | undefined>(undefined);
  const [selection, setSelection] = useState({ start: value.length, end: value.length });
  const [focused, setFocused] = useState(false), [dismissed, setDismissed] = useState(false);
  const [selected, setSelected] = useState(0), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const requested = useRef(false), mounted = useRef(true), listId = useId();
  const query = loadCommands ? slashQuery(value, selection.start, selection.end) : undefined;
  const open = focused && !disabled && !dismissed && query !== undefined;
  const matches = matchingCommands(commands ?? [], query ?? '');
  const activeIndex = Math.min(selected, Math.max(0, matches.length - 1));
  const active = matches[activeIndex];
  const request = async () => {
    if (!loadCommands || loading) return;
    requested.current = true; setLoading(true); setError('');
    try { await loadCommands(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mounted.current) setLoading(false); }
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (open && commands === undefined && !requested.current) void request();
    if (!open) requested.current = false;
  }, [open, commands]);
  useEffect(() => { setSelected(0); }, [query]);
  useEffect(() => { if (open) document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: 'nearest' }); }, [open, activeIndex, listId]);
  const choose = (command: SessionCommand) => {
    if (command.disabledReason) return;
    const next = insertCommand(value, command.name);
    pendingSelection.current = next;
    setSelection({ start: next.caret, end: next.caret }); setDismissed(true);
    onChange(next.value); input.current?.focus();
  };
  useLayoutEffect(() => {
    const pending = pendingSelection.current;
    pendingSelection.current = undefined;
    if (pending && value === pending.value) input.current?.setSelectionRange(pending.caret, pending.caret);
  }, [value]);
  return <>
    {open && <section className="slash-menu" aria-label="Claude 命令与 Skills">
      <header><strong>命令与 Skills</strong><span>↑ ↓ 选择 · Enter / Tab 填入 · Esc 关闭</span></header>
      {loading && <p role="status">正在读取当前会话的命令…</p>}
      {error && <p role="alert">{error}<button type="button" onMouseDown={event => event.preventDefault()} onClick={() => void request()}>重试</button></p>}
      {!loading && !error && !matches.length && <p>{commands === undefined ? '命令列表尚未就绪，请稍后重试。' : commands.length ? '没有匹配的命令或 Skill' : '当前 CLI 未提供命令列表；仍可直接输入完整命令。'}{commands === undefined && <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => void request()}>重试</button>}</p>}
      <div id={listId} role="listbox" aria-label="可用命令">
        {matches.map((command, index) => <button type="button" role="option" id={`${listId}-${index}`} key={command.name} tabIndex={-1}
          aria-selected={index === activeIndex} aria-disabled={!!command.disabledReason}
          onMouseDown={event => event.preventDefault()} onMouseMove={() => setSelected(index)} onClick={() => choose(command)}>
          <span className="slash-name">/{command.name}<small>{command.argumentHint}</small></span>
          <span className="slash-kind">{command.kind === 'builtin' ? '系统命令' : command.kind === 'skill' ? 'Skill' : '命令 / Skill'}</span>
          <span className="slash-description">{command.disabledReason || command.description || '由当前 Claude Code 会话提供'}</span>
        </button>)}
      </div>
    </section>}
    <textarea ref={input} aria-label="提示词编辑器" placeholder={placeholder} value={value} disabled={disabled}
    role={loadCommands ? 'combobox' : undefined} aria-expanded={loadCommands ? open : undefined} aria-autocomplete={loadCommands ? 'list' : undefined}
    aria-controls={open ? listId : undefined} aria-activedescendant={open && active ? `${listId}-${activeIndex}` : undefined}
    onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
    onSelect={event => setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })}
    onChange={event => { pendingSelection.current = undefined; setDismissed(false); setSelection({ start: event.target.selectionStart, end: event.target.selectionEnd }); onChange(event.target.value); }}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={() => { composing.current = false; }}
    onKeyDown={event => {
      if (open && !composing.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDismissed(true); return; }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); setSelected(matches.length ? (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length : 0); return;
        }
        if ((event.key === 'Enter' || event.key === 'Tab') && active) {
          event.preventDefault(); if (!event.repeat) choose(active); return;
        }
        if (event.key === 'Enter' && (loading || !query)) { event.preventDefault(); return; }
      }
      const action = composerKeyAction(event.nativeEvent, composing.current);
      if (!action) return;
      event.preventDefault();
      if (action === 'send') onSend();
      if (action === 'newline') {
        const target = event.currentTarget;
        const next = insertComposerNewline(value, target.selectionStart, target.selectionEnd);
        if (next.value === value) {
          target.setSelectionRange(next.caret, next.caret);
          return;
        }
        // Restore before the next keystroke, never in a delayed animation frame.
        pendingSelection.current = next;
        onChange(next.value);
      }
    }}/>
  </>;
}
