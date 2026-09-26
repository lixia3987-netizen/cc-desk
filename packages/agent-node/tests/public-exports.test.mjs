import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));

test('all public entries load compiled ESM in a plain Node process', async () => {
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const specifier = '@cc-desk/agent-node' + (subpath === '.' ? '' : subpath.slice(1));
    assert.equal(import.meta.resolve(specifier), new URL(target.default, new URL('../', import.meta.url)).href);
    const module = await import(specifier);
    if (subpath === '.') assert.equal(typeof module.NativeRunStore, 'function');
  }
});

test('consumers cannot import source files or private build paths', async () => {
  for (const subpath of ['src/commands.ts', 'dist/commands.js', 'package.json']) {
    await assert.rejects(import(`@cc-desk/agent-node/${subpath}`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  }
});

test('source and build imports stay inside the engine or its declared platform dependencies', () => {
  const filesIn = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(file) : /\.(?:ts|js)$/.test(entry.name) ? [file] : [];
  });
  for (const directory of ['src', 'dist']) {
    for (const file of filesIn(path.join(packageRoot, directory))) {
      for (const { fileName: specifier } of ts.preProcessFile(fs.readFileSync(file, 'utf8'), true, true).importedFiles) {
        if (specifier.startsWith('.')) {
          const relative = path.relative(path.join(packageRoot, directory), path.resolve(path.dirname(file), specifier));
          assert.ok(relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), `Engine import escapes ${directory}: ${specifier} in ${file}`);
          assert.ok(specifier.endsWith('.js'), `Engine relative import must resolve compiled ESM: ${specifier} in ${file}`);
        } else {
          assert.ok(specifier.startsWith('node:') || specifier === '@cc-desk/agent-core' || specifier === 'zod', `Unexpected engine dependency: ${specifier} in ${file}`);
        }
      }
    }
  }
});

test('public declarations consume host ports without desktop or Electron types', () => {
  const program = ts.createProgram([path.join(packageRoot, 'tests/fixtures/consumer.mts')], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: ['node'],
    strict: true,
    noEmit: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => packageRoot,
    getCanonicalFileName: name => name,
    getNewLine: () => '\n',
  }));
  const sources = program.getSourceFiles();
  for (const source of sources) {
    const filename = path.resolve(source.fileName).replaceAll('\\', '/');
    assert.ok(!filename.includes('/apps/desktop/'), `Public declaration depends on desktop: ${filename}`);
    assert.ok(!/(?:^|\/)electron(?:\/|\.)/.test(filename), `Public declaration depends on Electron: ${filename}`);
    assert.ok(!filename.includes('/agent-node/src/'), `Public declaration depends on uncompiled source: ${filename}`);
  }
  assert.ok(sources.some(source => path.resolve(source.fileName) === path.join(packageRoot, 'dist', 'index.d.ts')));
});
