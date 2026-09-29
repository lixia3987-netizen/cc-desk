import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { Attachments } from '../src/main/attachments';
import { readNativeImageAttachments } from '../src/main/native-image-attachments';
import { NATIVE_IMAGE_MAX_BYTES, type NativePastedImage } from '../src/shared/native-images';

function chunk(type:string,data:Buffer) {
  const typeBytes=Buffer.from(type),buffer=Buffer.alloc(data.length+12);buffer.writeUInt32BE(data.length);typeBytes.copy(buffer,4);data.copy(buffer,8);
  let crc=0xffffffff;
  for(const byte of Buffer.concat([typeBytes,data])) {crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc&1)?0xedb88320^(crc>>>1):crc>>>1;}
  buffer.writeUInt32BE((crc^0xffffffff)>>>0,buffer.length-4);return buffer;
}
function png(width=1,height=1,padding=0) {
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),...(padding?[chunk('tEXt',Buffer.alloc(padding,97))]:[]),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0,255]))),chunk('IEND',Buffer.alloc(0))]);
}
const jpeg=Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z','base64');
function image(bytes=png(),mimeType:NativePastedImage['mimeType']='image/png'):NativePastedImage {return {mimeType,dataUrl:`data:${mimeType};base64,${bytes.toString('base64')}`};}
async function fixture(t:TestContext) {
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'native-pasted-images-')));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const manager=new Attachments(directory),folder=path.join(directory,'attachments','s'),manifest=path.join(folder,'attachments.json');
  const staged=async()=>(await fs.readdir(folder).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return [];throw error;})).filter(file=>file.startsWith('.staged-')).sort();
  return {directory,manager,folder,manifest,staged};
}
function deferred() {let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}

test('pasted PNG/JPEG bytes have host-owned names, private files and recoverable previews',async t=>{
  const f=await fixture(t),added=await f.manager.addNativePastedImages('s',[image(),image(jpeg,'image/jpeg')]);
  assert.equal(added.length,2);
  for(const [index,item] of added.entries()) {
    assert.match(item.name,/^粘贴图片-[0-9a-f-]{36}\.(png|jpg)$/);
    assert.equal(path.dirname(item.path),f.folder);assert.match(path.basename(item.path),/^\.staged-[0-9a-f-]{36}\.(png|jpg)$/);
    assert.deepEqual(await fs.readFile(item.path),index?jpeg:png());
    if(process.platform!=='win32')assert.equal((await fs.stat(item.path)).mode&0o777,0o600);
  }
  assert.deepEqual(await new Attachments(f.directory).list('s'),added);
  const snapshot=await readNativeImageAttachments(f.directory,'s',added.map(item=>item.path));
  assert.deepEqual(snapshot.images,[image(),image(jpeg,'image/jpeg')]);
});

test('paste rejects forged MIME, remote paths and noncanonical base64 before any write',async t=>{
  const f=await fixture(t),good=image();
  const invalid=[image(jpeg),image(png(),'image/jpeg'),{...good,mimeType:'image/gif'}, {...good,dataUrl:'https://example.test/image.png'}, {...good,dataUrl:'file:///private/image.png'}, {...good,dataUrl:good.dataUrl+'\n'}, {...good,dataUrl:good.dataUrl.replace('data:image/png','data:image/jpeg')}, {...good,dataUrl:good.dataUrl.replace(/=+$/,'')},image(Buffer.alloc(0))];
  for(const value of invalid)await assert.rejects(f.manager.addNativePastedImages('s',[value as NativePastedImage]),/Native 图片附件/);
  assert.deepEqual(await f.staged(),[]);await assert.rejects(fs.stat(f.manifest),{code:'ENOENT'});
});

test('paste uses existing chunk, dimensions and truncation validation',async t=>{
  const f=await fixture(t),badCRC=png();badCRC[badCRC.length-1]^=1;
  for(const value of [badCRC,png(4097),png(1,4097),png().subarray(0,35)])await assert.rejects(f.manager.addNativePastedImages('s',[image(value)]),/Native 图片附件/);
  await assert.rejects(f.manager.addNativePastedImages('s',[image(jpeg.subarray(0,-2),'image/jpeg')]),/Native 图片附件/);
  assert.deepEqual(await f.staged(),[]);
});

