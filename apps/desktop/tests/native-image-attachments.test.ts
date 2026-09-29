import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { Attachments } from '../src/main/attachments';
import { readNativeImageAttachments, verifyNativeImageAttachments } from '../src/main/native-image-attachments';

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
async function fixture(t:TestContext) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'native-images-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const directory=path.join(root,'data'),manager=new Attachments(directory);
  async function stage(name='image.png',bytes:Buffer=png(),session='s') {
    const source=path.join(root,name);await fs.writeFile(source,bytes);return (await manager.add(session,[source]))[0];
  }
  return {root,directory,manager,stage};
}

test('Native snapshot accepts PNG/JPEG, hashes bytes and retains no paths in metadata',async t=>{
  const f=await fixture(t),a=await f.stage('图.png'),b=await f.stage('photo.JPEG',jpeg);
  const result=await readNativeImageAttachments(f.directory,'s',[a.path,b.path]);
  assert.deepEqual(result.metadata.map(item=>item.name),['图.png','photo.JPEG']);
  assert.equal(result.images[0].mimeType,'image/png');assert.equal(result.images[1].mimeType,'image/jpeg');
  assert.deepEqual(Buffer.from(result.images[0].dataUrl.split(',')[1],'base64'),png());
  assert.equal(result.metadata[0].sha256,createHash('sha256').update(png()).digest('hex'));
  assert.deepEqual(Object.keys(result.metadata[0]).sort(),['bytes','mimeType','name','sha256']);
  verifyNativeImageAttachments(result.images,result.metadata);
  await fs.writeFile(a.path,'replaced');assert.deepEqual(Buffer.from(result.images[0].dataUrl.split(',')[1],'base64'),png());
});
test('Native snapshot rejects arbitrary paths, cross-session paths, duplicates and invalid sessions',async t=>{
  const f=await fixture(t),a=await f.stage(),b=await f.stage('other.png',png(),'other');
  for(const paths of [[path.join(f.root,'image.png')],[b.path],[a.path,a.path]])await assert.rejects(readNativeImageAttachments(f.directory,'s',paths),/Native 图片附件/);
  await assert.rejects(readNativeImageAttachments(f.directory,'../s',[a.path]),/Native 图片附件/);
  assert.deepEqual(await readNativeImageAttachments('/missing','s',[]),{images:[],metadata:[]});
});
test('Native snapshot leaves drafts, retained references and orphan staging bytes unchanged',async t=>{
  const f=await fixture(t),a=await f.stage(),b=await f.stage('sent.png');await f.manager.markSent('s',[b.path]);
  const folder=path.dirname(a.path),manifest=path.join(folder,'attachments.json'),before=await fs.readFile(manifest);
  const orphan=path.join(folder,'.staged-11111111-1111-1111-1111-111111111111.png');await fs.writeFile(orphan,png());
  assert.equal((await readNativeImageAttachments(f.directory,'s',[a.path,b.path])).images.length,2);
  assert.deepEqual(await fs.readFile(manifest),before);assert.deepEqual(await fs.readFile(orphan),png());
  const parsed=JSON.parse(before.toString());parsed.items=parsed.items.filter((item:{file:string})=>item.file!==path.basename(a.path));await fs.writeFile(manifest,JSON.stringify(parsed));
  await assert.rejects(readNativeImageAttachments(f.directory,'s',[a.path]),/不属于/);
});
test('Native snapshot rejects wrong signature, unsupported extension, truncation, bad CRC and huge dimensions',async t=>{
  const f=await fixture(t),badCRC=png();badCRC[badCRC.length-1]^=1;
  for(const [index,[name,bytes]] of ([['wrong.png',jpeg],['wrong.jpg',png()],['image.gif',png()],['empty.png',Buffer.alloc(0)],['cut.png',png().subarray(0,35)],['cut.jpg',jpeg.subarray(0,jpeg.length-2)],['crc.png',badCRC],['wide.png',png(4097)],['tall.png',png(1,4097)]] as [string,Buffer][]).entries()) {
    const a=await f.stage(name,bytes,`s${index}`);await assert.rejects(readNativeImageAttachments(f.directory,`s${index}`,[a.path]),/Native 图片附件/);
  }
});
test('Native snapshot enforces image count and exact total byte ceiling',async t=>{
  const f=await fixture(t),paths:string[]=[];for(let i=0;i<5;i++)paths.push((await f.stage(`small${i}.png`)).path);
  await assert.rejects(readNativeImageAttachments(f.directory,'s',paths),/Native 图片附件/);
  assert.equal((await readNativeImageAttachments(f.directory,'s',paths.slice(0,4))).images.length,4);
  const exact=png(1,1,1024*1024-png().length-12),a=await f.stage('exact.png',exact);
  assert.equal((await readNativeImageAttachments(f.directory,'s',[a.path])).metadata[0].bytes,1024*1024);
  await assert.rejects(readNativeImageAttachments(f.directory,'s',[a.path,paths[0]]),/Native 图片附件/);
  const large=await f.stage('large.png',png(1,1,1024*1024));await assert.rejects(readNativeImageAttachments(f.directory,'s',[large.path]),/Native 图片附件/);
});
test('Native snapshot rejects size mismatch and unsafe metadata names',async t=>{
  const f=await fixture(t),a=await f.stage(),manifest=path.join(path.dirname(a.path),'attachments.json'),original=JSON.parse(await fs.readFile(manifest,'utf8'));
  for(const name of ['', '../image.png','bad\\image.png','bad\nimage.png']) {
    const value=structuredClone(original);value.items[0].name=name;await fs.writeFile(manifest,JSON.stringify(value));
    await assert.rejects(readNativeImageAttachments(f.directory,'s',[a.path]),/Native 图片附件/);
  }
  await fs.writeFile(manifest,JSON.stringify(original));await fs.appendFile(a.path,'x');await assert.rejects(readNativeImageAttachments(f.directory,'s',[a.path]),/Native 图片附件/);
});
test('Native snapshot rejects hardlinks for both image and private manifest',async t=>{
  const f=await fixture(t),a=await f.stage(),alias=path.join(f.root,'alias.png');await fs.link(a.path,alias);
  await assert.rejects(readNativeImageAttachments(f.directory,'s',[a.path]),/Native 图片附件/);await fs.rm(alias);
  await fs.link(path.join(path.dirname(a.path),'attachments.json'),path.join(f.root,'manifest.json'));
  await assert.rejects(readNativeImageAttachments(f.directory,'s',[a.path]),/Native 图片附件/);
});
test('Native snapshot rejects symlink file, manifest and session directory',{skip:process.platform==='win32'},async t=>{
  const f=await fixture(t),a=await f.stage(),source=path.join(f.root,'image.png');await fs.rm(a.path);await fs.symlink(source,a.path);
  await assert.rejects(readNativeImageAttachments(f.directory,'s',[a.path]),/Native 图片附件/);await fs.rm(a.path);await fs.copyFile(source,a.path);
  const manifest=path.join(path.dirname(a.path),'attachments.json'),saved=path.join(f.root,'saved.json');await fs.rename(manifest,saved);await fs.symlink(saved,manifest);
  await assert.rejects(readNativeImageAttachments(f.directory,'s',[a.path]),/Native 图片附件/);await fs.rm(manifest);await fs.rename(saved,manifest);
  const folder=path.dirname(a.path),moved=path.join(f.root,'moved');await fs.rename(folder,moved);await fs.symlink(moved,folder,'dir');
  await assert.rejects(readNativeImageAttachments(f.directory,'s',[a.path]),/Native 图片附件/);
});
test('Native snapshot detects same-size writes during descriptor capture',async t=>{
  const f=await fixture(t),a=await f.stage(),open=fs.open.bind(fs);let mutated=false;
  t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
    const handle=await open(...args);
    if(args[0]===a.path) {
      const read=handle.read.bind(handle);
      t.mock.method(handle,'read',async(...readArgs:Parameters<typeof handle.read>)=>{
        const result=await read(...readArgs);
        if(!mutated) {mutated=true;const original=await fs.stat(a.path);await fs.writeFile(a.path,png());await fs.utimes(a.path,original.atime,original.mtime);}
        return result;
      });
    }
    return handle;
  });
  await assert.rejects(readNativeImageAttachments(f.directory,'s',[a.path]),/已变更/);assert.equal(mutated,true);
});
test('Native snapshot detects path replacement after opening descriptor',async t=>{
  const f=await fixture(t),a=await f.stage(),open=fs.open.bind(fs);let replaced=false;
  t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
    const handle=await open(...args);if(args[0]===a.path&&!replaced) {replaced=true;await fs.rename(a.path,a.path+'.old');await fs.writeFile(a.path,png());}return handle;
  });
  await assert.rejects(readNativeImageAttachments(f.directory,'s',[a.path]),/已变更/);
});
test('Transport verification rejects altered hashes, payloads, names, MIME and noncanonical base64',async t=>{
  const f=await fixture(t),a=await f.stage(),result=await readNativeImageAttachments(f.directory,'s',[a.path]);
  for(const change of [{sha256:'0'.repeat(64)},{bytes:1},{name:'bad\n.png'},{name:''},{mimeType:'image/jpeg'},{dataUrl:'sensitive'}]) {
    assert.throws(()=>verifyNativeImageAttachments(result.images,[{...result.metadata[0],...change}]),/Native 图片附件/);
  }
  assert.throws(()=>verifyNativeImageAttachments([{...result.images[0],dataUrl:result.images[0].dataUrl+'\n'}],result.metadata),/Native 图片附件/);
  assert.throws(()=>verifyNativeImageAttachments([{mimeType:'image/png',dataUrl:'https://example.test/a.png'}],result.metadata),/Native 图片附件/);
  assert.throws(()=>verifyNativeImageAttachments(result.images,null),/Native 图片附件/);
  verifyNativeImageAttachments([],[]);
});
test('Native staging rejects invalid additions atomically and preserves existing drafts',async t=>{
  const f=await fixture(t),a=await f.stage(),bad=path.join(f.root,'bad.png');await fs.writeFile(bad,'not a PNG');
  await assert.rejects(f.manager.addNative('s',[bad]),/Native 图片附件/);
  assert.deepEqual(await new Attachments(f.directory).list('s'),[a]);
  assert.equal((await fs.readdir(path.dirname(a.path))).filter(file=>file.startsWith('.staged')).length,1);
  const good=path.join(f.root,'good.jpg');await fs.writeFile(good,jpeg);assert.equal((await f.manager.addNative('s',[good])).length,1);
  assert.equal((await f.manager.list('s')).length,2);
});
test('Native staging includes prior drafts in count and removes no sent references',async t=>{
  const f=await fixture(t),a=await f.stage(),source=path.join(f.root,'image.png');await f.manager.markSent('s',[a.path]);
  await f.manager.addNative('s',[source,source,source,source]);
  await assert.rejects(f.manager.addNative('s',[source]),/Native 图片附件/);
  assert.equal((await f.manager.list('s')).length,4);assert.deepEqual(await fs.readFile(a.path),png());
});
