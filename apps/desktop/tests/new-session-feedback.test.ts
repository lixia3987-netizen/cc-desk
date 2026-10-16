import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppState } from '../src/shared/types';
import type { ExecutionDescriptor } from '../src/shared/execution';

// SSR needs the real component, while its stylesheet has no server-side effects.
const require = createRequire(import.meta.url), previousCss = require.extensions['.css'];
require.extensions['.css'] = () => {};
let NewSessionForm: typeof import('../src/renderer/workspace/NewSessionForm').NewSessionForm;
try { ({ NewSessionForm } = require('../src/renderer/workspace/NewSessionForm')); }
finally { if (previousCss) require.extensions['.css'] = previousCss; else delete require.extensions['.css']; }

const unexpected = () => { throw new Error('Rendering feedback cannot dispatch an operation.'); };
const descriptor: ExecutionDescriptor = { providerId: 'claude', mode: 'structured', displayName: 'Claude Code',
  capabilities: { available: true, structured: true, terminal: false, approvals: true, resume: true, fork: true,
    commands: true, contextUsage: true, liveConfig: false, attachments: true },
  configuration: { schemaVersion: 1, defaults: { schemaVersion: 1, options: {} }, fields: [] } };
const state: AppState = { version: 3, projects: [{ id: 'project', name: 'Project', path: '/tmp/project', createdAt: '2026-10-16T00:00:00Z' }], sessions: [],
  settings: { claudePath: '', shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000, engineDefaults: {} } };
const props: ComponentProps<typeof NewSessionForm> = { state, executors: [descriptor],
  draft: { projectId: 'project', title: '', kind: 'agent', mode: 'structured', providerId: 'claude', isolated: false, engineConfig: { schemaVersion: 1, options: {} } },
  busy: false, text: '原稿 <保留> & 换行\n第二行', attachments: [{ path: '/tmp/input.txt', name: '资料 & 计划.txt', bytes: 10 }], attachmentBusy: false,
  setDraft: unexpected, onText: unexpected, onSend: unexpected, onChooseDirectory: unexpected, onOpenSettings: unexpected,
  onAttach: unexpected, onDropFiles: unexpected, onRemoveAttachment: unexpected };
const render = (patch: Partial<ComponentProps<typeof NewSessionForm>> = {}) => renderToStaticMarkup(createElement(NewSessionForm, { ...props, ...patch }));
const card = (html: string) => html.match(/<section[^>]*aria-label="首条消息提交状态"[\s\S]*?<\/section>/)?.[0];

test('new session feedback appears only for an actual first-message submission', () => {
  assert.equal(card(render()), undefined);
  assert.equal(card(render({ busy: true })), undefined, 'an unrelated busy action is not a submitted message');
  const pending = card(render({ busy: true, submitting: true }));
  assert.ok(pending); assert.match(pending, /aria-busy="true"/);
  assert.match(pending, /正在创建会话并提交消息…/);
  assert.match(pending, /原稿 &lt;保留&gt; &amp; 换行\n第二行/);
  assert.match(pending, /aria-label="正在提交的附件"/);
  assert.match(pending, /资料 &amp; 计划\.txt/);
  assert.doesNotMatch(pending, /已发送|已完成/);
});

test('new session feedback distinguishes created-session acknowledgement waiting and retains attachment-only sends', () => {
  const pending = card(render({ busy: true, submitting: true, created: true }));
  assert.ok(pending); assert.match(pending, /正在提交首条消息…/);
  assert.doesNotMatch(pending, /正在创建会话并提交消息/);
  const attachmentOnly = card(render({ busy: true, submitting: true, text: '' }));
  assert.ok(attachmentOnly); assert.match(attachmentOnly, /资料 &amp; 计划\.txt/);
  assert.doesNotMatch(attachmentOnly, /new-session-submitted-text/);
  assert.equal(card(render({ created: true, submitting: false })), undefined, 'failure restores the ordinary editable draft');
});