test('a malformed later image rejects the entire paste before writing earlier bytes',async t=>{
  const f=await fixture(t),[draft]=await f.manager.addNativePastedImages('s',[image()]),before=await fs.readFile(f.manifest);
  await assert.rejects(f.manager.addNativePastedImages('s',[image(),image(Buffer.from('invalid'))]),/Native 图片附件/);
  assert.deepEqual(await fs.readFile(f.manifest),before);assert.deepEqual(await f.staged(),[path.basename(draft.path)]);
});

test('paste rejects zero or over-four images and aggregate byte excess before writes',async t=>{
  const f=await fixture(t),large=png(1,1,600*1024);
  for(const images of [[],Array(5).fill(image()),[image(large),image(large)],[image(png(1,1,NATIVE_IMAGE_MAX_BYTES))]])await assert.rejects(f.manager.addNativePastedImages('s',images),/Native 图片附件/);
  assert.deepEqual(await f.staged(),[]);
});

test('paste accepts exact byte ceiling and includes existing drafts in subsequent byte checks',async t=>{
  const f=await fixture(t),exact=png(1,1,NATIVE_IMAGE_MAX_BYTES-png().length-12);
  const [draft]=await f.manager.addNativePastedImages('s',[image(exact)]),before=await fs.readFile(f.manifest);
  assert.equal(draft.bytes,NATIVE_IMAGE_MAX_BYTES);
  await assert.rejects(f.manager.addNativePastedImages('s',[image()]),/1 MiB/);
  assert.deepEqual(await fs.readFile(f.manifest),before);assert.deepEqual(await f.staged(),[path.basename(draft.path)]);
});

test('paste combines counts with picker drafts and preserves queued images outside the draft ceiling',async t=>{
  const f=await fixture(t),source=path.join(f.directory,'picked.png');await fs.writeFile(source,png());
  const [queued]=await f.manager.addNativePastedImages('s',[image(png(1,1,600*1024))]);
  await f.manager.acceptQueued('s',[queued.path],names=>assert.deepEqual(names,[queued.name]));
  const picked=await f.manager.addNative('s',[source,source,source]);
  const [pasted]=await f.manager.addNativePastedImages('s',[image(png(1,1,600*1024))]);
  await assert.rejects(f.manager.addNativePastedImages('s',[image()]),/4 张/);
  const restarted=new Attachments(f.directory);assert.deepEqual(await restarted.list('s'),[...picked,pasted]);
  await restarted.removeFile('s',queued.path);assert.deepEqual(await fs.readFile(queued.path),png(1,1,600*1024));
});

test('retained draft remains removable without deleting bytes and rejected imports preserve it',async t=>{
  const f=await fixture(t),[draft]=await f.manager.addNativePastedImages('s',[image()]);await f.manager.retain('s',[draft.path]);
  await assert.rejects(f.manager.addNativePastedImages('s',[image(Buffer.from('bad'))]),/Native 图片附件/);
  await f.manager.removeFile('s',draft.path);assert.deepEqual(await f.manager.list('s'),[]);assert.deepEqual(await fs.readFile(draft.path),png());
});

test('validation of an altered existing draft rolls back all new paste bytes and manifest',async t=>{
  const f=await fixture(t),[draft]=await f.manager.addNativePastedImages('s',[image()]),before=await fs.readFile(f.manifest);
  await fs.writeFile(draft.path,Buffer.alloc(png().length));
  await assert.rejects(f.manager.addNativePastedImages('s',[image()]),/Native 图片附件/);
  assert.deepEqual(await fs.readFile(f.manifest),before);assert.deepEqual(await f.staged(),[path.basename(draft.path)]);
});

test('second-file write failure removes only this paste batch and keeps prior manifest',async t=>{
  const f=await fixture(t),[draft]=await f.manager.addNativePastedImages('s',[image()]),before=await fs.readFile(f.manifest),open=fs.open.bind(fs);let creations=0;
  t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{if(args[1]==='wx'&&++creations===2)throw new Error('disk full');return open(...args);});
  await assert.rejects(f.manager.addNativePastedImages('s',[image(),image()]),/disk full/);
  assert.deepEqual(await fs.readFile(f.manifest),before);assert.deepEqual(await f.staged(),[path.basename(draft.path)]);
});

