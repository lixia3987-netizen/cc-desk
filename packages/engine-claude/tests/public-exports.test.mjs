import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));

test('all public entries load compiled ESM in a plain Node process', async () => {
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const specifier = '@cc-desk/engine-claude' + (subpath === '.' ? '' : subpath.slice(1));
    assert.equal(import.meta.resolve(specifier), new URL(target.default, new URL('../', import.meta.url)).href);
    const module = await import(specifier);
    if (subpath === '.') assert.equal(typeof module.ClaudeRuntime, 'function');
  }
});

test('consumers cannot import source files or private build paths', async () => {
  for (const subpath of ['src/commands.ts', 'dist/commands.js', 'package.json']) {
    await assert.rejects(import(`@cc-desk/engine-claude/${subpath}`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
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
          assert.ok(specifier.startsWith('node:') || specifier.startsWith('@cc-desk/contracts/') || specifier === 'zod', `Unexpected engine dependency: ${specifier} in ${file}`);
        }
      }
    }
  }
});

test('renderer configuration and normalization entries have no platform imports', () => {
  const visited = new Set();
  const visit = file => {
    file = path.resolve(file);
    if (visited.has(file)) return;
    visited.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const { fileName: specifier } of ts.preProcessFile(source, true, true).importedFiles) {
      assert.ok(specifier.startsWith('.') || specifier.startsWith('@cc-desk/contracts/'), `Browser entry imports ${specifier} from ${file}`);
      const resolved = specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier) : createRequire(file).resolve(specifier);
      visit(resolved);
    }
  };
  for (const name of ['config', 'permissions', 'claude-session', 'session-recovery']) visit(path.join(packageRoot, 'dist', `${name}.js`));
});

test('public declarations consume host ports without desktop or Electron types', () => {
  const program = ts.createProgram([path.join(packageRoot, 'tests/fixtures/consumer.mts')], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ['lib.es2022.d.ts'],
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
    assert.ok(!filename.includes('/engine-claude/src/'), `Public declaration depends on uncompiled source: ${filename}`);
  }
  assert.ok(sources.some(source => path.resolve(source.fileName) === path.join(packageRoot, 'dist', 'host.d.ts')));
});
