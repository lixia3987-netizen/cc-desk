import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readInspectorOpenPanels, saveInspectorOpenPanels, readInspectorWidth, saveInspectorWidth } from '../src/renderer/layout-preferences';

const selectedKey = 'cc-desk.inspector-selected-panel', openKey = 'cc-desk.inspector-open-panels', activeKey = 'cc-desk.inspector-active-panel';
const legacyOpen = 'cc-desk.inspector-open', legacyPanels = 'cc-desk.inspector-panels';
const storage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};

test('legacy multiple tools migrate to the last valid opened tool', () => {
  const value = storage({ [openKey]: JSON.stringify(['diagnostics', 'git', 'unknown', 'context', 'git', null, 'workflows', 7]) });
  assert.deepEqual(readInspectorOpenPanels(value), ['workflows']);
  saveInspectorOpenPanels(['workflows', 'context', 'git'], value);
  assert.equal(value.getItem(selectedKey), '"git"');
  assert.deepEqual(readInspectorOpenPanels(value), ['git']);
});

test('new selected tool overrides older formats including explicit closed state', () => {
  const value = storage({
    [activeKey]: '"diagnostics"', [legacyOpen]: 'false',
    [legacyPanels]: JSON.stringify({ open: ['git', 'context'], collapsed: [] }),
  });
  saveInspectorOpenPanels(['workflows', 'git'], value);
  assert.deepEqual(readInspectorOpenPanels(value), ['git']);
  saveInspectorOpenPanels([], value);
  assert.equal(value.getItem(selectedKey), 'null');
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
  }) })), ['workflows']);
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


test('detail width is bounded, persisted independently and tolerates missing storage', () => {
  const value = storage();
  assert.equal(readInspectorWidth(value), 340);
  saveInspectorWidth(420, value); assert.equal(readInspectorWidth(value), 420);
  saveInspectorWidth(999, value); assert.equal(readInspectorWidth(value), 560);
  saveInspectorWidth(-3, value); assert.equal(readInspectorWidth(value), 260);
  saveInspectorWidth(Number.NaN, value); assert.equal(readInspectorWidth(value), 340);
  assert.equal(readInspectorWidth({ getItem() { throw new Error('unavailable'); } }), 340);
});
