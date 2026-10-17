import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkillMetadata, extractSkillBody, SKILL_METADATA_MAX_HEADER_BYTES, SKILL_METADATA_MAX_FILE_BYTES } from '../dist/skill-metadata.js';

const standard = (header = '', body = 'Review the actual project.\n') => `---\nname: review\ndescription: Review project code and report concrete findings.\n${header}---\n${body}`;
const issue = (result, code) => result.diagnostics.some(item => item.code === code);
const invalid = result => {
  assert.equal(result.format, 'invalid');
  assert.equal(result.autoMatchable, false);
  assert.ok(result.diagnostics.some(item => item.severity === 'error'));
};

test('standard metadata is inert structured data and preserves the exact body', () => {
  const content = standard('license: MIT\ncompatibility: Requires Node.js 22.\nmetadata:\n  author: Example\n  version: "1"\n');
  const result = parseSkillMetadata(content, { directoryName: 'review' });
  assert.equal(result.format, 'standard');
  assert.equal(result.name, 'review');
  assert.equal(result.autoMatchable, true);
  assert.equal(result.description, 'Review project code and report concrete findings.');
  assert.equal(result.license, 'MIT');
  assert.equal(result.compatibility, 'Requires Node.js 22.');
  assert.deepEqual(result.metadata, { author: 'Example', version: '1' });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(extractSkillBody(content), 'Review the actual project.\n');
});

test('legacy guides remain explicit-only, retain their directory label and are not reinterpreted', () => {
  for (const content of ['', 'Follow this guide.\n', '\ufeff旧版说明\r\n@other.md\r\n', '# Review\n---\nname: pretend\n---\n']) {
    const result = parseSkillMetadata(content, { directoryName: '旧版 Review' });
    assert.equal(result.format, 'legacy');
    assert.equal(result.name, '旧版 Review');
    assert.equal(result.description, '');
    assert.equal(result.headerBytes, 0);
    assert.equal(result.autoMatchable, false);
    assert.ok(issue(result, 'legacy_format'));
    assert.equal(extractSkillBody(content), content);
  }
});

test('BOM, CRLF and Chinese metadata/body work without normalizing the body', () => {
  const content = '\ufeff---\r\nname: review\r\ndescription: 检查代码并提供发现。\r\nmetadata:\r\n  语言: 中文\r\n---\r\n中文正文\r\n第二行\r\n';
  const result = parseSkillMetadata(content, { directoryName: 'review' });
  assert.equal(result.format, 'standard');
  assert.equal(result.description, '检查代码并提供发现。');
  assert.deepEqual(result.metadata, { 语言: '中文' });
  assert.equal(result.headerBytes, Buffer.byteLength(content.slice(0, content.indexOf('中文正文'))));
  assert.equal(extractSkillBody(content), '中文正文\r\n第二行\r\n');
});

test('complete metadata from a bounded prefix equals a complete-file parse', () => {
  const content = standard('metadata:\n  author: Example\n', 'X'.repeat(12000));
  const prefix = content.slice(0, 8192);
  assert.deepEqual(parseSkillMetadata(prefix, { directoryName: 'review', headerComplete: false }), parseSkillMetadata(content, { directoryName: 'review' }));
});

test('missing frontmatter closing delimiter never falls back to legacy', () => {
  const content = '---\nname: review\ndescription: Review code.\n';
  const complete = parseSkillMetadata(content);
  invalid(complete);
  assert.ok(issue(complete, 'frontmatter_unclosed'));
  const prefix = parseSkillMetadata(content, { headerComplete: false });
  invalid(prefix);
  assert.ok(issue(prefix, 'frontmatter_limit'));
  assert.equal(parseSkillMetadata('Plain guide', { headerComplete: false }).format, 'legacy');
  invalid(parseSkillMetadata('---'));
  assert.throws(() => extractSkillBody(content), /invalid/);
});

