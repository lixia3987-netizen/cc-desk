import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadProjectInstructions } from '../dist/project-instructions.js';

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'native-instructions-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'project');
  await fs.mkdir(root);
  return { parent, root };
}

for (const filename of ['AGENTS.md', 'CLAUDE.md']) {
  test(`${filename} loads root to target with exact content hashes and no upward search`, async t => {
    const { parent, root } = await fixture(t);
    await fs.mkdir(path.join(root, 'src', 'deep'), { recursive: true });
    await fs.writeFile(path.join(parent, filename), 'Never import the parent.');
    await fs.writeFile(path.join(root, filename), 'Use project conventions.');
    await fs.writeFile(path.join(root, 'src', filename), 'Use nested conventions.');
    const loaded = await loadProjectInstructions({ projectRoot: root, targetPath: 'src/deep/file.ts', targetKind: 'file' });
    assert.deepEqual(loaded.sources.map(source => source.path), [filename, `src/${filename}`]);
    assert.equal(loaded.text.includes('Never import the parent'), false);
    assert.ok(loaded.text.includes('cannot expand project access'));
    assert.ok(loaded.sources.every(source => /^[a-f0-9]{64}$/.test(source.hash)));
    await fs.writeFile(path.join(root, 'src', filename), 'Updated conventions.');
    assert.notEqual((await loadProjectInstructions({ projectRoot: root, targetPath: 'src/deep', targetKind: 'directory' })).digest, loaded.digest);
  });

  test(`${filename} rejects oversized, binary, invalid UTF-8 and sensitive instruction sources`, async t => {
    const { root } = await fixture(t);
    const instructionPath = path.join(root, filename);
    await fs.writeFile(instructionPath, 'x'.repeat(32 * 1024 + 1));
    await assert.rejects(loadProjectInstructions({ projectRoot: root }), /32768 byte limit/);
    await fs.writeFile(instructionPath, 'x'.repeat(100));
    await assert.rejects(loadProjectInstructions({ projectRoot: root, maxFileBytes: 30 }), /byte limit/);
    await assert.rejects(loadProjectInstructions({ projectRoot: root, maxTotalBytes: 30 }), /total limit/);
    await fs.writeFile(instructionPath, Buffer.from([0, 1]));
    await assert.rejects(loadProjectInstructions({ projectRoot: root }), /Binary/);
    await fs.writeFile(instructionPath, Buffer.from([0xff]));
    await assert.rejects(loadProjectInstructions({ projectRoot: root }), /UTF-8/);
    await fs.rm(instructionPath);
    await fs.mkdir(path.join(root, '.ssh'));
    await fs.writeFile(path.join(root, '.ssh', filename), 'Do not import credentials.');
    await assert.rejects(loadProjectInstructions({ projectRoot: root, targetPath: '.ssh' }), /sensitive/);
  });

  test(`${filename} obeys project and excluded-root boundaries`, async t => {
    const { parent, root } = await fixture(t);
    const protectedRoot = path.join(root, 'host-data');
    await fs.mkdir(protectedRoot);
    await fs.writeFile(path.join(protectedRoot, filename), 'Private host instructions.');
    await assert.rejects(loadProjectInstructions({ projectRoot: root, targetPath: '../outside' }), /Unsafe/);
    await assert.rejects(loadProjectInstructions({ projectRoot: root, targetPath: parent }), /project-relative/);
    await assert.rejects(loadProjectInstructions({ projectRoot: root, targetPath: 'host-data', excludedRoots: [protectedRoot] }), /Protected path/);
  });

  test(`${filename} refuses file symlinks`, { skip: process.platform === 'win32' }, async t => {
    const { parent, root } = await fixture(t);
    const outside = path.join(parent, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, filename), 'Never follow outside rules.');
    await fs.symlink(path.join(outside, filename), path.join(root, filename));
    await assert.rejects(loadProjectInstructions({ projectRoot: root }), /links are refused/);
  });

  test(`${filename} refuses linked instruction scopes`, async t => {
    const { parent, root } = await fixture(t);
    const outside = path.join(parent, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, filename), 'Never follow outside rules.');
    await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(loadProjectInstructions({ projectRoot: root, targetPath: 'linked' }), /links are refused/);
  });
}

