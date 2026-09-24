import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readInspectorActivePanel, saveInspectorActivePanel } from '../src/renderer/layout-preferences';

const activeKey = 'cc-desk.inspector-active-panel', legacyOpen = 'cc-desk.inspector-open', legacyPanels = 'cc-desk.inspector-panels';
const storage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};

test('tool-window migration preserves all former ways to hide panel contents', () => {
  const cases: Record<string, string>[] = [
    { [legacyOpen]: 'false', [legacyPanels]: JSON.stringify({ open: ['context', 'git', 'workflows', 'diagnostics'], collapsed: [] }) },
    { [legacyPanels]: JSON.stringify({ open: [], collapsed: [] }) },
    { [legacyPanels]: JSON.stringify({ open: ['context', 'workflows'], collapsed: ['context', 'workflows'] }) },
  ];
  for (const initial of cases) assert.equal(readInspectorActivePanel(storage(initial)), null);
});

test('tool-window migration selects one formerly visible tool in stable rail order', () => {
  assert.equal(readInspectorActivePanel(storage({ [legacyPanels]: JSON.stringify({ open: ['diagnostics', 'workflows', 'git', 'context'], collapsed: ['context', 'git'] }) })), 'workflows');
  assert.equal(readInspectorActivePanel(storage({ [legacyPanels]: JSON.stringify({ open: ['git'], collapsed: [] }) })), 'git');
  assert.equal(readInspectorActivePanel(storage({ [legacyPanels]: JSON.stringify({ open: ['unknown', 'diagnostics', 'diagnostics'], collapsed: ['unknown'] }) })), 'diagnostics');
});

test('explicit single-tool preferences override legacy global and multi-panel settings, including persisted null', () => {
  const value = storage({ [legacyOpen]: 'false', [legacyPanels]: JSON.stringify({ open: ['context', 'git'], collapsed: [] }) });
  saveInspectorActivePanel('diagnostics', value);
  assert.equal(value.getItem(activeKey), '"diagnostics"');
  assert.equal(readInspectorActivePanel(value), 'diagnostics');
  saveInspectorActivePanel(null, value);
  assert.equal(value.getItem(activeKey), 'null');
  assert.equal(readInspectorActivePanel(value), null);
  assert.equal(value.getItem(legacyOpen), 'false');
});

test('fresh and damaged layout preferences remain usable without reviving a valid hidden legacy layout', () => {
  assert.equal(readInspectorActivePanel(storage()), 'context');
  assert.equal(readInspectorActivePanel(storage({ [activeKey]: '{broken', [legacyOpen]: 'false' })), null);
  assert.equal(readInspectorActivePanel(storage({ [activeKey]: '"unknown"', [legacyPanels]: JSON.stringify({ open: ['git'], collapsed: [] }) })), 'git');
  assert.equal(readInspectorActivePanel(storage({ [activeKey]: 'false', [legacyPanels]: '{broken' })), 'context');
  assert.equal(readInspectorActivePanel(storage({ [legacyPanels]: JSON.stringify({ open: 'git', collapsed: [] }) })), 'context');
});

test('storage failures do not prevent tool windows from opening and closing', () => {
  assert.equal(readInspectorActivePanel({ getItem() { throw new Error('Storage unavailable'); } }), 'context');
  assert.doesNotThrow(() => saveInspectorActivePanel(null, { setItem() { throw new Error('Quota exceeded'); } }));
});