test('truncated prefixes cannot invent a closing delimiter at the byte boundary', () => {
  const leading = '---\nname: review\ndescription: Local review.\n#';
  const content = leading + 'x'.repeat(8192 - Buffer.byteLength(leading) - 4) + '\n---not-a-delimiter\nbody';
  const prefix = Buffer.from(content).subarray(0, 8192).toString('utf8');
  assert.ok(prefix.endsWith('\n---'));
  const partial = parseSkillMetadata(prefix, { directoryName: 'review', headerComplete: false });
  invalid(partial);
  assert.ok(issue(partial, 'frontmatter_limit'));
  invalid(parseSkillMetadata(content, { directoryName: 'review' }));

  const complete = standard('', '').trimEnd();
  assert.ok(complete.endsWith('\n---'));
  assert.equal(parseSkillMetadata(complete).format, 'standard');
  invalid(parseSkillMetadata(complete, { headerComplete: false }));
  assert.equal(parseSkillMetadata(complete + '\n', { headerComplete: false }).format, 'standard');
  invalid(parseSkillMetadata(complete + '\r', { headerComplete: false }));
});

test('frontmatter boundary counts UTF-8 bytes and includes delimiter lines', () => {
  const leading = '---\nname: review\ndescription: Review code.\n#';
  const closing = '\n---\n';
  const padding = 'x'.repeat(SKILL_METADATA_MAX_HEADER_BYTES - Buffer.byteLength(leading + closing));
  const accepted = parseSkillMetadata(leading + padding + closing + 'Body.');
  assert.equal(accepted.format, 'standard');
  assert.equal(accepted.headerBytes, SKILL_METADATA_MAX_HEADER_BYTES);
  const rejected = parseSkillMetadata(leading + padding + 'x' + closing);
  invalid(rejected);
  assert.ok(issue(rejected, 'frontmatter_limit'));
  const chinese = parseSkillMetadata(leading + '中'.repeat(2800) + closing);
  invalid(chinese);
  assert.ok(issue(chinese, 'frontmatter_limit'));
});

test('complete files have an independent 32 KiB limit without silent body truncation', () => {
  const header = standard('', '');
  const body = 'x'.repeat(SKILL_METADATA_MAX_FILE_BYTES - Buffer.byteLength(header));
  assert.equal(parseSkillMetadata(header + body).format, 'standard');
  const tooLarge = parseSkillMetadata(header + body + 'x');
  invalid(tooLarge);
  assert.ok(issue(tooLarge, 'file_limit'));
  assert.throws(() => extractSkillBody(header + body + 'x'), /invalid/);
  invalid(parseSkillMetadata('x'.repeat(SKILL_METADATA_MAX_FILE_BYTES + 1)));
});

test('invalid YAML and duplicate keys are refused with bounded non-content diagnostics', () => {
  for (const header of [
    'name: again\n',
    'metadata:\n  author: one\n  author: two\n',
    'unknown: [unterminated\n',
    'name: !!js/function function () { globalThis.SKILL_EXECUTED = true; }\n',
    'unknown: !custom RUN_SECRET_SENTINEL\n',
  ]) {
    const result = parseSkillMetadata(standard(header));
    invalid(result);
    assert.doesNotMatch(JSON.stringify(result.diagnostics), /RUN_SECRET_SENTINEL|globalThis|unterminated/);
  }
  assert.equal(globalThis.SKILL_EXECUTED, undefined);
});

test('anchors, ordinary aliases, cyclic aliases and alias expansion are all refused', () => {
  for (const header of [
    'unknown: &anchor ordinary\n',
    'one: &anchor [one, two]\ntwo: *anchor\n',
    'unknown: &cycle [*cycle]\n',
    'unknown: *notDeclared\n',
    'one: &a [one, two]\ntwo: &b [*a, *a, *a, *a]\nthree: [*b, *b, *b, *b]\n',
  ]) invalid(parseSkillMetadata(standard(header)));
});

test('deep collections, many fields and many values cannot become retained metadata', () => {
  invalid(parseSkillMetadata(standard(`unknown: ${'['.repeat(1200)}0${']'.repeat(1200)}\n`)));
  const fields = Array.from({ length: 65 }, (_, index) => `extra${index}: value`).join('\n') + '\n';
  const tooManyFields = parseSkillMetadata(standard(fields));
  invalid(tooManyFields);
  assert.ok(issue(tooManyFields, 'metadata_fields'));
  invalid(parseSkillMetadata(standard(`unknown: [${Array(520).fill('0').join(',')}]\n`)));
});