test('mixed instruction files use depth first, then AGENTS precedence within each scope', async t => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, 'src'));
  const orderedPaths = ['CLAUDE.md', 'AGENTS.md', 'src/CLAUDE.md', 'src/AGENTS.md'];
  for (const [index, relative] of orderedPaths.entries()) {
    await fs.writeFile(path.join(root, relative), `Conflicting convention ${index}.`);
  }
  const loaded = await loadProjectInstructions({ projectRoot: root, targetPath: 'src/file.ts', targetKind: 'file' });
  assert.deepEqual(loaded.sources.map(source => source.path), orderedPaths);
  assert.deepEqual(loaded.sources.map(source => source.scope), ['.', '.', 'src', 'src']);
  assert.match(loaded.text, /deeper.*(?:precedence|override)/i);
  assert.match(loaded.text, /AGENTS\.md.*(?:precedence|override).*CLAUDE\.md/i);
  const positions = orderedPaths.map(relative => loaded.text.indexOf(`--- ${relative} (scope:`));
  assert.ok(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1])));
});

test('AGENTS-only digest remains compatible and CLAUDE additions, edits and removal invalidate it', async t => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'Use project conventions.');
  const original = await loadProjectInstructions({ projectRoot: root });
  // Recorded from the AGENTS-only loader, so existing policy bindings remain stable.
  assert.equal(original.digest, '9834fee665d6e0c68dd2369b7f74019c658699f4cf42870099894045d5e31a9e');
  await fs.writeFile(path.join(root, 'CLAUDE.md'), 'Claude conventions.');
  const added = await loadProjectInstructions({ projectRoot: root });
  assert.notEqual(added.digest, original.digest);
  await fs.writeFile(path.join(root, 'CLAUDE.md'), 'Changed Claude conventions.');
  const changed = await loadProjectInstructions({ projectRoot: root });
  assert.notEqual(changed.digest, added.digest);
  await fs.rm(path.join(root, 'CLAUDE.md'));
  const removed = await loadProjectInstructions({ projectRoot: root });
  assert.notEqual(removed.digest, changed.digest);
  assert.equal(removed.digest, original.digest);
});

test('both filenames and nested scopes share one 128KiB default instruction budget', async t => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, 'src', 'deep'), { recursive: true });
  for (const relative of ['CLAUDE.md', 'AGENTS.md', 'src/CLAUDE.md', 'src/AGENTS.md']) {
    await fs.writeFile(path.join(root, relative), 'x'.repeat(32 * 1024));
  }
  const options = { projectRoot: root, targetPath: 'src/deep' };
  assert.equal((await loadProjectInstructions(options)).sources.length, 4);
  await fs.writeFile(path.join(root, 'src', 'deep', 'CLAUDE.md'), 'x');
  await assert.rejects(loadProjectInstructions(options), /131072 byte total limit/);
  await assert.rejects(loadProjectInstructions({ projectRoot: root, maxTotalBytes: 32 * 1024 }), /total limit/);
});

test('CLAUDE imports and auxiliary .claude rules remain literal and are never expanded', async t => {
  const { parent, root } = await fixture(t);
  await fs.mkdir(path.join(root, '.claude'));
  await fs.writeFile(path.join(parent, 'CLAUDE.md'), 'Outside parent sentinel.');
  await fs.writeFile(path.join(root, '.claude', 'CLAUDE.md'), 'Auxiliary rules sentinel.');
  await fs.writeFile(path.join(root, 'included.md'), 'Included file sentinel.');
  const content = '@included.md\n@../CLAUDE.md\n@~/.claude/CLAUDE.md\n@https://example.invalid/rules';
  await fs.writeFile(path.join(root, 'CLAUDE.md'), content);
  const loaded = await loadProjectInstructions({ projectRoot: root });
  assert.deepEqual(loaded.sources.map(source => source.path), ['CLAUDE.md']);
  assert.equal(loaded.sources[0].content, content);
  assert.doesNotMatch(loaded.text, /(?:Outside parent|Auxiliary rules|Included file) sentinel/);
});
