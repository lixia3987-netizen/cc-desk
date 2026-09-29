import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { Attachments } from '../src/main/attachments';
import { readNativeDraftImage, readNativeImageAttachments } from '../src/main/native-image-attachments';

const previewError='Native 图片预览不可用，附件已移除、已发送或发生变更，请重新选择。';
function chunk(type:string,data:Buffer) {
  const result=Buffer.alloc(data.length+12);result.writeUInt32BE(data.length);result.write(type,4);data.copy(result,8);
  let crc=0xffffffff;for(const byte of result.subarray(4,-4)) {crc^=byte;for(let i=0;i<8;i++)crc=(crc&1)?0xedb88320^(crc>>>1):crc>>>1;}
  result.writeUInt32BE((crc^0xffffffff)>>>0,result.length-4);return result;
}
function png() {
  const header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0,255]))),chunk('IEND',Buffer.alloc(0))]);
}
async function fixture(t:TestContext) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'native-preview-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const directory=path.join(root,'data'),manager=new Attachments(directory);
  async function stage(name='截图.png',bytes:Buffer=png(),sessionId='session') {
    const source=path.join(root,name);await fs.writeFile(source,bytes);return (await manager.add(sessionId,[source]))[0];
  }
  return {root,directory,manager,stage};
}

test('Draft preview returns a validated immutable single-image snapshot and exact metadata',async t=>{
  const f=await fixture(t),draft=await f.stage();
  const result=await readNativeDraftImage(f.directory,'session',draft.path);
  assert.deepEqual(Object.keys(result).sort(),['dataUrl','image']);
  assert.deepEqual(result.image,{name:'截图.png',mimeType:'image/png',bytes:png().length,sha256:createHash('sha256').update(png()).digest('hex')});
  assert.deepEqual(Buffer.from(result.dataUrl.slice('data:image/png;base64,'.length),'base64'),png());
  assert.equal(JSON.stringify(result.image).includes(draft.path),false);
  await fs.writeFile(draft.path,'changed later');
  assert.deepEqual(Buffer.from(result.dataUrl.split(',')[1],'base64'),png());
});

test('Draft preview is read-only and does not collect or mark draft files',async t=>{
  const f=await fixture(t),draft=await f.stage(),folder=path.dirname(draft.path),manifest=path.join(folder,'attachments.json');
  const orphan=path.join(folder,'.staged-11111111-1111-1111-1111-111111111111.png');await fs.writeFile(orphan,png());
  const before=await fs.readFile(manifest),fileBefore=await fs.stat(draft.path);
  const mutation=()=>{throw new Error('Unexpected filesystem mutation');};
  const mutations=[t.mock.method(fs,'writeFile',mutation),t.mock.method(fs,'appendFile',mutation),t.mock.method(fs,'rm',mutation),t.mock.method(fs,'unlink',mutation),t.mock.method(fs,'mkdir',mutation),t.mock.method(fs,'rename',mutation),t.mock.method(fs,'copyFile',mutation),t.mock.method(fs,'chmod',mutation)];
  try {await readNativeDraftImage(f.directory,'session',draft.path);for(const call of mutations)assert.equal(call.mock.callCount(),0);}
  finally {for(const call of mutations)call.mock.restore();}
  assert.deepEqual(await fs.readFile(manifest),before);assert.deepEqual(await fs.readFile(orphan),png());
  assert.equal((await fs.stat(draft.path)).mtimeMs,fileBefore.mtimeMs);
  assert.equal(JSON.parse(before.toString()).items[0].draft,true);
});

test('Draft preview rejects removed and sent files, while retained current drafts remain visible',async t=>{
  const f=await fixture(t),removed=await f.stage('removed.png'),retained=await f.stage('retained.png');
  await f.manager.retain('session',[retained.path]);
  assert.equal((await readNativeDraftImage(f.directory,'session',retained.path)).image.name,'retained.png');
  await f.manager.removeFile('session',removed.path);
  await assert.rejects(readNativeDraftImage(f.directory,'session',removed.path),{message:previewError});
  await f.manager.markSent('session',[retained.path]);
  assert.equal((await readNativeImageAttachments(f.directory,'session',[retained.path])).images.length,1);
  await assert.rejects(readNativeDraftImage(f.directory,'session',retained.path),{message:previewError});
  assert.deepEqual(await fs.readFile(retained.path),png());
});

test('Draft preview reads fresh ownership and rejects arbitrary paths with fixed errors',async t=>{
  const f=await fixture(t),draft=await f.stage(),foreign=await f.stage('foreign.png',png(),'other');
  for(const candidate of [foreign.path,path.join(f.root,'截图.png'),'data:image/png;base64,secret','https://private.example/secret.png',path.join(f.root,'missing-secret.png')]) {
    await assert.rejects(readNativeDraftImage(f.directory,'session',candidate),{message:previewError});
  }
  await assert.rejects(readNativeDraftImage(f.directory,'../session',draft.path),{message:previewError});
  const manifest=path.join(path.dirname(draft.path),'attachments.json'),value=JSON.parse(await fs.readFile(manifest,'utf8'));
  value.items[0].draft=false;await fs.writeFile(manifest,JSON.stringify(value));
  await assert.rejects(readNativeDraftImage(f.directory,'session',draft.path),{message:previewError});
});

test('Draft preview invalidates a manifest draft flag changed during image capture',async t=>{
  const f=await fixture(t),draft=await f.stage(),manifest=path.join(path.dirname(draft.path),'attachments.json');
  const open=fs.open.bind(fs);let changed=false;
  t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
    const descriptor=await open(...args);
    if(args[0]===draft.path&&!changed) {
      changed=true;const value=JSON.parse(await fs.readFile(manifest,'utf8'));value.items[0].draft=false;await fs.writeFile(manifest,JSON.stringify(value));
    }
    return descriptor;
  });
  await assert.rejects(readNativeDraftImage(f.directory,'session',draft.path),{message:previewError});assert.equal(changed,true);
});

test('Draft preview rejects corrupted manifests without leaking payloads or deleting files',async t=>{
  const f=await fixture(t),draft=await f.stage(),manifest=path.join(path.dirname(draft.path),'attachments.json');
  const invalid='{ sensitive-provider-secret';await fs.writeFile(manifest,invalid);
  await assert.rejects(readNativeDraftImage(f.directory,'session',draft.path),{message:previewError});
  assert.equal(await fs.readFile(manifest,'utf8'),invalid);assert.deepEqual(await fs.readFile(draft.path),png());
});

test('Draft preview preserves all image type and byte budget validation',async t=>{
  const f=await fixture(t);
  for(const [index,[name,bytes]] of ([['invalid.png',Buffer.from('not an image')],['unsupported.gif',png()],['mismatch.jpg',png()],['empty.png',Buffer.alloc(0)],['huge.png',Buffer.alloc(1024*1024+1)]] as [string,Buffer][]).entries()) {
    const draft=await f.stage(name,bytes,`s${index}`);
    await assert.rejects(readNativeDraftImage(f.directory,`s${index}`,draft.path),{message:previewError});
  }
});

test('Draft preview rejects hardlinked files and symlinks without following them',async t=>{
  const f=await fixture(t),draft=await f.stage(),alias=path.join(f.root,'linked.png');await fs.link(draft.path,alias);
  await assert.rejects(readNativeDraftImage(f.directory,'session',draft.path),{message:previewError});await fs.rm(alias);
  if(process.platform!=='win32') {
    await fs.rm(draft.path);await fs.symlink(path.join(f.root,'截图.png'),draft.path);
    await assert.rejects(readNativeDraftImage(f.directory,'session',draft.path),{message:previewError});
  }
});
