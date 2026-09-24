import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readInspectorOpenPanels, saveInspectorOpenPanels } from '../src/renderer/layout-preferences';

const openKey = 'cc-desk.inspector-open-panels', activeKey = 'cc-desk.inspector-active-panel';
const legacyOpen = 'cc-desk.inspector-open', legacyPanels = 'cc-desk.inspector-panels';
const storage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};

test('multiple tool windows preserve opening order and remove duplicate or unknown panel IDs', () => {
  const value = storage({ [openKey]: JSON.stringify(['diagnostics', 'git', 'unknown', 'context', 'git', null, 'workflows', 7]) });
  assert.deepEqual(readInspectorOpenPanels(value), ['diagnostics', 'git', 'context', 'workflows']);
  saveInspectorOpenPanels(['workflows', 'context', 'git'], value);
  assert.equal(value.getItem(openKey), '["workflows","context","git"]');
  assert.deepEqual(readInspectorOpenPanels(value), ['workflows', 'context', 'git']);
});

test('new multi-panel preferences override all older formats, including explicit all-closed state', () => {
  const value = storage({
    [activeKey]: '"diagnostics"', [legacyOpen]: 'false',
    [legacyPanels]: JSON.stringify({ open: ['git', 'context'], collapsed: [] }),
  });
  saveInspectorOpenPanels(['workflows', 'git'], value);
  assert.deepEqual(readInspectorOpenPanels(value), ['workflows', 'git']);
  saveInspectorOpenPanels([], value);
  assert.equal(value.getItem(openKey), '[]');
  assert.deepEqual(readInspectorOpenPanels(value), []);
  assert.equal(value.getItem(activeKey), '"diagnostics"');
  assert.equal(value.getItem(legacyOpen), 'false');
  assert.equal(value.getItem(legacyPanels), '{"open":["git","context"],"collapsed":[]}');
});

test('single-tool preferences migrate before older global and multi-panel settings', () => {
  const value = storage({ [activeKey]: '"diagnostics"', [legacyOpen]: 'false', [legacyPanels]: JSON.stringify({ open: ['git', 'context'], collapsed: [] }) });
  assert.deepEqual(readInspectorOpenPanels(value), ['diagnostics']);
  value.setItem(activeKey, 'null');
  assert.deepEqual(readInspectorOpenPanels(value), []);
});

test('legacy multi-panel migration retains opening order while excluding collapsed and invalid tools', () => {
  assert.deepEqual(readInspectorOpenPanels(storage({ [legacyPanels]: JSON.stringify({
    open: ['diagnostics', 'unknown', 'workflows', 'git', 'diagnostics', 'context'], collapsed: ['git', 'context', 'unknown'],
  }) })), ['diagnostics', 'workflows']);
  assert.deepEqual(readInspectorOpenPanels(storage({ [legacyPanels]: JSON.stringify({ open: ['git'], collapsed: [] }) })), ['git']);
});

test('legacy hidden layouts remain closed after migration', () => {
  const cases: Record<string, string>[] = [
    { [legacyOpen]: 'false', [legacyPanels]: JSON.stringify({ open: ['context', 'git', 'workflows', 'diagnostics'], collapsed: [] }) },
    { [legacyPanels]: JSON.stringify({ open: [], collapsed: [] }) },
    { [legacyPanels]: JSON.stringify({ open: ['context', 'workflows'], collapsed: ['context', 'workflows'] }) },
  ];
  for (const initial of cases) assert.deepEqual(readInspectorOpenPanels(storage(initial)), []);
});

test('corrupt preferences fall back to valid older layouts or the default context tool', () => {
  const damaged: Record<string, string>[] = [
    {},
    { [openKey]: '{broken', [activeKey]: 'false', [legacyPanels]: '{broken' },
    { [openKey]: 'null', [activeKey]: '"unknown"', [legacyPanels]: JSON.stringify({ open: 'git', collapsed: [] }) },
    { [openKey]: '"git"', [activeKey]: '["git"]', [legacyPanels]: JSON.stringify({ open: ['git'], collapsed: false }) },
  ];
  for (const initial of damaged) assert.deepEqual(readInspectorOpenPanels(storage(initial)), ['context']);
  assert.deepEqual(readInspectorOpenPanels(storage({ [openKey]: '{broken', [activeKey]: '"git"' })), ['git']);
  assert.deepEqual(readInspectorOpenPanels(storage({ [openKey]: 'false', [activeKey]: '{broken', [legacyOpen]: 'false' })), []);
  assert.deepEqual(readInspectorOpenPanels(storage({ [openKey]: '{}', [activeKey]: '"unknown"', [legacyPanels]: JSON.stringify({ open: ['workflows'], collapsed: [] }) })), ['workflows']);
});

test('storage failures do not prevent tool windows from opening and closing', () => {
  assert.deepEqual(readInspectorOpenPanels({ getItem() { throw new Error('Storage unavailable'); } }), ['context']);
  assert.doesNotThrow(() => saveInspectorOpenPanels([], { setItem() { throw new Error('Quota exceeded'); } }));
});
