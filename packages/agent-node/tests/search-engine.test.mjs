import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ProjectSearch, validateProjectSearchInput } from '../dist/tools/project-search.js';
import { BoundedRegex } from '../dist/tools/bounded-regex.js';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const baseIdentity = { sessionId: 'session', conversationId: 'conversation', runId: 'run', requestId: 'request', workerGeneration: 1 };
const context = (extra = {}) => ({ identity: { ...baseIdentity }, policyRevision: 'policy', instructionDigest: 'instructions', signal: new AbortController().signal, ...extra });
async function fixture(t, contents = {}, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-search-engine-'));
  const write = async (relative, bytes) => { const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); };
  for (const [file, bytes] of Object.entries(contents)) await write(file, bytes);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, write, search: new ProjectSearch({ projectRoot: root, ownerId: 'owner', ...options }) };
}

test('literal hits carry complete byte hashes, stable identities and one match per line', async t => {
  const content = '\ufefffirst\r\nhit hit\r\nlast'; const f = await fixture(t, { 'a.txt': content });
  const page = await f.search.search({ path: '.', query: 'hit' }, context());
  assert.equal(page.complete, true); assert.equal(page.matches.length, 1);
  assert.equal(page.matches[0].hash, hash(Buffer.from(content))); assert.equal(page.matches[0].hashStatus, 'complete');
  assert.equal(page.matches[0].line, 2); assert.equal(page.matches[0].column, 1); assert.match(page.matches[0].identity, /^[a-f0-9]{64}$/);
  assert.equal(page.scanned.bytes, Buffer.byteLength(content));
});
test('case folding maps offsets back to original UTF-16 columns, including inside expansions', async t => {
  const f = await fixture(t, { 'a.txt': 'İABC\r\n' });
  const later = await f.search.search({ path: '.', query: 'abc', caseSensitive: false }, context());
  assert.equal(later.matches[0].column, 2);
  const inside = await f.search.search({ path: '.', query: '\u0307', caseSensitive: false }, context());
  assert.equal(inside.matches[0].column, 1);
});
test('literal and regex excerpts show far-offset matches and report excerpt origin', async t => {
  const f = await fixture(t, { 'a.txt': 'x'.repeat(2000) + 'TARGET' + 'y'.repeat(1000) });
  for (const mode of ['literal', 'regex']) {
    const page = await f.search.search({ path: '.', query: 'TARGET', mode }, context());
    const hit = page.matches[0]; assert.equal(hit.column, 2001); assert.equal(hit.textTruncated, true);
    assert.match(hit.text, /TARGET/); assert.equal(hit.text.indexOf('TARGET') + hit.textStartColumn, hit.column);
  }
});
test('filename/glob search includes large binary assets without reading their contents', async t => {
  const f = await fixture(t, { 'art/avatar.png': Buffer.alloc(8192, 0), 'code/main.ts': 'source', 'art/readme.txt': 'text' }, { maxFileBytes: 16, maxScanBytes: 1 });
  const page = await f.search.search({ path: '.', mode: 'files', name: 'avatar', glob: '**/*.png' }, context());
  assert.equal(page.complete, true); assert.equal(page.matches[0].path, 'art/avatar.png'); assert.equal(page.matches[0].bytes, 8192);
  assert.equal(page.matches[0].hash, null); assert.equal(page.matches[0].hashStatus, 'not_read'); assert.equal(page.scanned.bytes, 0);
});
test('glob uses bounded segment semantics and supports unicode filenames and root ** matches', async t => {
  const f = await fixture(t, { 'root.ts': '', 'src/界😀.ts': '', 'src/deep/test.ts': '', 'src/a.js': '' });
  const page = await f.search.search({ path: '.', mode: 'files', glob: '**/*.ts' }, context());
  assert.deepEqual(page.matches.map(item => item.path), ['root.ts', 'src/deep/test.ts', 'src/界😀.ts']);
  const unicode = await f.search.search({ path: 'src', mode: 'files', glob: '界?.ts' }, context());
  assert.deepEqual(unicode.matches.map(item => item.path), ['src/界😀.ts']);
  const literal = await f.search.search({ path: 'src', mode: 'files', glob: '界😀.ts' }, context()); assert.equal(literal.totalMatches, 1);
});
test('ignored directory names and project-relative paths exclude traversal and explicit roots', async t => {
  const f = await fixture(t, { 'src/cache/a.ts': 'hit', 'src/keep/a.ts': 'hit', 'node_modules/a.ts': 'hit', 'dist/a.ts': 'hit' });
  const page = await f.search.search({ path: '.', query: 'hit', ignoreDirectories: ['src/cache'] }, context());
  assert.deepEqual(page.matches.map(item => item.path), ['src/keep/a.ts']);
  for (const input of [{ path: 'node_modules', query: 'hit' }, { path: 'dist', mode: 'files' }, { path: 'src/cache', query: 'hit', ignoreDirectories: ['cache'] }, { path: 'src/cache', query: 'hit', ignoreDirectories: ['src/cache'] }]) await assert.rejects(f.search.search(input, context()), { code: 'ignored_search_root' });
});
test('sensitive and protected files are excluded, while links make omission explicit', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, { '.env': 'hit', 'allowed.txt': 'hit', 'private/secret.txt': 'hit' });
  await fs.symlink(path.join(f.root, 'allowed.txt'), path.join(f.root, 'link.txt'));
  const search = new ProjectSearch({ projectRoot: f.root, ownerId: 'owner', excludedRoots: [path.join(f.root, 'private')] });
  const page = await search.search({ path: '.', query: 'hit' }, context());
  assert.deepEqual(page.matches.map(item => item.path), ['allowed.txt']); assert.ok(page.skipped.policy_excluded >= 2);
  assert.equal(page.complete, false); assert.ok(page.truncationReasons.includes('unreadable_or_link'));
});
test('snapshot pagination is complete only on final page and returns every observed hit once', async t => {
  const f = await fixture(t, { 'a.txt': 'hit\nhit\nhit\nhit\nhit' });
  const input = { path: '.', query: 'hit', pageSize: 2 }, pages = []; let page = await f.search.search(input, context());
  while (true) { pages.push(page); if (!page.nextCursor) break; page = await f.search.search({ ...input, cursor: page.nextCursor }, context()); }
  assert.deepEqual(pages.map(item => item.matches.length), [2, 2, 1]); assert.deepEqual(pages.flatMap(item => item.matches.map(hit => hit.line)), [1, 2, 3, 4, 5]);
  assert.ok(pages.every(item => item.scanComplete && item.totalMatches === 5)); assert.equal(pages[0].complete, false); assert.equal(pages.at(-1).complete, true);
});
test('cursors bind all run identity fields, query, options, policy and instructions', async t => {
  const f = await fixture(t, { 'a.txt': 'hit\nhit\nhit' }), input = { path: '.', query: 'hit', pageSize: 1 };
  const first = await f.search.search(input, context());
  for (const field of ['sessionId', 'conversationId', 'runId', 'requestId', 'workerGeneration']) {
    const identity = { ...baseIdentity, [field]: field === 'workerGeneration' ? 2 : 'other' };
    await assert.rejects(f.search.search({ ...input, cursor: first.nextCursor }, context({ identity })), { code: 'cursor_binding_changed' });
  }
  for (const extra of [{ policyRevision: 'new' }, { instructionDigest: 'new' }]) await assert.rejects(f.search.search({ ...input, cursor: first.nextCursor }, context(extra)), { code: 'cursor_binding_changed' });
  for (const extra of [{ query: 'hi' }, { pageSize: 2 }, { ignoreDirectories: ['generated'] }, { glob: '*.txt' }]) await assert.rejects(f.search.search({ ...input, ...extra, cursor: first.nextCursor }, context()), { code: 'cursor_binding_changed' });
  const another = new ProjectSearch({ projectRoot: f.root, ownerId: 'another' }); await assert.rejects(another.search({ ...input, cursor: first.nextCursor }, context()), { code: 'invalid_cursor' });
});
test('forged cursor offsets cannot skip or invent matches', async t => {
  const f = await fixture(t, { 'a.txt': 'hit\nhit' }), input = { path: '.', query: 'hit', pageSize: 1 };
  const first = await f.search.search(input, context()), parts = first.nextCursor.split('.'); parts[1] = '0';
  await assert.rejects(f.search.search({ ...input, cursor: parts.join('.') }, context()), { code: 'invalid_cursor' });
});
for (const change of ['content', 'new-file', 'delete-file', 'replace-directory', 'glob-excluded-instructions']) test(`cursor rejects ${change} after the scan`, async t => {
  const f = await fixture(t, { 'src/a.txt': 'hit\nhit', 'src/AGENTS.md': 'original rule' });
  const input = { path: 'src', query: 'hit', glob: '*.txt', pageSize: 1 }, first = await f.search.search(input, context());
  if (change === 'content') await f.write('src/a.txt', 'hit\nchanged');
  if (change === 'new-file') await f.write('src/new.txt', 'hit');
  if (change === 'delete-file') await fs.unlink(path.join(f.root, 'src/a.txt'));
  if (change === 'replace-directory') { await fs.rename(path.join(f.root, 'src'), path.join(f.root, 'old')); await f.write('src/a.txt', 'hit\nhit'); }
  if (change === 'glob-excluded-instructions') await f.write('src/AGENTS.md', 'new scoped rule');
  await assert.rejects(f.search.search({ ...input, cursor: first.nextCursor }, context()), { code: 'cursor_stale' });
});
test('scan entry truncation remains incomplete even when the observed last page is consumed', async t => {
  const f = await fixture(t, { 'a.txt': 'hit\nhit', 'b.txt': 'hit\nhit', 'c.txt': 'hit\nhit' }, { maxScanEntries: 1 });
  const input = { path: '.', query: 'hit', pageSize: 1 }; const first = await f.search.search(input, context());
  assert.equal(first.scanComplete, false); assert.ok(first.truncationReasons.includes('entry_limit')); assert.match(first.suggestion, /observed bounded snapshot/);
  const last = await f.search.search({ ...input, cursor: first.nextCursor }, context()); assert.equal(last.pageComplete, true); assert.equal(last.complete, false);
});
test('bounded cached matches report only observed totals and retain explicit incompleteness', async t => {
  const f = await fixture(t, { 'a.txt': 'hit\nhit\nhit' }, { maxCachedMatches: 2 });
  const input = { path: '.', query: 'hit', pageSize: 1 }, first = await f.search.search(input, context());
  assert.equal(first.totalMatches, 2); assert.ok(first.truncationReasons.includes('match_limit'));
  const last = await f.search.search({ ...input, cursor: first.nextCursor }, context()); assert.equal(last.complete, false);
});
test('invalid encoding and binary reads consume the shared byte budget', async t => {
  const f = await fixture(t, { 'a.bin': Buffer.alloc(64, 0), 'b.txt': Buffer.alloc(64, 255), 'c.txt': 'hit' }, { maxScanBytes: 128 });
  const page = await f.search.search({ path: '.', query: 'hit' }, context());
  assert.equal(page.scanned.bytes, 128); assert.equal(page.totalMatches, 0); assert.equal(page.complete, false);
  for (const reason of ['binary_file', 'invalid_encoding', 'scan_byte_limit']) assert.ok(page.truncationReasons.includes(reason), reason);
});
test('oversized file omission is visible for content search but not filename discovery', async t => {
  const f = await fixture(t, { 'large.txt': 'hit'.repeat(100) }, { maxFileBytes: 32 });
  const text = await f.search.search({ path: '.', query: 'hit' }, context()); assert.ok(text.truncationReasons.includes('file_byte_limit')); assert.equal(text.complete, false);
  const names = await f.search.search({ path: '.', mode: 'files' }, context()); assert.equal(names.complete, true); assert.equal(names.totalMatches, 1);
});
test('output budget shortens pages with an explicit reason and a safe continuation cursor', async t => {
  const f = await fixture(t, { 'a.txt': Array(10).fill('hit' + 'x'.repeat(450)).join('\n') }), input = { path: '.', query: 'hit', pageSize: 10 };
  const first = await f.search.search(input, context({ maxOutputBytes: 1800 })); assert.ok(first.matches.length < 10); assert.ok(first.truncationReasons.includes('output_byte_limit')); assert.equal(first.truncationReasons.includes('page_limit'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 1800); assert.ok(first.nextCursor);
  const second = await f.search.search({ ...input, cursor: first.nextCursor }, context({ maxOutputBytes: 64 * 1024 })); assert.equal(second.matches[0].line, first.matches.length + 1);
});
test('unrepresentable page metadata fails explicitly instead of emitting a zero-progress cursor', async t => {
  const f = await fixture(t, { 'a.txt': 'hit'.repeat(200) });
  await assert.rejects(f.search.search({ path: '.', query: 'hit' }, context({ maxOutputBytes: 512 })), { code: 'output_budget_exceeded' });
});
test('snapshot cache eviction expires old cursors without silently rescanning', async t => {
  const f = await fixture(t, { 'a.txt': 'hit\nhit' }), input = { path: '.', query: 'hit', pageSize: 1 };
  const first = await f.search.search(input, context());
  for (let index = 0; index < 4; index++) await f.search.search(input, context());
  await assert.rejects(f.search.search({ ...input, cursor: first.nextCursor }, context()), { code: 'cursor_expired' });
});
test('regex syntax validation, multiline line numbering and fixed case flags', async t => {
  const f = await fixture(t, { 'a.txt': 'zero\r\nBeta\r\nBETA\n' });
  await assert.rejects(f.search.validate({ path: '.', query: '[', mode: 'regex' }), { code: 'invalid_regex' });
  await f.search.validate({ path: '.', query: '^Beta\\r?$', mode: 'regex' });
  const page = await f.search.search({ path: '.', query: '^beta\\r?$', mode: 'regex', caseSensitive: false }, context());
  assert.deepEqual(page.matches.map(hit => hit.line), [2, 3]); assert.equal(page.complete, true);
});
test('pathological regex is terminated by a real worker deadline without blocking host timers', async t => {
  const f = await fixture(t, { 'a.txt': 'a'.repeat(30000) + '!' }, { maxRegexMs: 30 });
  let ticks = 0; const timer = setInterval(() => { ticks++; }, 5); const started = performance.now();
  try {
    const result = await f.search.search({ path: '.', query: '(a+)+$', mode: 'regex' }, context());
    assert.ok(result.truncationReasons.includes('regex_timeout')); assert.equal(result.complete, false); assert.ok(ticks > 0); assert.ok(performance.now() - started < 3000);
  } finally { clearInterval(timer); }
});
test('regex cancellation waits for actual worker exit before rejecting', async () => {
  const controller = new AbortController(); const worker = await BoundedRegex.create('(a+)+$', true, 1000, controller.signal);
  const pending = worker.match('a'.repeat(30000) + '!', 10, 2000, controller.signal);
  const timer = setTimeout(() => controller.abort(), 25);
  try { await assert.rejects(pending, { code: 'search_cancelled' }); assert.equal(worker.worker.threadId, -1); }
  finally { clearTimeout(timer); await worker.close(); }
});
test('pre-cancelled search and unsafe/unsupported syntax never scan', async t => {
  const f = await fixture(t, { 'a.txt': 'hit' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.search.search({ path: '.', query: 'hit' }, context({ signal: controller.signal })));
  for (const input of [{ path: '../', query: 'hit' }, { path: '.', query: 'x', glob: '{a,b}' }, { path: '.', query: 'x', glob: 'a**b' }, { path: '.', query: 'x', ignoreDirectories: ['**/cache'] }, { path: '.', query: 'x', unexpected: true }, { path: '.', mode: 'files', query: 'x' }]) assert.throws(() => validateProjectSearchInput(input));
});

test('a file growing to invalid text between observation and read cannot exceed reserved I/O bytes', async t => {
  const f = await fixture(t, { 'a.txt': 'x', 'b.txt': 'y' }, { maxScanBytes: 1 });
  const originalRead = f.search.files.read.bind(f.search.files);
  f.search.files.read = async (relative, signal, maximumBytes) => {
    assert.equal(maximumBytes, 1);
    await f.write(relative, Buffer.alloc(1024 * 1024, 255));
    return originalRead(relative, signal, maximumBytes);
  };
  const originalOpen = fs.open; let actualBytes = 0;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args), read = handle.read.bind(handle);
    handle.read = async (...readArgs) => { const result = await read(...readArgs); actualBytes += result.bytesRead; return result; };
    return handle;
  };
  try {
    const result = await f.search.search({ path: '.', query: 'x' }, context());
    assert.equal(actualBytes, 0, 'the changed size is refused before any file content read');
    assert.equal(result.scanned.bytes, 1); assert.equal(result.complete, false);
    assert.ok(result.truncationReasons.includes('file_byte_limit')); assert.ok(result.truncationReasons.includes('scan_byte_limit'));
  } finally { fs.open = originalOpen; }
});