test('manifest replacement failure removes paste files and leaves previous ownership readable',async t=>{
  const f=await fixture(t),[draft]=await f.manager.addNativePastedImages('s',[image()]),before=await fs.readFile(f.manifest),rename=fs.rename.bind(fs);
  t.mock.method(fs,'rename',async(...args:Parameters<typeof fs.rename>)=>{if(args[1]===f.manifest)throw new Error('manifest unavailable');return rename(...args);});
  await assert.rejects(f.manager.addNativePastedImages('s',[image()]),/manifest unavailable/);
  assert.deepEqual(await fs.readFile(f.manifest),before);assert.deepEqual(await f.staged(),[path.basename(draft.path)]);
  assert.deepEqual(await new Attachments(f.directory).list('s'),[draft]);
});

test('admission rejection after waiting for serial ownership writes no new files',async t=>{
  const f=await fixture(t),[draft]=await f.manager.addNativePastedImages('s',[image()]),rename=fs.rename.bind(fs),entered=deferred(),release=deferred();let held=false,allowed=true;
  t.mock.method(fs,'rename',async(...args:Parameters<typeof fs.rename>)=>{if(args[1]===f.manifest&&!held){held=true;entered.resolve();await release.promise;}return rename(...args);});
  const first=f.manager.retain('s',[draft.path]);await entered.promise;
  const pending=f.manager.addNativePastedImages('s',[image()],()=>{if(!allowed)throw new Error('admission revoked');});
  const rejected=assert.rejects(pending,/admission revoked/);allowed=false;release.resolve();await first;await rejected;
  assert.deepEqual(await f.staged(),[path.basename(draft.path)]);assert.deepEqual(await f.manager.list('s'),[draft]);
});

test('admission revocation while writing rolls back bytes before committing a manifest',async t=>{
  const f=await fixture(t),[draft]=await f.manager.addNativePastedImages('s',[image()]),before=await fs.readFile(f.manifest),open=fs.open.bind(fs);let allowed=true;
  t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
    const handle=await open(...args);if(args[1]==='wx') {const write=handle.writeFile.bind(handle);t.mock.method(handle,'writeFile',async(...writeArgs:Parameters<typeof handle.writeFile>)=>{await write(...writeArgs);allowed=false;});}return handle;
  });
  await assert.rejects(f.manager.addNativePastedImages('s',[image()],()=>{if(!allowed)throw new Error('admission revoked');}),/admission revoked/);
  assert.deepEqual(await fs.readFile(f.manifest),before);assert.deepEqual(await f.staged(),[path.basename(draft.path)]);
});

test('admission revocation during final snapshot capture restores previous durable manifest',async t=>{
  const f=await fixture(t),[draft]=await f.manager.addNativePastedImages('s',[image()]),before=await fs.readFile(f.manifest),open=fs.open.bind(fs);let allowed=true;
  t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const handle=await open(...args);if(typeof args[1]==='number')allowed=false;return handle;});
  await assert.rejects(f.manager.addNativePastedImages('s',[image()],()=>{if(!allowed)throw new Error('admission revoked');}),/admission revoked/);
  assert.deepEqual(await fs.readFile(f.manifest),before);assert.deepEqual(await f.staged(),[path.basename(draft.path)]);assert.deepEqual(await new Attachments(f.directory).list('s'),[draft]);
});

test('unrecoverable rollback preserves referenced bytes for restart instead of deleting live references',async t=>{
  const f=await fixture(t),[draft]=await f.manager.addNativePastedImages('s',[image()]),rename=fs.rename.bind(fs);let commits=0,allowed=true;
  t.mock.method(fs,'rename',async(...args:Parameters<typeof fs.rename>)=>{
    if(args[1]===f.manifest) {if(++commits===2)throw new Error('rollback unavailable');const result=await rename(...args);allowed=false;return result;}return rename(...args);
  });
  await assert.rejects(f.manager.addNativePastedImages('s',[image()],()=>{if(!allowed)throw new Error('admission revoked');}),/rollback unavailable/);
  const restored=await new Attachments(f.directory).list('s');assert.equal(restored.length,2);assert.deepEqual(restored[0],draft);
  for(const item of restored)assert.deepEqual(await fs.readFile(item.path),png());
});
