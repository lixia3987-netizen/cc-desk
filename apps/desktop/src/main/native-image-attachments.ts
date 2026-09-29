import fs from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { UserImage } from '@cc-desk/agent-core';
import { isNativeImageAttachments, type NativeImageAttachment } from '@cc-desk/contracts/chat';
import { parseStagedAttachmentManifest } from './attachments';
import type { NativeImagePreview } from '../shared/native-images';

export const NATIVE_IMAGE_MAX_COUNT = 4;
export const NATIVE_IMAGE_MAX_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_EDGE = 4096;
const MAX_PIXELS = 16 * 1024 * 1024;
const invalid = () => new Error('Native 图片附件无效或已变更，请重新选择 PNG/JPEG 图片。');
const changed = () => new Error('Native 图片附件或所属目录已变更，请重新选择。');
type DirectorySnapshot = { file:string; stat:BigIntStats };
type ImageMime = 'image/png' | 'image/jpeg';

function sameIdentity(a:BigIntStats,b:BigIntStats) {return a.dev===b.dev&&a.ino===b.ino;}
function sameFile(a:BigIntStats,b:BigIntStats) {
  return sameIdentity(a,b)&&a.mode===b.mode&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&b.nlink===1n&&b.isFile();
}
async function directoryChain(folder:string):Promise<DirectorySnapshot[]> {
  const absolute=path.resolve(folder), root=path.parse(absolute).root;
  let current=root;
  const result:DirectorySnapshot[]=[];
  for(const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current=path.join(current,component);
    const stat=await fs.lstat(current,{bigint:true});
    if(!stat.isDirectory()||stat.isSymbolicLink())throw changed();
    result.push({file:current,stat});
  }
  return result;
}
async function checkDirectories(directories:DirectorySnapshot[]) {
  for(const {file,stat} of directories) {
    const current=await fs.lstat(file,{bigint:true});
    if(!current.isDirectory()||current.isSymbolicLink()||!sameIdentity(stat,current))throw changed();
  }
}

/** Bounded descriptor read with pre/post path and identity checks; not an OS sandbox. */
async function readStable(file:string,maxBytes:number,directories:DirectorySnapshot[],expectedBytes?:number) {
  await checkDirectories(directories);
  const before=await fs.lstat(file,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>BigInt(maxBytes)||
    (expectedBytes!==undefined&&before.size!==BigInt(expectedBytes)))throw invalid();
  const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
  try {
    const opened=await handle.stat({bigint:true});
    if(!sameFile(before,opened))throw changed();
    const buffer=Buffer.alloc(Number(before.size)+1);
    let length=0;
    while(length<buffer.length) {
      const read=await handle.read(buffer,length,buffer.length-length,length);
      if(!read.bytesRead)break;
      length+=read.bytesRead;
    }
    if(length!==Number(before.size)||!sameFile(before,await handle.stat({bigint:true}))||
      !sameFile(before,await fs.lstat(file,{bigint:true})))throw changed();
    await checkDirectories(directories);
    return buffer.subarray(0,length);
  } finally {await handle.close();}
}

function dimensions(width:number,height:number) {
  if(width<1||height<1||width>MAX_EDGE||height>MAX_EDGE||width*height>MAX_PIXELS)throw invalid();
}

