import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AttentionCenter } from '../src/renderer/AttentionCenter';

test('attention center leaves the count unknown until the first successful read', () => {
  // Initial rendering must neither report an empty inbox nor invoke navigation.
  const markup=renderToStaticMarkup(createElement(AttentionCenter, { sessions: [], projects: [], onOpen() { throw new Error('Unexpected initial navigation'); } }));
  assert.match(markup, /待处理 <span aria-live="polite">…<\/span>/);
  assert.doesNotMatch(markup, /暂无待处理请求|aria-live="polite">0<\/span>/);
  assert.match(markup, /查看所有会话的工具审批与提问/);
});
