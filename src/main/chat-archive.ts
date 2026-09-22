import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { ChatMessage, ChatPage, ChatPageOptions, ChatSearchPage, ChatSnapshot } from '../shared/chat';
import { isMessage, ResultEchoRecovery } from './chat-history';

const RECORD_BYTES=32*1024*1024, TEXT_LIMIT=32*1024*1024, PAGE_BYTES=1024*1024, PREVIEW=16*1024, PAGE_SIZE=50;
interface Location { start:number; end:number }
interface Index {
  identity:string; size:number; modified:number; cursor:number; records:Map<string,Location>; idsBytes:number;
  incomplete:boolean; migration:ResultEchoRecovery;
}
interface RecordLine { start:number; end:number; value?:Record<string,unknown> }

/** Byte offsets, never the full transcript, are cached. Incomplete tails are retried on the next read. */
async function* lines(file:FileHandle,start:number,end:number):AsyncGenerator<RecordLine> {
  const buffer=Buffer.alloc(64*1024);let position=start,lineStart=start,parts:Buffer[]=[],length=0;
  while(position<end){
    const {bytesRead}=await file.read(buffer,0,Math.min(buffer.length,end-position),position);if(!bytesRead)break;
    let offset=0;
    while(offset<bytesRead){
      const newline=buffer.indexOf(10,offset),stop=newline>=0&&newline<bytesRead?newline:bytesRead;
      length+=stop-offset;
      if(length<=RECORD_BYTES&&stop>offset)parts.push(Buffer.from(buffer.subarray(offset,stop)));else if(length>RECORD_BYTES)parts=[];
      if(stop===bytesRead)break;
      let value:Record<string,unknown>|undefined;
      if(length&&length<=RECORD_BYTES){try{const parsed:unknown=JSON.parse(Buffer.concat(parts,length).toString('utf8'));if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))value=parsed as Record<string,unknown>;}catch{/* Mark damaged records as incomplete; preserve the journal. */}}
      yield {start:lineStart,end:position+stop+1,value};
      lineStart=position+stop+1;parts=[];length=0;offset=stop+1;
    }
    position+=bytesRead;
  }
}
const excerpt=(text:string,query:string,limit:number)=>{
  const found=query?text.toLowerCase().indexOf(query.toLowerCase()):-1;
  const start=found>=0?Math.max(0,found-Math.floor(limit/4)):Math.max(0,text.length-limit);
  return (start?'…':'')+text.slice(start,start+limit)+(start+limit<text.length?'…':'');
};
const preview=(message:ChatMessage,query=''):ChatMessage=>{
  const result={...message};
  if(result.text.length>PREVIEW){result.text=excerpt(result.text,query,PREVIEW);result.truncated=true;}
  if(result.input){const input=JSON.stringify(result.input);if(input.length>PREVIEW){result.input={preview:excerpt(input,query,PREVIEW),truncated:true};result.truncated=true;}}
  return result;
};