const pngSignature=Buffer.from([137,80,78,71,13,10,26,10]);
const crcTable=Array.from({length:256},(_,value)=>{
  let crc=value;for(let bit=0;bit<8;bit++)crc=(crc&1)?0xedb88320^(crc>>>1):crc>>>1;return crc>>>0;
});
function pngCRC(bytes:Buffer) {
  let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;
}
function validatePNG(bytes:Buffer) {
  if(bytes.length<57||!bytes.subarray(0,8).equals(pngSignature))throw invalid();
  let offset=8,header=false,data=false,end=false;
  while(offset+12<=bytes.length) {
    const length=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8);
    if(length>bytes.length-offset-12)throw invalid();
    const payload=bytes.subarray(offset+8,offset+8+length);
    if(pngCRC(bytes.subarray(offset+4,offset+8+length))!==bytes.readUInt32BE(offset+8+length))throw invalid();
    if(!header&&type!=='IHDR')throw invalid();
    if(type==='IHDR') {
      if(header||length!==13)throw invalid();
      dimensions(payload.readUInt32BE(0),payload.readUInt32BE(4));
      const depths:Record<number,number[]>={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
      if(!depths[payload[9]]?.includes(payload[8])||payload[10]!==0||payload[11]!==0||payload[12]>1)throw invalid();
      header=true;
    } else if(type==='IDAT') {if(length)data=true;}
    else if(type==='IEND') {
      if(length!==0||!data||offset+12!==bytes.length)throw invalid();
      end=true;break;
    }
    offset+=12+length;
  }
  if(!header||!data||!end)throw invalid();
}
function validateJPEG(bytes:Buffer) {
  if(bytes.length<20||bytes[0]!==0xff||bytes[1]!==0xd8)throw invalid();
  let offset=2,frame=false,scan=false;
  const frames=new Set([0xc0,0xc1,0xc2]);
  while(offset<bytes.length) {
    if(bytes[offset++]!==0xff)throw invalid();
    while(bytes[offset]===0xff)offset++;
    const marker=bytes[offset++];
    if(marker===0xd9) {if(!frame||!scan||offset!==bytes.length)throw invalid();return;}
    if(marker===undefined||marker===0||marker===0xd8||marker===0x01||(marker>=0xd0&&marker<=0xd7)||offset+2>bytes.length)throw invalid();
    const length=bytes.readUInt16BE(offset);
    if(length<2||offset+length>bytes.length)throw invalid();
    if(frames.has(marker)) {
      if(frame||length<11||bytes[offset+2]!==8)throw invalid();
      dimensions(bytes.readUInt16BE(offset+5),bytes.readUInt16BE(offset+3));
      const channels=bytes[offset+7];
      if(![1,3,4].includes(channels)||length!==8+3*channels)throw invalid();
      frame=true;
    } else if(marker===0xda) {
      if(!frame||length<8||length!==6+2*bytes[offset+2])throw invalid();
      scan=true;
    } else if(marker>=0xc0&&marker<=0xcf&&![0xc4,0xc8,0xcc].includes(marker))throw invalid();
    offset+=length;
    if(marker===0xda) {
      const start=offset;
      while(offset<bytes.length) {
        if(bytes[offset]!==0xff) {offset++;continue;}
        if(bytes[offset+1]===0||bytes[offset+1]>=0xd0&&bytes[offset+1]<=0xd7) {offset+=2;continue;}
        break;
      }
      if(offset===start)throw invalid();
    }
  }
  throw invalid();
}

/** Header/chunk validation without decompressing untrusted image pixels. */
function validateImage(bytes:Buffer,mimeType:ImageMime) {
  if(!bytes.length||bytes.length>NATIVE_IMAGE_MAX_BYTES)throw invalid();
  if(mimeType==='image/png')validatePNG(bytes);else validateJPEG(bytes);
}

