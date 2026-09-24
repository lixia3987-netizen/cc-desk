import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

test('public entries resolve to compiled ESM without a TypeScript loader', async () => {
  for (const name of ['execution', 'chat', 'execution-events']) {
    const specifier = `@cc-desk/contracts/${name}`;
    assert.equal(import.meta.resolve(specifier), new URL(`../dist/${name}.js`, import.meta.url).href);
    const module = await import(specifier);
    if (name === 'execution') {
      assert.equal(typeof module.getSessionIdentity, 'function');
      assert.equal(typeof module.sameConversation, 'function');
    }
  }
});

test('package consumers cannot import source files or private build paths', async () => {
  for (const subpath of ['src/execution.ts', 'dist/execution.js', 'package.json']) {
    await assert.rejects(import(`@cc-desk/contracts/${subpath}`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  }
});

test('public declarations serve chat and event consumers without desktop or platform types', () => {
  const program = ts.createProgram([path.join(packageRoot, 'tests/fixtures/consumer.mts')], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ['lib.es2022.d.ts'],
    types: [],
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
  const standardLibRoot = path.dirname(path.resolve(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES2022 })));
  for (const source of sources) {
    const filename = path.resolve(source.fileName);
    const relative = path.relative(packageRoot, filename);
    const packageFile = !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
    const standardLibrary = path.dirname(filename) === standardLibRoot && /^lib\..*\.d\.ts$/.test(path.basename(filename));
    assert.ok(packageFile || standardLibrary, `Contract declarations imported an external type: ${filename}`);
  }
  for (const name of ['execution', 'chat', 'execution-events']) {
    assert.ok(sources.some(source => path.resolve(source.fileName) === path.join(packageRoot, 'dist', `${name}.d.ts`)), `Missing compiled declaration: ${name}`);
  }
});
