import type { ChatApproval } from '../shared/chat';
export interface ApprovalDraft {answers:Record<string,string>;reason:string}
/** Owned by App, so switching or unmounting the active chat cannot discard an answer. */
export class ApprovalDrafts {
  private sessions=new Map<string,Map<string,ApprovalDraft>>();
  get(sessionId:string,requestId:string):ApprovalDraft {return this.sessions.get(sessionId)?.get(requestId)??{answers:{},reason:''};}
  set(sessionId:string,requestId:string,value:ApprovalDraft) {let session=this.sessions.get(sessionId);if(!session){session=new Map();this.sessions.set(sessionId,session);}session.set(requestId,value);}
  has(sessionId:string) {return this.sessions.has(sessionId);}
  delete(sessionId:string,requestId:string) {const session=this.sessions.get(sessionId);session?.delete(requestId);if(!session?.size)this.sessions.delete(sessionId);}
  reconcile(sessionId:string,pending:ChatApproval[]) {const valid=new Set(pending.map(item=>item.requestId));for(const id of this.sessions.get(sessionId)?.keys()??[])if(!valid.has(id))this.delete(sessionId,id);}
  retainSessions(ids:string[]) {const valid=new Set(ids);for(const id of this.sessions.keys())if(!valid.has(id))this.sessions.delete(id);}
}
