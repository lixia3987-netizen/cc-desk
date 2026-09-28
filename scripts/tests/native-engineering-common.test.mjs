import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJson, readJson, ordinaryDirectory, assertSeparate, hashJson, loadEngineeringSuite, ENGINEERING_SUITE } from '../native-eval-engineering-common.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'engineering-common-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('engineering artifacts preserve an earlier failure instead of overwriting it', async t => {
  const root = await fixture(t), file = path.join(root, 'attempt.json');
  await createJson(file, { status: 'fail', observed: null });
  const before = await fs.readFile(file);
  await assert.rejects(createJson(file, { status: 'pass', observed: 0 }), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(file), before);
  assert.deepEqual(await readJson(file), { status: 'fail', observed: null });
  assert.deepEqual(await fs.readdir(root), ['attempt.json']);
});

test('metadata rejects byte overflow and invalid UTF-8 before parsing', async t => {
  const root = await fixture(t), file = path.join(root, 'record.json');
  await fs.writeFile(file, '{"extra":"' + 'x'.repeat(100) + '"}');
  await assert.rejects(readJson(file, { maxBytes: 64 }), /oversized/);
  await fs.writeFile(file, Buffer.from([0x22, 0xc0, 0x80, 0x22]));
  await assert.rejects(readJson(file), /encoded data/);
  await assert.rejects(createJson(path.join(root, 'too-large.json'), { content: 'a'.repeat(200) }, { maxBytes: 64 }), /budget/);
  assert.equal((await fs.readdir(root)).includes('too-large.json'), false);
});

test('metadata paths refuse aliases and never follow an existing output symlink', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t), actual = path.join(root, 'actual'), alias = path.join(root, 'alias');
  await fs.mkdir(actual); await fs.symlink(actual, alias);
  await fs.writeFile(path.join(actual, 'record.json'), '{"status":"fail"}');
  await assert.rejects(readJson(path.join(alias, 'record.json')), /aliases/);
  const output = path.join(root, 'output.json');
  await fs.symlink(path.join(actual, 'record.json'), output);
  await assert.rejects(createJson(output, { status: 'pass' }), { code: 'EEXIST' });
  assert.deepEqual(await readJson(path.join(actual, 'record.json')), { status: 'fail' });
  await assert.rejects(ordinaryDirectory(alias), /aliases/);
});

test('the evaluator resolves the pinned suite and distinguishes directory siblings from overlap', async t => {
  const root = await fixture(t);
  assert.throws(() => assertSeparate(root, path.join(root, 'candidate')), /separate/);
  assert.throws(() => assertSeparate(root, root), /separate/);
  assert.doesNotThrow(() => assertSeparate(path.join(root, 'candidate'), path.join(root, 'candidate-other')));
  const loaded = await loadEngineeringSuite();
  assert.deepEqual(loaded.suite, ENGINEERING_SUITE);
  assert.equal(loaded.manifest.tasks.length, 3);
  assert.equal(hashJson({ a: null, b: 0 }), hashJson({ b: 0, a: null }));
  assert.notEqual(hashJson({ a: null }), hashJson({ a: 0 }));
  assert.throws(() => hashJson({ value: NaN }), /finite JSON/);
});
