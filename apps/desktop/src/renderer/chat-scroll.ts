import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ChatSnapshot } from '../shared/chat';

export interface ChatReadingPosition {
  follow: boolean;
  top: number;
  messageId?: string;
  requestId?: string;
  offset?: number;
}

/** Keep an anchor within the visible message, so wrapping and streamed text above it do not move the reader. */
export function useChatScroll(sessionId: string, snapshot: ChatSnapshot | undefined, positions: Map<string, ChatReadingPosition>) {
  const position=useRef<ChatReadingPosition>(positions.get(sessionId)??{follow:true,top:0});
  const [follow,setFollow]=useState(position.current.follow);
  const following=useRef(follow);following.current=follow;
  const scroll=useRef<HTMLDivElement>(null),content=useRef<HTMLDivElement>(null);
  const ready=useRef(false),adjusting=useRef(false),frame=useRef(0);
  const pendingJump=useRef(false);

  const remember=useCallback(()=>{
    const element=scroll.current;
    if(!ready.current||pendingJump.current||!element||!element.clientHeight)return;
    const next:ChatReadingPosition={follow:following.current,top:element.scrollTop};
    if(!next.follow){
      const top=element.getBoundingClientRect().top;
      const messages=Array.from(element.querySelectorAll<HTMLElement>('[data-message-id],[data-request-id]'));
      // Message rows are in document order. Avoid measuring every row on each scroll event.
      let low=0,high=messages.length;
      while(low<high){const middle=(low+high)>>>1;if(messages[middle].getBoundingClientRect().bottom<=top)low=middle+1;else high=middle;}
      const anchor=messages[low];
      if(anchor){next.messageId=anchor.dataset.messageId;next.requestId=anchor.dataset.requestId;next.offset=anchor.getBoundingClientRect().top-top;}
    }
    position.current=next;positions.set(sessionId,next);
  },[positions,sessionId]);

  const restore=useCallback(()=>{
    const element=scroll.current;
    if(!ready.current||!element)return;
    if(following.current)element.scrollTop=element.scrollHeight;
    else{
      const saved=position.current;
      const anchor=Array.from(element.querySelectorAll<HTMLElement>('[data-message-id],[data-request-id]')).find(message=>saved.messageId?message.dataset.messageId===saved.messageId:!!saved.requestId&&message.dataset.requestId===saved.requestId);
      // A page request can resolve before React commits its messages. Keep the explicit
      // destination until it exists, rather than remembering the previous page's first row.
      if(pendingJump.current&&!anchor)return;
      pendingJump.current=false;
      element.scrollTop=anchor&&saved.offset!==undefined
        ?element.scrollTop+anchor.getBoundingClientRect().top-element.getBoundingClientRect().top-saved.offset
        :saved.top;
    }
    adjusting.current=true;
    cancelAnimationFrame(frame.current);
    frame.current=requestAnimationFrame(()=>{adjusting.current=false;remember();});
  },[remember]);

  useLayoutEffect(()=>{if(snapshot){ready.current=true;restore();}},[snapshot,follow,restore]);
  useLayoutEffect(()=>{
    const observer=new ResizeObserver(restore);
    if(content.current)observer.observe(content.current);
    if(scroll.current)observer.observe(scroll.current);
    return()=>{observer.disconnect();cancelAnimationFrame(frame.current);remember();};
  },[remember,restore]);

  const onScroll=()=>{
    const element=scroll.current;
    if(adjusting.current||pendingJump.current||!ready.current||!element)return;
    const next=element.scrollHeight-element.scrollTop-element.clientHeight<70;
    following.current=next;remember();setFollow(next);
  };
  const jumpToLatest=()=>{pendingJump.current=false;following.current=true;setFollow(true);restore();};
  const jumpToItem=useCallback((id:string,kind:'message'|'request'='message',offset=8)=>{
    following.current=false;
    pendingJump.current=true;
    position.current={follow:false,top:0,offset,...(kind==='message'?{messageId:id}:{requestId:id})};
    positions.set(sessionId,position.current);setFollow(false);restore();
  },[positions,sessionId,restore]);
  return {scroll,content,follow,onScroll,jumpToLatest,jumpToItem};
}
