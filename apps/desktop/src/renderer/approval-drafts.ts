import type { ChatApproval } from '../shared/chat';
export interface ApprovalDraft {answers:Record<string,string>;reason:string}
interface ApprovalResponse {behavior:'allow'|'deny';status:'submitting'|'accepted'}
/** Owned by App, so switching chats cannot discard answers or repeat a submitted decision. */
export class ApprovalDrafts {
  private sessions=new Map<string,Map<string,ApprovalDraft>>();
  private responses=new Map<string,Map<string,ApprovalResponse>>();
  private listeners=new Set<()=>void>();
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private changed(){for(const listener of this.listeners)listener();}
  response(sessionId:string,requestId:string){return this.responses.get(sessionId)?.get(requestId);}
  submitResponse(sessionId:string,requestId:string,behavior:'allow'|'deny',send:()=>Promise<void>):Promise<void>|undefined {
    let session=this.responses.get(sessionId);
    if(session?.has(requestId))return;
    if(!session){session=new Map();this.responses.set(sessionId,session);}
    const response:ApprovalResponse={behavior,status:'submitting'};
    // Claim synchronously: two clicks before React renders must still send once.
    session.set(requestId,response);this.changed();
    return Promise.resolve().then(send).then(()=>{
      if(this.response(sessionId,requestId)!==response)return;
      this.delete(sessionId,requestId);
      session.set(requestId,{behavior,status:'accepted'});this.changed();
    },error=>{
      // A resolved/deleted request must not be revived by a late IPC failure.
      if(this.response(sessionId,requestId)!==response)return;
      session.delete(requestId);if(!session.size)this.responses.delete(sessionId);
      this.changed();throw error;
    });
  }
  get(sessionId:string,requestId:string):ApprovalDraft {return this.sessions.get(sessionId)?.get(requestId)??{answers:{},reason:''};}
  set(sessionId:string,requestId:string,value:ApprovalDraft) {let session=this.sessions.get(sessionId);if(!session){session=new Map();this.sessions.set(sessionId,session);}session.set(requestId,value);}
  has(sessionId:string) {return this.sessions.has(sessionId)||this.responses.has(sessionId);}
  delete(sessionId:string,requestId:string) {const session=this.sessions.get(sessionId);session?.delete(requestId);if(!session?.size)this.sessions.delete(sessionId);}
  reconcile(sessionId:string,pending:ChatApproval[]) {
    const valid=new Set(pending.map(item=>item.requestId));
    for(const id of this.sessions.get(sessionId)?.keys()??[])if(!valid.has(id))this.delete(sessionId,id);
    const responses=this.responses.get(sessionId);let changed=false;
    for(const id of responses?.keys()??[])if(!valid.has(id)){responses!.delete(id);changed=true;}
    if(!responses?.size)this.responses.delete(sessionId);
    if(changed)this.changed();
  }
  retainSessions(ids:string[]) {
    const valid=new Set(ids);let changed=false;
    for(const id of this.sessions.keys())if(!valid.has(id))this.sessions.delete(id);
    for(const id of this.responses.keys())if(!valid.has(id)){this.responses.delete(id);changed=true;}
    if(changed)this.changed();
  }
}
