import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatSnapshot, ChatSnapshotVersion } from '../src/shared/chat';
import { ChatSnapshotClock } from '../src/main/chat-snapshot-clock';
import { ChatSnapshotSync, type ChatSyncState } from '../src/renderer/chat-snapshot-sync';

const version=(revision:number,eventSequence=revision,hostEpoch='host-a'):ChatSnapshotVersion=>({hostEpoch,revision,eventSequence,conversationId:'conversation'});
const snapshot=(revision:number,taskState:ChatSnapshot['taskState']='thinking',hostEpoch='host-a'):ChatSnapshot=>({sessionId:'session',taskState,messages:[],pending:[],version:version(revision,revision,hostEpoch)});
const deferred=<T>()=>{let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fixture(read:()=>Promise<ChatSnapshot>){
  const applied:ChatSnapshot[]=[],states:ChatSyncState[]=[];
  const sync=new ChatSnapshotSync('session',{read,apply:value=>applied.push(value),state:value=>states.push(value)});
  return {sync,applied,states};
}

test('one host clock orders reads and notifications separately from durable task revisions',()=>{
  const clock=new ChatSnapshotClock('epoch');
  const first=clock.snapshot({...snapshot(99),nativeRun:{sessionId:'session',conversationId:'conversation',runId:'run-2',requestId:'request',workerGeneration:2}});
  assert.deepEqual(first.version,{hostEpoch:'epoch',revision:1,eventSequence:0,conversationId:'conversation',runId:'run-2',workerGeneration:2});
  assert.deepEqual(clock.changed('session','conversation'),{hostEpoch:'epoch',revision:2,eventSequence:1,conversationId:'conversation'});
  assert.deepEqual(clock.snapshot(snapshot(99),'conversation').version,{hostEpoch:'epoch',revision:3,eventSequence:1,conversationId:'conversation'});
  assert.equal(clock.changed('other').revision,1);
  assert.notEqual(new ChatSnapshotClock().hostEpoch,new ChatSnapshotClock().hostEpoch);
});

test('an event during an in-flight snapshot rejects the old state and coalesces concurrent reads',async()=>{
  const first=deferred<ChatSnapshot>(),second=deferred<ChatSnapshot>();let calls=0;
  const f=fixture(()=>++calls===1?first.promise:second.promise);
  const loading=f.sync.refresh();
  assert.equal(f.sync.notify(version(4)),true);
  assert.equal(f.sync.refresh(),loading);
  assert.equal(f.sync.refresh(),loading);
  first.resolve(snapshot(2,'completed'));
  await Promise.resolve();
  assert.equal(calls,2);assert.equal(f.applied.length,0);
  second.resolve(snapshot(5,'waiting_approval'));
  await loading;
  assert.equal(f.applied.length,1);assert.equal(f.sync.snapshot?.taskState,'waiting_approval');f.sync.dispose();
});

test('duplicate/old notifications do not fetch, while a sequence gap recovers the full state',async()=>{
  let reads=0;const f=fixture(async()=>snapshot(++reads===1?4:10));
  await f.sync.refresh();
  assert.equal(f.sync.notify(version(4)),false);assert.equal(f.sync.notify(version(2)),false);
  assert.equal(f.sync.notify(version(9)),true);await f.sync.refresh();
  assert.equal(reads,2);assert.equal(f.sync.snapshot?.version?.eventSequence,10);f.sync.dispose();
});

test('worker generation regression never overwrites a newer run, even with a newer transport revision',async()=>{
  let reads=0;const f=fixture(async()=>({...snapshot(++reads),version:{...version(reads),runId:reads===1?'new':'old',workerGeneration:reads===1?4:3}}));
  await f.sync.refresh();await f.sync.refresh();
  assert.equal(f.sync.snapshot?.version?.runId,'new');assert.equal(f.applied.length,1);
  assert.match(f.states.at(-1)?.error??'',/状态仍在变化/);f.sync.dispose();
});

test('host restart notification retires old replies and old notifications before the new snapshot arrives',async()=>{
  const old=deferred<ChatSnapshot>();let reads=0;
  const f=fixture(()=>++reads===1?Promise.resolve(snapshot(20)):reads===2?old.promise:Promise.resolve(snapshot(2,'waiting_input','host-b')));
  await f.sync.refresh();const pending=f.sync.refresh();
  assert.equal(f.sync.notify(version(1,1,'host-b')),true);
  assert.equal(f.sync.notify(version(30,30,'host-a')),false);
  old.resolve(snapshot(21,'completed'));await pending;
  assert.equal(f.applied.length,2);assert.equal(f.sync.snapshot?.version?.hostEpoch,'host-b');
  assert.equal(f.sync.snapshot?.taskState,'waiting_input');f.sync.dispose();
});

test('visibility/manual refresh discovers a new host epoch even when all its notifications were lost',async()=>{
  let reads=0;const f=fixture(async()=>++reads===1?snapshot(90):snapshot(1,'completed','host-b'));
  await f.sync.refresh();await f.sync.refresh();
  assert.equal(f.sync.snapshot?.version?.hostEpoch,'host-b');assert.equal(f.sync.snapshot?.taskState,'completed');
  assert.equal(f.sync.notify(version(100,100,'host-a')),false);f.sync.dispose();
});

test('a fresh request discovers another restart after an earlier host notice without waiting for another event',async()=>{
  let reads=0;const f=fixture(async()=>++reads===1?snapshot(40):snapshot(1,'waiting_approval','host-c'));
  await f.sync.refresh();f.sync.notify(version(1,1,'host-b'));await f.sync.refresh();
  assert.equal(f.sync.snapshot?.version?.hostEpoch,'host-c');
  assert.equal(f.sync.notify(version(9,9,'host-b')),false);f.sync.dispose();
});

test('a lost final event is repaired by an explicit/watchdog refresh without a later event',async()=>{
  let reads=0;const f=fixture(async()=>snapshot(++reads,reads===1?'thinking':'completed'));
  await f.sync.refresh();await f.sync.refresh();assert.equal(f.sync.snapshot?.taskState,'completed');f.sync.dispose();
});

test('unmount/session switch suppresses old replies and allows an independent new reader',async()=>{
  const old=deferred<ChatSnapshot>();const f=fixture(()=>old.promise);
  const pending=f.sync.refresh();f.sync.dispose();
  const current=fixture(async()=>snapshot(2,'waiting_input'));await current.sync.refresh();
  old.resolve(snapshot(100,'completed'));await pending;
  assert.equal(f.applied.length,0);assert.equal(current.sync.snapshot?.taskState,'waiting_input');current.sync.dispose();
});

test('read failures preserve old records with unknown status, pause automatic retries, and clear after explicit recovery',async()=>{
  let reads=0;const f=fixture(async()=>{reads++;if(reads===2||reads===3)throw new Error('storage unavailable');return snapshot(reads,'completed');});
  await f.sync.refresh();await f.sync.refresh();assert.equal(f.sync.canAutoRefresh,true);
  await f.sync.refresh();assert.equal(f.sync.canAutoRefresh,false);
  assert.equal(f.sync.snapshot?.version?.revision,1);assert.equal(f.states.at(-1)?.error,'storage unavailable');
  await f.sync.refresh();assert.equal(f.sync.canAutoRefresh,true);assert.equal(f.sync.error,undefined);
  assert.equal(f.states.at(-1)?.failures,0);assert.equal(f.sync.snapshot?.version?.revision,4);f.sync.dispose();
});

test('wrong-session snapshots cannot reconcile pending approvals or clear an existing failure',async()=>{
  const f=fixture(async()=>({...snapshot(1),sessionId:'other'}));await f.sync.refresh();
  assert.equal(f.applied.length,0);assert.match(f.states.at(-1)?.error??'',/其他会话/);f.sync.dispose();
});

test('legacy Claude snapshots remain supported until the host provides a version',async()=>{
  const f=fixture(async()=>({sessionId:'session',taskState:'idle',messages:[],pending:[]}));
  await f.sync.refresh();assert.equal(f.sync.snapshot?.taskState,'idle');f.sync.dispose();
});
