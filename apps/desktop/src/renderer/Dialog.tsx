import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const focusableSelector='button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';

/** A single modal surface with keyboard containment and focus restoration. */
export function Dialog({label,className='',onClose,closeDisabled=false,children}:{label:string;className?:string;onClose:()=>void;closeDisabled?:boolean;children:ReactNode}) {
  const [host]=useState(()=>document.createElement('div'));
  const [opener]=useState(()=>document.activeElement instanceof HTMLElement?document.activeElement:null);
  const section=useRef<HTMLElement>(null);
  const close=useRef(onClose),disabled=useRef(closeDisabled);
  close.current=onClose;disabled.current=closeDisabled;
  useLayoutEffect(()=>{
    host.dataset.dialogHost='true';document.body.append(host);
    const background=Array.from(document.body.children).filter((element):element is HTMLElement=>element instanceof HTMLElement&&element!==host);
    const original=background.map(element=>({element,inert:element.inert}));
    background.forEach(element=>{element.inert=true;});
    const focusables=()=>Array.from(section.current?.querySelectorAll<HTMLElement>(focusableSelector)??[]).filter(element=>element.getClientRects().length>0&&!element.closest('[inert]'));
    const focusFirst=()=>{(section.current?.querySelector<HTMLElement>('input:not(:disabled),textarea:not(:disabled),select:not(:disabled)')??focusables()[0]??section.current)?.focus();};
    focusFirst();
    const keydown=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(!disabled.current)close.current();}
      if(event.key==='Tab'){
        const items=focusables(),first=items[0],last=items[items.length-1];
        if(!first){event.preventDefault();section.current?.focus();return;}
        if(!section.current?.contains(document.activeElement)||event.shiftKey&&document.activeElement===first||!event.shiftKey&&document.activeElement===last){event.preventDefault();(event.shiftKey?last:first).focus();}
      }
    };
    const focusin=(event:FocusEvent)=>{if(!section.current?.contains(event.target as Node))focusFirst();};
    document.addEventListener('keydown',keydown,true);document.addEventListener('focusin',focusin,true);
    return()=>{
      document.removeEventListener('keydown',keydown,true);document.removeEventListener('focusin',focusin,true);
      original.forEach(({element,inert})=>{element.inert=inert;});host.remove();
      if(opener?.isConnected&&!opener.closest('[inert]'))opener.focus();
    };
  },[host,opener]);
  return createPortal(<div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!disabled.current)close.current();}}><section ref={section} className={'modal '+className} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>{children}</section></div>,host);
}
