import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectFiles, contentHash } from '../dist/tools/project-files.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-prefix-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, files: new ProjectFiles({ projectRoot: root, maxFileBytes: 32768 }) };
}

test('prefix reads only bounded metadata and never returns a full-version hash', async t => {
  const { root, files } = await fixture(t);
  const text = '---\nname: review\n---\n' + 'private-body'.repeat(2000);
  await fs.writeFile(path.join(root, 'SKILL.md'), text);
  const prefix = await files.readPrefix('SKILL.md', 24);
  assert.equal(prefix.bytes, 24); assert.equal(prefix.truncated, true);
  assert.equal(prefix.prefixHash, contentHash(Buffer.from(text).subarray(0, 24)));
  assert.equal('hash' in prefix, false);
  assert.notEqual(prefix.prefixHash, contentHash(text));
  assert.equal(prefix.snapshot.identities.at(-1).stat.size, BigInt(Buffer.byteLength(text)));
});

test('metadata prefix preserves BOM and complete UTF-8 while omitting a split last character', async t => {
  const { root, files } = await fixture(t);
  await fs.writeFile(path.join(root, 'SKILL.md'), '\ufeff甲乙丙');
  const prefix = await files.readPrefix('SKILL.md', 7);
  assert.equal(prefix.content, '\ufeff甲'); assert.equal(prefix.bytes, 7);
  const full = await files.readPrefix('SKILL.md', 20);
  assert.equal(full.content, '\ufeff甲乙丙'); assert.equal(full.truncated, false);
});

test('prefix reader rejects invalid text, links, oversize, cancellation and invalid limits', async t => {
  const { root, files } = await fixture(t);
  for (const data of [Buffer.from([0xff, 1]), Buffer.from([0xe7, 0x94]), Buffer.from([65, 0]), Buffer.alloc(32769, 65)]) {
    await fs.writeFile(path.join(root, 'SKILL.md'), data);
    await assert.rejects(files.readPrefix('SKILL.md', 8));
  }
  await fs.writeFile(path.join(root, 'SKILL.md'), 'text');
  const controller = new AbortController(); controller.abort(new Error('stopped'));
  await assert.rejects(files.readPrefix('SKILL.md', 8, controller.signal), /stopped/);
  for (const maximum of [0, -1, 32769, NaN]) await assert.rejects(files.readPrefix('SKILL.md', maximum));
  await assert.rejects(files.readPrefix('../SKILL.md', 8));
  if (process.platform !== 'win32') {
    await fs.symlink('SKILL.md', path.join(root, 'linked.md'));
    await assert.rejects(files.readPrefix('linked.md', 8), /links/);
  }
});

test('a changed complete file invalidates the prefix snapshot even when its metadata is identical', async t => {
  const { root, files } = await fixture(t);
  const header = '---\nname: review\n---\n';
  await fs.writeFile(path.join(root, 'SKILL.md'), header + 'original');
  const prefix = await files.readPrefix('SKILL.md', header.length);
  await fs.writeFile(path.join(root, 'SKILL.md'), header + 'changed!');
  await assert.rejects(files.verify(prefix.snapshot, true), /changed/);
});