/** On-demand archive browsing. Only two sessions' bounded offset indexes remain resident. */
export class ChatArchive {
  private indexes=new Map<string,Index>();
  private serial=new Map<string,Promise<unknown>>();
  constructor(private directory:string){}
  forget(id:string){this.indexes.delete(id);}
  private async withArchive<T>(id:string,snapshot:ChatSnapshot,action:(file:FileHandle|undefined,index:Index,ids:string[],fallback:Map<string,ChatMessage>)=>Promise<T>):Promise<T>{
    if(!/^[a-z0-9-]{1,100}$/i.test(id))throw new Error('无效会话 ID。');
    // Serializing per session prevents an older scan from replacing a newer index.
    const previous=this.serial.get(id)??Promise.resolve();
    const operation=previous.catch(()=>{}).then(async()=>{
      let file:FileHandle|undefined;
      try{file=await fs.open(path.join(this.directory,id+'.jsonl'),'r');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      try{
        const stat=await file?.stat();const identity=stat?`${stat.dev}:${stat.ino}`:'none';
        let index=this.indexes.get(id);
        if(!index||index.identity!==identity||stat&& (stat.size<index.size||stat.size===index.size&&stat.mtimeMs!==index.modified)){
          index={identity,size:0,modified:0,cursor:0,records:new Map(),idsBytes:0,incomplete:false,migration:new ResultEchoRecovery(new Set(snapshot.messages.map(m=>m.id)))};
        }
        if(file&&stat){
          for await(const line of lines(file,index.cursor,stat.size)){
            const event=line.value;
            if(!event){index.incomplete=true;index.migration.invalidate();}
            else if(!index.migration.skip(event)){
              if(event.type==='message'&&isMessage(event.message)){
                const message=event.message;
                if(!index.records.has(message.id)){
                  index.idsBytes+=Buffer.byteLength(message.id);
                  if(index.records.size>=100000||index.idsBytes>16*1024*1024)throw new Error('此会话超出本地检索上限（100,000 条消息或 16 MiB 消息标识），请导出完整记录查看。');
                }
                index.records.set(message.id,{start:line.start,end:line.end});
              }else if(event.type==='text_delta'&&typeof event.id==='string'){
                const old=index.records.get(event.id);if(old)index.records.set(event.id,{...old,end:line.end});
              }
            }
            index.cursor=line.end;
          }
          index.size=stat.size;index.modified=stat.mtimeMs;
        }
        this.indexes.delete(id);this.indexes.set(id,index);
        while(this.indexes.size>2)this.indexes.delete(this.indexes.keys().next().value!);
        const fallback=new Map(snapshot.messages.filter(m=>!index!.records.has(m.id)&&!index!.migration.removed.has(m.id)).map(m=>[m.id,m]));
        const ids=[...fallback.keys(),...index.records.keys()];
        return await action(file,index,ids,fallback);
      }finally{await file?.close();}
    });
    this.serial.set(id,operation);
    try{return await operation;}finally{if(this.serial.get(id)===operation)this.serial.delete(id);}
  }
  private async message(file:FileHandle|undefined,index:Index,id:string,fallback:Map<string,ChatMessage>):Promise<ChatMessage>{
    const location=index.records.get(id);if(!location||!file)return {...fallback.get(id)!};
    let message:ChatMessage|undefined;
    for await(const {value} of lines(file,location.start,location.end)){
      if(value?.type==='message'&&isMessage(value.message)&&value.message.id===id)message={...value.message};
      else if(value?.type==='text_delta'&&value.id===id&&typeof value.text==='string'&&message){
        message.text+=value.text;
        if(message.text.length>TEXT_LIMIT){message.text=message.text.slice(-TEXT_LIMIT);message.truncated=true;}
      }
    }
    if(!message)throw new Error('会话记录在读取时发生变化，请重新查找。');
    return message;
  }
  private incomplete(index:Index,snapshot:ChatSnapshot){return index.incomplete||index.cursor<index.size||!!snapshot.sourceIncomplete||!!snapshot.truncated&&(!index.records.size||snapshot.messages.some(m=>m.turnId==='imported'));}
  async page(id:string,snapshot:ChatSnapshot,options:ChatPageOptions={}):Promise<ChatPage>{
    return this.withArchive(id,snapshot,async(file,index,ids,fallback)=>{
      const anchor=options.before??options.after??options.around;
      const at=anchor===undefined?-1:ids.indexOf(anchor);
      if(anchor!==undefined&&at<0)throw new Error('找不到这条历史消息，请重新查找。');
      let start=options.before?Math.max(0,at-PAGE_SIZE):options.after?at+1:options.around?Math.max(0,at-Math.floor(PAGE_SIZE/2)):Math.max(0,ids.length-PAGE_SIZE);
      const end=options.before?at:Math.min(ids.length,start+PAGE_SIZE);
      const messages:ChatMessage[]=[];let bytes=0;
      for(let i=start;i<end;i++){
        const message=preview(await this.message(file,index,ids[i],fallback),options.query);
        // Each preview is bounded, including input. The page has a separate IPC byte budget.
        const size=Buffer.byteLength(JSON.stringify(message));
        if(bytes+size>PAGE_BYTES&&messages.length){
          if(options.around&&i<=at||options.before){while(messages.length&&bytes+size>PAGE_BYTES){bytes-=Buffer.byteLength(JSON.stringify(messages.shift()!));start++;}}
          else break;
        }
        messages.push(message);bytes+=size;
      }
      return {messages,before:start>0&&messages.length?messages[0].id:null,after:start+messages.length<ids.length&&messages.length?messages.at(-1)!.id:null,incomplete:this.incomplete(index,snapshot)};
    });
  }
  async search(id:string,snapshot:ChatSnapshot,query:string,before?:string):Promise<ChatSearchPage>{
    const needle=query.trim().toLowerCase();if(!needle)return {hits:[],nextBefore:null,incomplete:false};
    return this.withArchive(id,snapshot,async(file,index,ids,fallback)=>{
      const cursor=before===undefined?ids.length:ids.indexOf(before);
      if(cursor<0)throw new Error('搜索位置已失效，请重新查找。');
      const hits:ChatSearchPage['hits']=[];let position=cursor-1,incomplete=this.incomplete(index,snapshot);
      for(;position>=0;position--){
        const message=await this.message(file,index,ids[position],fallback);
        incomplete ||= !!message.truncated;
        const text=[message.text,message.toolName??'',message.input?JSON.stringify(message.input):''].join('\n');
        if(text.toLowerCase().includes(needle))hits.push({id:message.id,role:message.role,toolName:message.toolName,createdAt:message.createdAt,excerpt:excerpt(text,needle,Math.max(240,needle.length+60))});
        // Limit scan work as well as results. The continuation is explicit even when this segment has no matches.
        if(hits.length>=50||cursor-position>=1000)break;
      }
      return {hits,nextBefore:position>0?ids[position]:null,incomplete};
    });
  }
}
