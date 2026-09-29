import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react';

const hasFiles = (transfer: DataTransfer | null) => !!transfer &&
  (Array.from(transfer.types).includes('Files') || Array.from(transfer.items).some(item => item.kind === 'file') || transfer.files.length > 0);

/** File drops stage native files; ordinary text drags retain the browser's editing behavior. */
export function useChatFileDrop(disabled: boolean, onFiles: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const reset = useCallback(() => { depth.current = 0; setDragging(false); }, []);
  useEffect(reset, [disabled, reset]);
  useEffect(() => {
    const preventNavigation = (event: DragEvent) => { if (hasFiles(event.dataTransfer)) event.preventDefault(); };
    const dropped = (event: DragEvent) => { preventNavigation(event); reset(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') reset(); };
    const visibility = () => { if (document.hidden) reset(); };
    // A file released outside the pane, or on an inert pane during CLI update,
    // must not navigate away from the desktop app.
    window.addEventListener('dragover', preventNavigation, true);
    window.addEventListener('drop', dropped, true);
    window.addEventListener('dragend', reset);
    window.addEventListener('blur', reset);
    window.addEventListener('keydown', escape);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('dragover', preventNavigation, true);
      window.removeEventListener('drop', dropped, true);
      window.removeEventListener('dragend', reset);
      window.removeEventListener('blur', reset);
      window.removeEventListener('keydown', escape);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [reset]);
  const consume = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasFiles(event.dataTransfer)) return false;
    event.preventDefault(); event.stopPropagation();
    event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
    return true;
  };
  return { dragging, handlers: {
    onDragEnterCapture: (event: ReactDragEvent<HTMLDivElement>) => {
      if (!consume(event)) return;
      depth.current++; setDragging(true);
    },
    onDragOverCapture: (event: ReactDragEvent<HTMLDivElement>) => {
      if (consume(event)) { depth.current = Math.max(1, depth.current); setDragging(true); }
    },
    onDragLeaveCapture: (event: ReactDragEvent<HTMLDivElement>) => {
      if (!depth.current) return;
      depth.current = Math.max(0, depth.current - 1);
      const rect = event.currentTarget.getBoundingClientRect();
      if (!depth.current || event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom) reset();
    },
    onDropCapture: (event: ReactDragEvent<HTMLDivElement>) => {
      if (!consume(event)) return;
      const files = Array.from(event.dataTransfer.files);
      reset();
      if (!disabled && files.length) onFiles(files);
    },
  } };
}
