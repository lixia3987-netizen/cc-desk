import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EngineConfig } from '../src/shared/execution';
import { LegacyClaudeOverrides } from '../src/renderer/components/LegacyClaudeOverrides';

test('CLI-owned model configuration exposes no editor when there is no legacy override', () => {
  const config: EngineConfig = { schemaVersion: 1, options: { model: '', effort: 'default', permissionMode: 'plan' } };
  assert.equal(renderToStaticMarkup(createElement(LegacyClaudeOverrides, { config, disabled: false, onChange: () => assert.fail() })), '');
});

test('explicitly clearing legacy CLI overrides preserves permissions and unknown fields without mutating the original', () => {
  const config: EngineConfig = { schemaVersion: 1, options: { model: 'old-model', effort: 'ultracode', permissionMode: 'plan', extra: ['keep', 1] } };
  let changed: EngineConfig | undefined;
  const tree = LegacyClaudeOverrides({ config, disabled: false, onChange: next => { changed = next; } })!;
  const children = tree.props.children as ReactElement<{ onClick?: () => void; disabled?: boolean }>[];
  const button = children.find(child => child.type === 'button')!;
  assert.equal(button.props.disabled, false); button.props.onClick!();
  assert.deepEqual(changed, { schemaVersion: 1, options: { model: '', effort: 'default', permissionMode: 'plan', extra: ['keep', 1] } });
  assert.equal(config.options.model, 'old-model'); assert.equal(config.options.effort, 'ultracode');
  const disabled = renderToStaticMarkup(createElement(LegacyClaudeOverrides, { config, disabled: true, onChange: () => assert.fail() }));
  assert.match(disabled, /disabled=""/); assert.doesNotMatch(disabled, /<input|<select/);
});
