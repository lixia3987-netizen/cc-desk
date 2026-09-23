import { useLayoutEffect, useRef } from 'react';
import { composerKeyAction, insertComposerNewline } from './composer-keyboard';

export function PromptEditor({ value, onChange, onSend, placeholder, disabled }: {
  value: string; onChange: (value: string) => void; onSend: () => void;
  placeholder: string; disabled?: boolean;
}) {
  const composing = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const pendingSelection = useRef<{ value: string; caret: number } | undefined>(undefined);
  useLayoutEffect(() => {
    const pending = pendingSelection.current;
    pendingSelection.current = undefined;
    if (pending && value === pending.value) input.current?.setSelectionRange(pending.caret, pending.caret);
  }, [value]);
  return <textarea ref={input} aria-label="提示词编辑器" placeholder={placeholder} value={value} disabled={disabled}
    onChange={event => { pendingSelection.current = undefined; onChange(event.target.value); }}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={() => { composing.current = false; }}
    onKeyDown={event => {
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
}