test('dangerous mapping and YAML merge keys are refused at every depth', () => {
  for (const header of [
    '__proto__: {polluted: true}\n', 'constructor: value\n', 'unknown: {prototype: value}\n',
    'metadata: {__proto__: value}\n', 'unknown: {"<<": {one: value}}\n',
  ]) invalid(parseSkillMetadata(standard(header)));
  assert.equal({}.polluted, undefined);
});

test('name format, directory identity and required nonempty description are validated', () => {
  for (const name of ['Review', '-review', 'review-', 'review--code', 'review_code', 'a'.repeat(65), '中文']) {
    invalid(parseSkillMetadata(`---\nname: ${name}\ndescription: Review code.\n---\n`));
  }
  for (const description of ['', '"   "', 'null', 'false', '42', 'x'.repeat(1025)]) {
    invalid(parseSkillMetadata(`---\nname: review\ndescription: ${description}\n---\n`));
  }
  const mismatch = parseSkillMetadata(standard(), { directoryName: 'other' });
  invalid(mismatch);
  assert.ok(issue(mismatch, 'invalid_directory_name'));
  invalid(parseSkillMetadata('---\ndescription: Has no name.\n---\n'));
  invalid(parseSkillMetadata('---\nname: review\n---\n'));
});

test('folded multiline descriptions use the YAML parser while body separators stay literal', () => {
  const content = '---\nname: review\ndescription: >-\n  Review project code\n  and report findings.\n---\nBody\n---\nMore body\n';
  assert.equal(parseSkillMetadata(content).description, 'Review project code and report findings.');
  assert.equal(extractSkillBody(content), 'Body\n---\nMore body\n');
});

test('optional standard fields remain bounded strings and metadata values are not coerced', () => {
  for (const header of ['license: false\n', 'compatibility: 123\n', `compatibility: ${'x'.repeat(501)}\n`,
    'metadata: [one, two]\n', 'metadata: {version: 1}\n', 'metadata: {enabled: true}\n', 'metadata: {nested: {one: value}}\n',
    'allowed-tools: [run_command]\n']) invalid(parseSkillMetadata(standard(header)));
  assert.equal(parseSkillMetadata(standard('metadata: {}\n')).format, 'standard');
});

test('allowed-tools and unknown private fields never become executable settings', () => {
  const result = parseSkillMetadata(standard('allowed-tools: Bash Read\nhooks:\n  before: "throw new Error(\\\"DO_NOT_RUN\\\")"\nmodel: arbitrary-model\ncustom: [true, null, 7]\n'));
  assert.equal(result.format, 'standard');
  assert.equal(result.autoMatchable, true);
  assert.equal(result.allowedTools, 'Bash Read');
  assert.ok(issue(result, 'allowed_tools_inert'));
  assert.ok(issue(result, 'unsupported_fields'));
  assert.deepEqual(result.unknownFields.custom, [true, null, 7]);
  assert.equal(result.unknownFields.model, 'arbitrary-model');
  assert.equal(typeof result.unknownFields.hooks.before, 'string');
  assert.equal(Object.hasOwn(result, 'toolPolicy'), false);
  assert.equal(Object.hasOwn(result, 'hooks'), false);
});

test('unknown field retention is bounded independently of the full header budget', () => {
  const result = parseSkillMetadata(standard(`unknown: ${'x'.repeat(4200)}\n`));
  invalid(result);
  assert.ok(issue(result, 'invalid_unknown_fields'));
  assert.equal(result.unknownFields, undefined);
});

test('only JSON-schema YAML types are retained; non-finite values and non-mapping headers fail', () => {
  const result = parseSkillMetadata(standard('unknown: 2026-10-17\ncustom: yes\n'));
  assert.equal(result.format, 'standard');
  assert.deepEqual(result.unknownFields, { unknown: '2026-10-17', custom: 'yes' });
  invalid(parseSkillMetadata(standard('unknown: .inf\n')));
  invalid(parseSkillMetadata('---\n[one, two]\n---\n'));
  invalid(parseSkillMetadata('---\nnull\n---\n'));
  invalid(parseSkillMetadata('---\n---\n'));
});

test('binary text and invalid runtime input fail without throwing or serializing input', () => {
  invalid(parseSkillMetadata('Legacy\0binary'));
  for (const value of [null, 1, {}, undefined]) {
    const result = parseSkillMetadata(value);
    invalid(result);
    assert.ok(issue(result, 'input_type'));
  }
});
