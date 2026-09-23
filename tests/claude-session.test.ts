import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { contextCapacity, insertCommand, matchingCommands, normalizeCommands, reportedContext, requestContext, slashQuery } from '../src/shared/claude-session';
import { ContextMeter } from '../src/renderer/ContextMeter';

test('context counts the latest input plus both cache components without accumulating requests or guessing capacity', () => {
  const first = requestContext(undefined, { input_tokens: 100, cache_read_input_tokens: 30000, cache_creation_input_tokens: 5000, output_tokens: 9999 }, 'main', 'first');
  assert.equal(first?.inputTokens, 35100);
  const next = requestContext({ ...first!, contextWindow: 200000 }, { input_tokens: 20, cache_read_input_tokens: 1000 }, 'main', 'second');
  assert.equal(next?.inputTokens, 1020); assert.equal(next?.contextWindow, 200000);
  assert.equal(requestContext(next, { input_tokens: 30 }, 'other', 'third')?.contextWindow, undefined);
  for (const input_tokens of [undefined, -1, NaN, Infinity, '120', 1.5]) assert.equal(requestContext(next, { input_tokens }, 'main', ''), undefined);
  assert.equal(requestContext(next, { input_tokens: 2, cache_read_input_tokens: -1 }, 'main', ''), undefined);
  assert.equal(contextCapacity({ child: { contextWindow: 999999 } }, 'main'), undefined);
  assert.equal(contextCapacity({ main: { contextWindow: 200000, inputTokens: 800000 } }, 'main'), 200000);
  assert.equal(contextCapacity({ alias: { contextWindow: 1000000, canonicalModel: 'main' } }, 'main'), 1000000);
  assert.equal(contextCapacity({ main: { contextWindow: 0 } }, 'main'), undefined);
  assert.equal(reportedContext({ total_tokens: 32000, raw_max_tokens: 200000, model: 'main' }, next, 'report')?.source, 'context-command');
});

test('command catalogs preserve CLI metadata, custom overrides, aliases and replace removed skills', () => {
  const initial = normalizeCommands([
    { name: 'compact', builtin: true, description: '压缩上下文', argumentHint: '[保留内容]' },
    { name: 'team:review', description: '检查代码', aliases: ['review'] },
    { name: 'resume', builtin: true }, { name: 'bad\ncommand' }, 'path/to/file',
  ], [], ['team:review']);
  assert.equal(initial.length, 3); assert.equal(initial[0].kind, 'builtin'); assert.equal(initial[1].kind, 'skill');
  assert.match(initial[2].disabledReason!, /工作台/);
  const update = normalizeCommands(['compact', 'team:review'], initial, ['team:review']);
  assert.equal(update[0].description, '压缩上下文'); assert.equal(update[0].argumentHint, '[保留内容]');
  assert.equal(matchingCommands(update, 'review')[0].name, 'team:review');
  assert.equal(matchingCommands(update, '压缩')[0].name, 'compact');
  assert.equal(normalizeCommands([{ name: 'resume', builtin: false }], initial)[0].disabledReason, undefined);
  // Current CLI omits builtin entirely for a skill shadowing a built-in name.
  assert.equal(normalizeCommands([{ name: 'resume', description: '自定义 Skill' }], initial)[0].kind, 'skill');
  assert.equal(normalizeCommands(['compact'], initial).length, 1);
});

test('slash completion triggers only in a leading command, preserves arguments and leaves paths/prose alone', () => {
  assert.equal(slashQuery('/', 1, 1), '');
  assert.equal(slashQuery(' /team:r 参数', 8, 8), 'team:r');
  for (const [value, caret] of [['解释 /compact', 11], ['/tmp/file', 9], ['/compact 参数', 11], ['https://example.com', 19]] as const) assert.equal(slashQuery(value, caret, caret), undefined);
  assert.equal(slashQuery('/com', 1, 4), undefined);
  assert.deepEqual(insertCommand('/com 保留测试结论', 'compact'), { value: '/compact 保留测试结论', caret: 9 });
  assert.deepEqual(insertCommand('/team:r', 'team:review'), { value: '/team:review ', caret: 13 });
});

test('context UI distinguishes missing data, real zero, over-limit and post-compaction unknown usage', () => {
  const render = (context?: Parameters<typeof ContextMeter>[0]['context']) => renderToStaticMarkup(createElement(ContextMeter, { context }));
  assert.match(render(), /等待用量数据/); assert.doesNotMatch(render(), /aria-valuenow/);
  const ready = { status: 'ready' as const, inputTokens: 0, contextWindow: 200000 };
  assert.match(render(ready), /0\.0%/); assert.match(render({ ...ready, inputTokens: 210000 }), /105\.0%/);
  assert.match(render({ ...ready, status: 'compacted', inputTokens: undefined }), /已压缩/);
  assert.doesNotMatch(render({ ...ready, contextWindow: undefined }), /aria-valuenow/);
});
