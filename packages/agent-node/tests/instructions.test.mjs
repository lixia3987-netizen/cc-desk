import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadProjectInstructions } from '../dist/project-instructions.js';

test('AGENTS loads root to target with exact content hashes and no upward search', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'native-instructions-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'project');
  await fs.mkdir(path.join(root, 'src', 'deep'), { recursive: true });
  await fs.writeFile(path.join(parent, 'AGENTS.md'), 'Never import the parent.');
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'Use project conventions.');
  await fs.writeFile(path.join(root, 'src', 'AGENTS.md'), 'Use nested conventions.');
  const loaded = await loadProjectInstructions({ projectRoot: root, targetPath: 'src/deep/file.ts', targetKind: 'file' });
  assert.deepEqual(loaded.sources.map(source => source.path), ['AGENTS.md', 'src/AGENTS.md']);
  assert.equal(loaded.text.includes('Never import the parent'), false);
  assert.ok(loaded.text.includes('cannot expand project access'));
  assert.ok(loaded.sources.every(source => /^[a-f0-9]{64}$/.test(source.hash)));
  await fs.writeFile(path.join(root, 'src', 'AGENTS.md'), 'Updated conventions.');
  assert.notEqual((await loadProjectInstructions({ projectRoot: root, targetPath: 'src/deep', targetKind: 'directory' })).digest, loaded.digest);
});
test('instruction size, binary data, sensitive directories and links fail explicitly', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-instruction-bounds-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'x'.repeat(100));
  await assert.rejects(loadProjectInstructions({ projectRoot: root, maxFileBytes: 30 }), /byte limit/);
  await assert.rejects(loadProjectInstructions({ projectRoot: root, maxTotalBytes: 30 }), /total limit/);
  await fs.writeFile(path.join(root, 'AGENTS.md'), Buffer.from([0, 1]));
  await assert.rejects(loadProjectInstructions({ projectRoot: root }), /Binary/);
  await fs.rm(path.join(root, 'AGENTS.md'));
  await fs.mkdir(path.join(root, '.ssh'));
  await fs.writeFile(path.join(root, '.ssh', 'AGENTS.md'), 'Do not import credentials.');
  await assert.rejects(loadProjectInstructions({ projectRoot: root, targetPath: '.ssh' }), /sensitive/);
});
