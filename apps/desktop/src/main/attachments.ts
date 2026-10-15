import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Attachment } from '../shared/types';
import { NATIVE_IMAGE_MAX_COUNT, NATIVE_IMAGE_MAX_BYTES, type NativePastedImage } from '../shared/native-images';

export const MAX_ATTACHMENT_COUNT = 8;
export const MAX_FILE = 8 * 1024 * 1024;
export const MAX_TOTAL = 16 * 1024 * 1024;
export const EXTENSIONS = new Set(['.png','.jpg','.jpeg','.gif','.webp','.pdf','.txt','.md','.json','.csv','.ts','.tsx','.js','.py','.yaml','.yml','.html','.css','.xml','.log']);
const stagedName = /^\.staged-[0-9a-f-]{36}\.[a-z]+$/;
const manifestSchema = z.object({ version:z.literal(1), items:z.array(z.object({
  file:z.string().regex(stagedName), name:z.string().max(1024), bytes:z.number().int().min(0).max(MAX_FILE), retained:z.boolean(), draft:z.boolean().default(true)
})).max(10000) });
type Item = z.infer<typeof manifestSchema>['items'][number];

/** 解析共享暂存格式，不加载、收集或修改草稿。 */
export function parseStagedAttachmentManifest(value:unknown):ReadonlyArray<Item> {
  return manifestSchema.parse(value).items;
}

