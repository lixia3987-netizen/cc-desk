import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ChatSnapshot } from '../shared/chat';

export interface ChatReadingPosition {
  follow: boolean;
  top: number;
  messageId?: string;
  requestId?: string;
  offset?: number;
}

/** 在可见消息内部保留锚点，避免上方内容换行或流式更新改变阅读位置。 */
export function useChatScroll(sessionId: string, snapshot: ChatSnapshot | undefined, positions: Map<string, ChatReadingPosition>, ensureMessage?: (id: string) => Promise<boolean>, tailAvailable = true) {
  const position=useRef<ChatReadingPosition>(positions.get(sessionId)??{follow:true,top:0});
  const [follow,setFollow]=useState(position.current.follow);
  const following=useRef(follow);following.current=follow&&tailAvailable;
  const available=useRef(tailAvailable);available.current=tailAvailable;
  const scroll=useRef<HTMLDivElement>(null),content=useRef<HTMLDivElement>(null);
  const ready=useRef(false),adjusting=useRef(false),frame=useRef(0);
  const pendingJump=useRef(false);
  const mounting=useRef<string | undefined>(undefined);
  const restoreLater=useRef<()=>void>(()=>{});
  const latestSnapshot=useRef(snapshot);latestSnapshot.current=snapshot;

  const remember=useCallback(()=>{
    const element=scroll.current;
    if(!ready.current||pendingJump.current||!element||!element.clientHeight)return;
    const next:ChatReadingPosition={follow:following.current,top:element.scrollTop};
    if(!next.follow){
      const top=element.getBoundingClientRect().top;
      const messages=Array.from(element.querySelectorAll<HTMLElement>('[data-message-id],[data-request-id]'));
      // 消息行按文档顺序排列，避免在每次滚动事件中测量所有行。
      let low=0,high=messages.length;
      while(low<high){const middle=(low+high)>>>1;if(messages[middle].getBoundingClientRect().bottom<=top)low=middle+1;else high=middle;}
      const anchor=messages[low];
      if(anchor){
        const bounds=anchor.getBoundingClientRect();
        // A fling may reach a spacer before the virtual window commits. Do not capture
        // an overscan row far outside this viewport as the new reading anchor.
        if(bounds.top<top+element.clientHeight&&bounds.bottom>top){next.messageId=anchor.dataset.messageId;next.requestId=anchor.dataset.requestId;next.offset=bounds.top-top;}
      }
    }
    position.current=next;positions.set(sessionId,next);
  },[positions,sessionId]);
  const rememberRestored=useCallback(()=>{
    const saved=position.current,snapshot=latestSnapshot.current;
    const anchored=!following.current&&(saved.messageId?snapshot?.messages.some(message=>message.id===saved.messageId)
      :saved.requestId?snapshot?.pending.some(request=>request.requestId===saved.requestId):false);
    if(!anchored){remember();return;}
    // 后续测量或定位页仍会改变虚拟起点；程序恢复须保留原消息和偏移，
    // 只有用户滚动才重新选择阅读锚点。
    const top=scroll.current?.scrollTop;
    if(top!==undefined&&top!==saved.top){position.current={...saved,top};positions.set(sessionId,position.current);}
  },[remember,positions,sessionId]);

  const restore=useCallback(()=>{
    const element=scroll.current;
    if(!ready.current||!element)return;
    if(following.current)element.scrollTop=element.scrollHeight;
    else{
      const saved=position.current;
      const anchor=Array.from(element.querySelectorAll<HTMLElement>('[data-message-id],[data-request-id]')).find(message=>saved.messageId?message.dataset.messageId===saved.messageId:!!saved.requestId&&message.dataset.requestId===saved.requestId);
      if(!anchor&&saved.messageId&&ensureMessage&&latestSnapshot.current?.messages.some(message=>message.id===saved.messageId)){
        if(mounting.current!==saved.messageId){
          const id=saved.messageId;mounting.current=id;
          void ensureMessage(id).then(found=>{if(mounting.current===id){mounting.current=undefined;if(found)restoreLater.current();}});
        }
        return;
      }
      // 分页请求可能在 React 提交消息前完成，应保留明确的
      // 目标直到它出现，避免记住上一页的首行。
      if(pendingJump.current&&!anchor)return;
      pendingJump.current=false;
      element.scrollTop=anchor&&saved.offset!==undefined
        ?element.scrollTop+anchor.getBoundingClientRect().top-element.getBoundingClientRect().top-saved.offset
        :saved.top;
    }
    adjusting.current=true;
    cancelAnimationFrame(frame.current);
    frame.current=requestAnimationFrame(()=>{adjusting.current=false;rememberRestored();});
  },[rememberRestored,ensureMessage]);
  restoreLater.current=restore;

  useLayoutEffect(()=>{if(!tailAvailable&&follow)setFollow(false);if(snapshot){ready.current=true;restore();}},[snapshot,follow,tailAvailable,restore]);
  useLayoutEffect(()=>{
    const observer=new ResizeObserver(restore);
    if(content.current)observer.observe(content.current);
    if(scroll.current)observer.observe(scroll.current);
    const element=scroll.current;
    const interruptRestore=(event:Event)=>{
      if(event instanceof KeyboardEvent&&!['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key))return;
      // 用户操作中止程序恢复及其单帧保护，下一次滚动按实际位置记录新意图。
      cancelAnimationFrame(frame.current);adjusting.current=false;pendingJump.current=false;mounting.current=undefined;
    };
    const events=['wheel','touchstart','pointerdown','keydown'];
    for(const event of events)element?.addEventListener(event,interruptRestore,{passive:true});
    return()=>{
      observer.disconnect();cancelAnimationFrame(frame.current);
      for(const event of events)element?.removeEventListener(event,interruptRestore);
      rememberRestored();
    };
  },[rememberRestored,restore]);

  const onScroll=()=>{
    const element=scroll.current;
    if(adjusting.current||pendingJump.current||!ready.current||!element)return;
    const next=available.current&&element.scrollHeight-element.scrollTop-element.clientHeight<70;
    following.current=next;remember();setFollow(next);
  };
  const jumpToLatest=useCallback(()=>{if(!available.current)return;pendingJump.current=false;following.current=true;setFollow(true);restoreLater.current();},[]);
  const jumpToItem=useCallback((id:string,kind:'message'|'request'='message',offset=8)=>{
    following.current=false;
    pendingJump.current=true;
    position.current={follow:false,top:0,offset,...(kind==='message'?{messageId:id}:{requestId:id})};
    positions.set(sessionId,position.current);setFollow(false);restore();
  },[positions,sessionId,restore]);
  const captureReading=useCallback(()=>{following.current=false;setFollow(false);remember();},[remember]);
  return {scroll,content,follow:follow&&tailAvailable,onScroll,jumpToLatest,jumpToItem,remember:captureReading};
}