test('zero-byte files remain searchable with a zero-byte per-read reservation', async t => {
  const f = await fixture(t, { 'empty.txt': '' }, { maxScanBytes: 1 });
  const result = await f.search.search({ path: '.', query: '^$', mode: 'regex' }, context());
  assert.equal(result.complete, true); assert.equal(result.matches.length, 1); assert.equal(result.scanned.bytes, 0); assert.equal(result.matches[0].hash, hash(''));
});

test('multi-directory pagination conserves an independently known 150-file result set', async t => {
  const contents = {};
  for (let directory = 0; directory < 3; directory++) for (let index = 0; index < 50; index++) contents[`module-${directory}/file-${String(index).padStart(2, '0')}.ts`] = `needle:${directory}:${index}\n`;
  const f = await fixture(t, contents), expected = new Map(Object.entries(contents).map(([file, text]) => [file, hash(text)]));
  const input = { path: '.', query: 'needle:', pageSize: 17 };
  const collect = async search => {
    const seen = new Map(); let page = await search.search(input, context());
    while (true) {
      for (const hit of page.matches) {
        assert.equal(seen.has(hit.path), false, 'each observed file appears exactly once');
        assert.equal(hit.hash, expected.get(hit.path)); seen.set(hit.path, hit.hash);
      }
      if (!page.nextCursor) return { seen, page };
      assert.equal(page.complete, false);
      page = await search.search({ ...input, cursor: page.nextCursor }, context());
    }
  };
  const full = await collect(f.search);
  assert.deepEqual([...full.seen].sort(), [...expected].sort()); assert.equal(full.page.totalMatches, 150); assert.equal(full.page.complete, true);
  const limited = await collect(new ProjectSearch({ projectRoot: f.root, ownerId: 'limited', maxScanEntries: 70 }));
  assert.ok(limited.seen.size > 0 && limited.seen.size < expected.size); assert.equal(limited.page.scanComplete, false);
  assert.equal(limited.page.pageComplete, true); assert.equal(limited.page.complete, false); assert.ok(limited.page.truncationReasons.includes('entry_limit'));
});