/** 仅允许发送私有清单中记录的、显式导入的字节。 */
export class Attachments {
  private entries = new Map<string, Item[]>();
  private operations = new Map<string, Promise<unknown>>();
  constructor(private directory: string) {}
  private folder(id:string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('无效会话。');
    return path.join(this.directory,'attachments',id);
  }
  private async serial<T>(id:string, action:()=>Promise<T>):Promise<T> {
    const previous=this.operations.get(id) ?? Promise.resolve();
    const current=previous.catch(()=>{}).then(action); this.operations.set(id,current);
    try { return await current; } finally { if(this.operations.get(id)===current)this.operations.delete(id); }
  }
  private async load(id:string):Promise<Item[]> {
    if(this.entries.has(id))return this.entries.get(id)!;
    const folder=this.folder(id); let items:Item[]=[];
    try {
      const manifest=path.join(folder,'attachments.json');
      if((await fs.stat(manifest)).size>8*1024*1024)throw new Error('附件清单过大。');
      items=manifestSchema.parse(JSON.parse(await fs.readFile(manifest,'utf8'))).items;
    } catch(error) {
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('附件清单无法读取，原文件已保留。');
    }
    const retained=new Set(items.map(item=>item.file));
    // 旧版 UUID 文件可能仍被对话记录引用；仅回收本应用的暂存命名空间。
    for(const name of await fs.readdir(folder).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return [];throw error;})) {
      if(stagedName.test(name)&&!retained.has(name))await fs.rm(path.join(folder,name),{force:true});
    }
    this.entries.set(id,items); return items;
  }
  private async save(id:string, items:Item[]) {
    const data=manifestSchema.parse({version:1,items}); const folder=this.folder(id);
    await fs.mkdir(folder,{recursive:true,mode:0o700});
    const temporary=path.join(folder,'attachments.json.tmp');
    const handle=await fs.open(temporary,'w',0o600);
    try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary,path.join(folder,'attachments.json'));
    this.entries.set(id,data.items);
  }
  private attachment(id:string,item:Item):Attachment {return {path:path.join(this.folder(id),item.file),name:item.name,bytes:item.bytes};}
  list(id:string):Promise<Attachment[]> {return this.serial(id,async()=> (await this.load(id)).filter(item=>item.draft).map(item=>this.attachment(id,item)));}
  add(id:string,selected:string[]):Promise<Attachment[]> {return this.addFiles(id,selected);}
  /** Native 暂存与草稿校验原子执行；Claude 保留现有限制。 */
  addNative(id:string,selected:string[]):Promise<Attachment[]> {return this.addFiles(id,selected,true);}
  /** 原子暂存一次显式粘贴，保留所有现有草稿和已发送文件的所有权。 */
  addNativePastedImages(id:string,images:NativePastedImage[],checkAdmission?:()=>void):Promise<Attachment[]> {
    return this.serial(id,async()=>{
      checkAdmission?.();
      const {decodeNativePastedImages,readNativeImageAttachments}=await import('./native-image-attachments');
      checkAdmission?.();
      const decoded=decodeNativePastedImages(images),items=await this.load(id),drafts=items.filter(item=>item.draft);
      checkAdmission?.();
      if(drafts.length+decoded.length>NATIVE_IMAGE_MAX_COUNT)throw new Error('Native 图片附件最多 4 张，请先移除草稿中的图片。');
      if(drafts.reduce((total,item)=>total+item.bytes,0)+decoded.reduce((total,image)=>total+image.bytes.length,0)>NATIVE_IMAGE_MAX_BYTES)throw new Error('Native 图片附件合计不能超过 1 MiB。');
      const folder=this.folder(id),added:Item[]=[];let saved=false;
      await fs.mkdir(folder,{recursive:true,mode:0o700});
      try {
        for(const image of decoded) {
          checkAdmission?.();
          const identifier=randomUUID(),ext=image.mimeType==='image/png'?'.png':'.jpg';
          const item:Item={file:`.staged-${identifier}${ext}`,name:`粘贴图片-${identifier}${ext}`,bytes:image.bytes.length,retained:false,draft:true};
          const handle=await fs.open(path.join(folder,item.file),'wx',0o600);
          added.push(item);
          try {await handle.writeFile(image.bytes);await handle.sync();} finally {await handle.close();}
        }
        checkAdmission?.();
        await this.save(id,[...items,...added]);saved=true;
        checkAdmission?.();
        await readNativeImageAttachments(this.directory,id,[...drafts,...added].map(item=>this.attachment(id,item).path));
        checkAdmission?.();
        return added.map(item=>this.attachment(id,item));
      } catch(error) {
        // 若恢复失败，保留字节，避免留下引用缺失的清单。
        if(saved)await this.save(id,items);
        await Promise.all(added.map(item=>fs.rm(path.join(folder,item.file),{force:true})));
        throw error;
      }
    });
  }
  private async addFiles(id: string, selected: string[], native=false): Promise<Attachment[]> {
    return this.serial(id,async()=>{
      if (selected.length > MAX_ATTACHMENT_COUNT) throw new Error('一次最多选择 8 个附件。');
      const items=await this.load(id); const added:Item[]=[];
      const folder=this.folder(id); await fs.mkdir(folder,{recursive:true,mode:0o700});
      let total=0,saved=false;
      try {
        for(const file of selected) {
          const source=await fs.realpath(file), stat=await fs.stat(source), ext=path.extname(source).toLowerCase();
          if(!stat.isFile())throw new Error('附件必须是文件，暂不支持添加文件夹。');
          if(!EXTENSIONS.has(ext))throw new Error('附件类型不受支持，请选择文本、图片或 PDF。');
          if(stat.size>MAX_FILE)throw new Error('单个附件不能超过 8 MiB。');
          total+=stat.size; if(total>MAX_TOTAL)throw new Error('附件合计不能超过 16 MiB。');
          const item:Item={file:'.staged-'+randomUUID()+ext,name:path.basename(file),bytes:stat.size,retained:false,draft:true};
          added.push(item);
          const target=path.join(folder,item.file); await fs.copyFile(source,target);await fs.chmod(target,0o600);
          const copied=await fs.stat(target);
          if(copied.size!==stat.size)throw new Error('附件在选择期间已变更，请重新选择。');
        }
        if(added.length) {await this.save(id,[...items,...added]);saved=true;}
        if(native) {
          const {readNativeImageAttachments}=await import('./native-image-attachments');
          await readNativeImageAttachments(this.directory,id,[...items,...added].filter(item=>item.draft).map(item=>this.attachment(id,item).path));
        }
        return added.map(item=>this.attachment(id,item));
      } catch(error) {
        // 删除本次调用新增的文件前，先恢复原有草稿清单。
        // 若恢复失败，谨慎保留字节，以便后续恢复。
        if(native&&saved)await this.save(id,items);
        await Promise.all(added.map(item=>fs.rm(path.join(folder,item.file),{force:true})));throw error;
      }
    });
  }
  private async validateFiles(id:string,files:string[]):Promise<string[]> {
    if(files.length>MAX_ATTACHMENT_COUNT)throw new Error('最多发送 8 个附件。');
    const items=await this.load(id); let size=0;
    for(const file of files) {
      const item=items.find(item=>path.join(this.folder(id),item.file)===file);
      if(!item)throw new Error('附件不属于当前会话，请重新选择。');
      const stat=await fs.lstat(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_FILE||stat.size!==item.bytes)throw new Error('附件已变更，请重新选择。');
      size+=stat.size;
    }
    if(size>MAX_TOTAL)throw new Error('附件合计不能超过 16 MiB。');
    return files;
  }
  validate(id:string,files:string[]=[]):Promise<string[]> {return this.serial(id,()=>this.validateFiles(id,files));}
  /** 发送前提交引用。派发失败时谨慎保留文件。 */
  retain(id:string,files:string[]):Promise<void> {return this.serial(id,async()=>{
    if(!files.length)return;
    await this.validateFiles(id,files);const wanted=new Set(files);
    await this.save(id,(await this.load(id)).map(item=>wanted.has(path.join(this.folder(id),item.file))?{...item,retained:true}:item));
  });}
  markSent(id:string,files:string[]):Promise<void> {return this.serial(id,async()=>{
    if(!files.length)return;const wanted=new Set(files);
    await this.save(id,(await this.load(id)).map(item=>wanted.has(path.join(this.folder(id),item.file))?{...item,retained:true,draft:false}:item));
  });}
  /** 返回确认前，将选择器草稿转交给持久化提交记录持有。 */
  acceptQueued(id:string,files:string[],commit:(names:string[])=>void):Promise<void> {return this.serial(id,async()=>{
    await this.validateFiles(id,files);
    const previous=await this.load(id),wanted=new Set(files);
    if(files.some(file=>!previous.some(item=>item.draft&&path.join(this.folder(id),item.file)===file)))throw new Error('附件已发送或不在当前草稿中，请重新添加附件。');
    // 在队列所有权持久化之前保持草稿可见。这些提交之间发生崩溃时，
    // 可能留下额外的草稿标记，但不会隐藏尚未接收的附件。
    if(files.length)await this.save(id,previous.map(item=>wanted.has(path.join(this.folder(id),item.file))?{...item,retained:true}:item));
    commit(files.map(file=>previous.find(item=>path.join(this.folder(id),item.file)===file)!.name));
    if(files.length) {
      try { await this.save(id,(await this.load(id)).map(item=>wanted.has(path.join(this.folder(id),item.file))?{...item,draft:false}:item)); }
      catch { /* 文件已归队列持有。IPC 会过滤这些文件；派发时会先重试持久化标记，再发送。 */ }
    }
  });}
  removeFile(id:string,file:string):Promise<void> {return this.serial(id,async()=>{
    const items=await this.load(id),item=items.find(item=>path.join(this.folder(id),item.file)===file);
    if(!item)throw new Error('附件不属于当前会话。');
    if(item.retained) {await this.save(id,items.map(value=>value===item?{...value,draft:false}:value));return;}
    await this.save(id,items.filter(value=>value!==item));
    await fs.rm(file,{force:true});
  });}
  remove(id:string):Promise<void> {return this.serial(id,async()=>{await fs.rm(this.folder(id),{recursive:true,force:true});this.entries.delete(id);});}
}
