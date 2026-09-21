import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { Session, Settings, TerminalChunk } from '../shared/types';
export interface TerminalHandle { paste: (text: string) => void; focus: () => void }

export const TerminalPane = forwardRef<TerminalHandle,{session:Session;settings:Settings;active:boolean;onError:(error:unknown)=>void}>(function TerminalPane({session,settings,active,onError},ref) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const status = useRef(session.status);
  const errorHandler = useRef(onError);
  status.current = session.status; errorHandler.current = onError;
  useImperativeHandle(ref,() => ({paste:text => terminal.current?.paste(text),focus:() => terminal.current?.focus()}),[]);
  useEffect(() => {
    const term = new Terminal({ fontFamily:'"Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace',fontSize:settings.fontSize,
      lineHeight:1.35,scrollback:settings.scrollback,cursorBlink:true,allowProposedApi:false,convertEol:false,
      theme:{background:'#111515',foreground:'#dce3df',cursor:'#b5e8ca',selectionBackground:'#354e43',black:'#242c29',red:'#ec9291',green:'#ace0ba',yellow:'#e4d09a',blue:'#9fbde8',magenta:'#cbb0db',cyan:'#9accc9',white:'#e1e8e4',brightBlack:'#76827a'} });
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
    }).catch(error => errorHandler.current(error));
    const input=term.onData(data => {
      if(status.current !== 'running') return;
      void window.desktop.writeTerminal(session.id,data).catch(error => errorHandler.current(error));
    });
    term.attachCustomKeyEventHandler(event => {
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
    if(terminal.current){terminal.current.options.fontSize=settings.fontSize;terminal.current.options.scrollback=settings.scrollback;}
    if(active)requestAnimationFrame(() => {fit.current?.fit();terminal.current?.focus();if(terminal.current && session.status==='running')void window.desktop.resizeTerminal(session.id,Math.min(terminal.current.cols,500),Math.min(terminal.current.rows,300)).catch(onError);});
  },[active,settings.fontSize,settings.scrollback,session.status,session.id,onError]);
  return <div className="terminal-host" ref={host} aria-label={`${session.title}终端`}/>;
});