/** Verify a transported immutable snapshot without reopening user-controlled paths. */
export function verifyNativeImageAttachments(images:unknown,metadata:unknown):void {
  if(!Array.isArray(images)||!Array.isArray(metadata)||images.length!==metadata.length||images.length>NATIVE_IMAGE_MAX_COUNT||
    (metadata.length>0&&!isNativeImageAttachments(metadata)))throw invalid();
  let total=0;
  for(let index=0;index<images.length;index++) {
    const image=images[index],item=metadata[index];
    if(!image||!item||!['image/png','image/jpeg'].includes(image.mimeType)||image.mimeType!==item.mimeType||
      typeof item.name!=='string'||item.name.length>1024||!Number.isSafeInteger(item.bytes)||item.bytes<1||item.bytes>NATIVE_IMAGE_MAX_BYTES||
      typeof item.sha256!=='string'||!/^[0-9a-f]{64}$/.test(item.sha256)||typeof image.dataUrl!=='string')throw invalid();
    const prefix=`data:${image.mimeType};base64,`;
    if(!image.dataUrl.startsWith(prefix)||image.dataUrl.length>prefix.length+4*Math.ceil(NATIVE_IMAGE_MAX_BYTES/3))throw invalid();
    const encoded=image.dataUrl.slice(prefix.length),bytes=Buffer.from(encoded,'base64');
    if(bytes.toString('base64')!==encoded||bytes.length!==item.bytes||createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw invalid();
    total+=bytes.length;if(total>NATIVE_IMAGE_MAX_BYTES)throw invalid();
    validateImage(bytes,image.mimeType);
  }
}

/** Read only the current session's private staged manifest. No draft collection or writes. */
export async function readNativeImageAttachments(directory:string,sessionId:string,paths:string[]):Promise<{images:UserImage[];metadata:NativeImageAttachment[]}> {
  return readNativeImages(directory,sessionId,paths,false);
}

/** One explicitly selected draft, using the same manifest capture as the image bytes. */
export async function readNativeDraftImage(directory:string,sessionId:string,file:string):Promise<NativeImagePreview> {
  try {
    const {images,metadata}=await readNativeImages(directory,sessionId,[file],true);
    return {image:metadata[0],dataUrl:images[0].dataUrl};
  } catch {
    throw new Error('Native 图片预览不可用，附件已移除、已发送或发生变更，请重新选择。');
  }
}

async function readNativeImages(directory:string,sessionId:string,paths:string[],draftOnly:boolean):Promise<{images:UserImage[];metadata:NativeImageAttachment[]}> {
  if(!/^[a-zA-Z0-9_-]+$/.test(sessionId)||!Array.isArray(paths)||paths.length>NATIVE_IMAGE_MAX_COUNT||new Set(paths).size!==paths.length)throw invalid();
  if(!paths.length)return {images:[],metadata:[]};
  try {
    const folder=path.join(directory,'attachments',sessionId),directories=await directoryChain(folder);
    const manifest=await readStable(path.join(folder,'attachments.json'),MAX_MANIFEST_BYTES,directories);
    const items=parseStagedAttachmentManifest(JSON.parse(manifest.toString('utf8')));
    if(new Set(items.map(item=>item.file)).size!==items.length)throw invalid();
    const images:UserImage[]=[],metadata:NativeImageAttachment[]=[];
    let total=0;
    for(const file of paths) {
      const item=items.find(item=>path.join(folder,item.file)===file);
      if(!item)throw new Error('Native 图片附件不属于当前会话，请重新选择。');
      if(draftOnly&&!item.draft)throw invalid();
      const ext=path.extname(item.file).toLowerCase(),nameExt=path.extname(item.name).toLowerCase();
      const mimeType:ImageMime=ext==='.png'?'image/png':'image/jpeg';
      if(!['.png','.jpg','.jpeg'].includes(ext)||!['.png','.jpg','.jpeg'].includes(nameExt)||
        (nameExt==='.png')!==(ext==='.png'))throw invalid();
      total+=item.bytes;if(item.bytes<1||item.bytes>NATIVE_IMAGE_MAX_BYTES||total>NATIVE_IMAGE_MAX_BYTES)throw invalid();
      const bytes=await readStable(file,NATIVE_IMAGE_MAX_BYTES,directories,item.bytes);
      validateImage(bytes,mimeType);
      images.push({mimeType,dataUrl:`data:${mimeType};base64,${bytes.toString('base64')}`});
      metadata.push({name:item.name,mimeType,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
    }
    await checkDirectories(directories);
    // A manifest rewrite/revocation during capture invalidates this snapshot.
    if(!(await readStable(path.join(folder,'attachments.json'),MAX_MANIFEST_BYTES,directories)).equals(manifest))throw changed();
    verifyNativeImageAttachments(images,metadata);
    return {images,metadata};
  } catch(error) {
    if(error instanceof Error&&error.message.startsWith('Native 图片附件'))throw error;
    throw invalid();
  }
}
