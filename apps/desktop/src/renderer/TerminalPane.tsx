import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { Session, Settings, TerminalChunk } from '../shared/types';
import type { ThemeId } from '../shared/theme';
import { getTerminalTheme } from './themes';
import { terminalPromptPacket } from './composer-keyboard';
export interface TerminalHandle { paste: (text: string) => void; submit: (text: string) => Promise<void>; focus: () => void }

export const TerminalPane = forwardRef<TerminalHandle,{session:Session;settings:Settings;themeId:ThemeId;active:boolean;onError:(error:unknown)=>void}>(function TerminalPane({session,settings,themeId,active,onError},ref) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const status = useRef(session.status);
  const errorHandler = useRef(onError);
  status.current = session.status; errorHandler.current = onError;
  useImperativeHandle(ref,() => ({
    paste:text => terminal.current?.paste(text),
    submit:async text => {
      if(status.current!=='running'||!terminal.current)throw new Error('终端尚未就绪，请先启动会话。');
      if(!terminal.current.modes.bracketedPasteMode)throw new Error('CLI 尚未准备好接收提示词，请在终端完成登录或目录信任后重试。');
      // A single IPC write prevents Enter from overtaking a pending asynchronous paste.
      await window.desktop.writeTerminal(session.id,terminalPromptPacket(text));
    },
    focus:() => terminal.current?.focus()
  }),[session.id]);
  useEffect(() => {
    const term = new Terminal({ fontFamily:'"Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace',fontSize:settings.fontSize,
      lineHeight:1.35,scrollback:settings.scrollback,cursorBlink:true,allowProposedApi:false,convertEol:false,minimumContrastRatio:4.5,
      theme:getTerminalTheme(themeId) });
    const addon = new FitAddon(); term.loadAddon(addon);term.open(host.current!);
    terminal.current=term;fit.current=addon;
    let disposed=false;let hydrating=true;let lastSeq=0;const waiting:TerminalChunk[]=[];
    const consume=(chunk:TerminalChunk) => {if(chunk.seq>lastSeq){term.write(chunk.data);lastSeq=chunk.seq;}};
    // Subscribe before the snapshot, deduplicate by sequence: no lost or repeated output.
    const off=window.desktop.onTerminal(chunk => {
      if(chunk.sessionId !== session.id || disposed)return;
      if(hydrating)waiting.push(chunk);else consume(chunk);
    });
    window.desktop.terminalSnapshot(session.id).then(snapshot => {
      if(disposed)return;
      for(const chunk of snapshot.chunks)consume(chunk);
      for(const chunk of waiting)consume(chunk);
      hydrating=false;
    }).catch(error => {if(disposed)return;hydrating=false;for(const chunk of waiting)consume(chunk);waiting.length=0;errorHandler.current(error);});
    const input=term.onData(data => {
      if(status.current !== 'running') return;
      void window.desktop.writeTerminal(session.id,data).catch(error => errorHandler.current(error));
    });
    term.attachCustomKeyEventHandler(event => {
      if((event.ctrlKey || event.metaKey) && event.code === 'KeyK')return false;
      if((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyC' && term.hasSelection()) {
        if(event.type === 'keydown') void navigator.clipboard.writeText(term.getSelection()).catch(error => errorHandler.current(error));
        return false;
      }
      return true;
    });
    const resize=() => {
      if(!host.current?.clientWidth || !host.current.clientHeight)return;
      addon.fit();
      if(status.current === 'running')void window.desktop.resizeTerminal(session.id,Math.min(term.cols,500),Math.min(term.rows,300)).catch(error => errorHandler.current(error));
    };
    const observer=new ResizeObserver(resize);observer.observe(host.current!);resize();
    return () => {disposed=true;off();observer.disconnect();input.dispose();term.dispose();terminal.current=null;};
    // A live terminal is owned by the session, not by a render or settings update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[session.id]);
  useEffect(() => {
    // xterm repaints its existing buffer when its palette changes. Keep the live
    // instance (and therefore scroll position, selection and PTY subscription).
    if(terminal.current)terminal.current.options.theme=getTerminalTheme(themeId);
  },[themeId]);
  useEffect(() => {
    if(terminal.current){terminal.current.options.fontSize=settings.fontSize;terminal.current.options.scrollback=settings.scrollback;}
    if(active)requestAnimationFrame(() => {fit.current?.fit();if(terminal.current && session.status==='running')void window.desktop.resizeTerminal(session.id,Math.min(terminal.current.cols,500),Math.min(terminal.current.rows,300)).catch(onError);});
  },[active,settings.fontSize,settings.scrollback,session.status,session.id,onError]);
  useEffect(()=>{
    if(!active)return;
    // Activation is deferred until xterm is laid out. A user may already have
    // moved to the composer (or another control) before that frame runs.
    const focused=document.activeElement;
    let keepFocus=focused instanceof HTMLElement && (focused.matches('input, textarea, select') || focused.isContentEditable);
    const moved=()=>{keepFocus=true;};
    document.addEventListener('focusin',moved);
    const frame=requestAnimationFrame(()=>{
      document.removeEventListener('focusin',moved);
      if(!keepFocus)terminal.current?.focus();
    });
    return ()=>{cancelAnimationFrame(frame);document.removeEventListener('focusin',moved);};
  },[active]);
  return <div className="terminal-host" ref={host} aria-label={`${session.title}终端`}/>;
});
