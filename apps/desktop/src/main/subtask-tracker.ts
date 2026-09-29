import { isDeepStrictEqual } from 'node:util';
import { isSubtaskActive, SUBTASK_LIMIT, type Subtask, type SubtaskActivity, type SubtaskStatus } from '../shared/subtasks';
import type { StateStore } from './store';

export interface SubtaskObservation extends Partial<Omit<Subtask,'id'|'source'|'status'>> {
  source: Subtask['source']; status: SubtaskStatus;
  phase?: 'start' | 'progress' | 'finish';
}
const identities = ['taskId','toolUseId','agentId'] as const;
const definite = (status: SubtaskStatus) => ['completed','failed','stopped'].includes(status);
const bounded = (value: unknown, max: number) => typeof value==='string' ? value.slice(0,max) : undefined;
const validIdentity = (value: unknown): value is string => typeof value==='string' && value.length>0 && value.length<=200 && !/[\x00-\x1f\x7f]/.test(value);
const at = () => new Date().toISOString();

/** Independent of the bounded chat message window, shared by structured and PTY adapters. */
export class SubtaskTracker {
  constructor(private store: StateStore, private onState: () => void) {}
  private activity(id: string): SubtaskActivity | undefined { return this.store.state.sessions.find(s=>s.id===id)?.subtasks; }
  private save(id: string, activity: SubtaskActivity) {
    if(!this.store.state.sessions.some(s=>s.id===id))return;
    if(this.store.change(state=>{state.sessions.find(s=>s.id===id)!.subtasks=activity;},{defer:true}))this.onState();
  }
  begin(id: string, turnId: string) {
    if(!validIdentity(turnId))return;
    const previous=this.activity(id);
    if(previous?.turnId===turnId)return;
    this.save(id,{...previous,turnId,tasks:previous?.tasks??[]});
  }
  observe(id: string, observation: SubtaskObservation): Subtask | undefined {
    if(!identities.some(key=>validIdentity(observation[key])))return;
    const previous=this.activity(id);
    const turnId=validIdentity(observation.turnId)?observation.turnId:previous?.turnId || 'observed';
    const activity: SubtaskActivity=structuredClone(previous??{turnId,tasks:[]});
    const matches=(task:Subtask)=> {
      if(task.source!==observation.source)return false;
      if(task.source==='hooks'&&task.taskId&&validIdentity(observation.taskId)&&task.taskId!==observation.taskId)return false;
      // Resuming an agent creates another tool invocation even when its agent ID is reused.
      if(task.toolUseId&&validIdentity(observation.toolUseId)&&task.toolUseId!==observation.toolUseId)return false;
      return identities.some(key=>validIdentity(observation[key])&&task[key]===observation[key]) ||
        task.source==='stream'&&(task.kind==='agent'||observation.kind==='agent')&&
        (validIdentity(observation.taskId)&&observation.taskId===task.agentId || validIdentity(observation.agentId)&&observation.agentId===task.taskId);
    };
    let candidates=activity.tasks.filter(task=>task.turnId===turnId&&matches(task));
    if(!candidates.length && observation.phase!=='start' && !validIdentity(observation.turnId)) {
      // A delayed completion belongs to its original turn, not the prompt currently on screen.
      const older=activity.tasks.filter(matches);
      const latest=older.at(-1);
      if(latest)candidates=older.filter(task=>task.turnId===latest.turnId);
    }
    if(new Set(candidates.map(task=>task.toolUseId).filter(Boolean)).size>1) {
      // Sparse system events cannot combine distinct Agent invocations. Prefer the current live one.
      const preferred=candidates.filter(task=>isSubtaskActive(task.status)).at(-1)??candidates.at(-1)!;
      candidates=candidates.filter(task=>!task.toolUseId||task.toolUseId===preferred.toolUseId);
    }
    const existing=candidates[0];
    const timestamp=at();
    const key=identities.find(field=>validIdentity(observation[field]))!;
    let next: Subtask=existing?{...existing}:{id:JSON.stringify([turnId,observation.source,key,observation[key]]),turnId,source:observation.source,kind:observation.kind??'task',status:observation.status,description:'子任务',startedAt:timestamp,updatedAt:timestamp};
    // Alias records may arrive before their linking envelope. Merge them into one stable row.
    for(const task of candidates.slice(1)) {
      for(const field of identities)if(!next[field]&&task[field])next[field]=task[field];
      for(const field of ['parentToolUseId','summary','progress','lastTool','toolUses','totalTokens','durationMs','background'] as const) {
        if(next[field]===undefined && task[field]!==undefined)Object.assign(next,{[field]:task[field]});
      }
      if(next.description==='子任务'&&task.description!=='子任务')next.description=task.description;
      if(next.kind==='task')next.kind=task.kind;
      if(isSubtaskActive(next.status)&&!isSubtaskActive(task.status))next={...next,status:task.status,endedAt:task.endedAt,summary:task.summary??next.summary};
      if(task.startedAt<next.startedAt)next.startedAt=task.startedAt;
    }
    const stale=existing && !isSubtaskActive(next.status) && (isSubtaskActive(observation.status)||definite(next.status)&&observation.status!==next.status);
    for(const field of identities)if(validIdentity(observation[field]))next[field]=observation[field];
    if(validIdentity(observation.parentToolUseId))next.parentToolUseId=observation.parentToolUseId;
    if(observation.kind)next.kind=observation.kind;
    if(observation.description?.trim() && (!stale || next.description==='子任务'))next.description=bounded(observation.description.trim(),500)!;
    if(!stale) {
      // Replayed launch envelopes must not send an executing task back to its queued state.
      if(!existing || observation.phase!=='start' || next.status==='pending')next.status=observation.status;
      for(const field of ['summary','progress','lastTool'] as const) {
        const value=bounded(observation[field],field==='lastTool'?200:2000);
        if(value!==undefined)next[field]=value;
      }
      for(const field of ['toolUses','totalTokens','durationMs'] as const) {
        const value=observation[field];
        if(typeof value==='number'&&Number.isFinite(value)&&value>=0)next[field]=Math.max(next[field]??0,Math.min(value,Number.MAX_SAFE_INTEGER));
      }
      if(typeof observation.background==='boolean')next.background=observation.background;
      if(!isSubtaskActive(next.status))next.endedAt=existing?.endedAt??timestamp;
    }
    if(existing && candidates.length===1 && isDeepStrictEqual(next,existing))return structuredClone(existing);
    next.updatedAt=timestamp;
    if(existing) {
      const removed=new Set(candidates.map(task=>task.id));
      const index=activity.tasks.findIndex(task=>task.id===existing.id);
      activity.tasks=activity.tasks.filter(task=>!removed.has(task.id));
      activity.tasks.splice(Math.min(index,activity.tasks.length),0,next);
    } else {
      if(activity.tasks.length>=SUBTASK_LIMIT) {
        const index=activity.tasks.findIndex(task=>!isSubtaskActive(task.status));
        activity.truncated=true;
        if(index<0){this.save(id,activity);return;}
        activity.tasks.splice(index,1);
      }
      activity.tasks.push(next);
    }
    this.save(id,activity);
    return structuredClone(next);
  }
  end(id: string, status: 'interrupted' | 'failed' | 'unknown', reason?: string) {
    const previous=this.activity(id);
    if(!previous?.tasks.some(task=>isSubtaskActive(task.status)))return;
    const timestamp=at();
    const tasks=previous.tasks.map(task=>isSubtaskActive(task.status)?{...task,status,updatedAt:timestamp,endedAt:timestamp,summary:bounded(reason,2000)??task.summary}:task);
    this.save(id,{...previous,tasks});
  }
}
