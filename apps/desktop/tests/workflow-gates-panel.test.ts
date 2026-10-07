import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkflowPanel, WorkflowReceiptDetails } from '../src/renderer/WorkflowPanel';
import { emptyWorkflowDraft } from '../src/shared/panel-drafts';
import { NATIVE_WORKFLOW_POLICIES_ENABLED, type WorkflowNativeReceipt } from '../src/shared/workflows';
import type { Session } from '../src/shared/types';

const unexpected = () => { throw new Error('Rendering must never dispatch or approve execution'); };
const session = (providerId: string): Session => ({ id: 'local-session', projectId: 'project', title: 'Test', kind: 'agent', cwd: '/tmp/project',
  execution: { providerId, mode: 'structured', conversationId: 'conversation' }, engineConfig: { schemaVersion: 1, options: {} },
  started: false, status: 'idle', archived: false, createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' });
const render = (providerId: string) => renderToStaticMarkup(createElement(WorkflowPanel, { session: session(providerId), draft: emptyWorkflowDraft(), onDraft: unexpected, onError: unexpected, onTemplate: unexpected }));

test('workflow creation exposes explicit gates and does not advertise unsupported Claude strict policies', () => {
  const native = render('native'), claude = render('claude');
  assert.match(native, /检查任务验收条件/);
  assert.match(native, /人工确认产出/);
  assert.match(native, /验收等待不会重新执行/);
  assert.doesNotMatch(claude, /检查任务验收条件|严格只读|整个工作流预算/);
  assert.match(claude, /规划指令不会强制只读/);
  assert.equal(native.includes('整个工作流预算'), NATIVE_WORKFLOW_POLICIES_ENABLED);
  assert.equal(native.includes('严格只读'), NATIVE_WORKFLOW_POLICIES_ENABLED);
});

test('stage receipts identify historical evidence, incomplete scans and truncated results without inventing acceptance', () => {
  const receipt: WorkflowNativeReceipt = { version: 1, identity: { sessionId: 'session', conversationId: 'conversation', runId: 'run', requestId: 'request', workerGeneration: 1 },
    taskId: 'task', workspace: { fingerprint: 'hash', complete: false, capturedAt: '2026-10-07T00:00:00.000Z' },
    criteria: [{ id: 'check', description: 'Actual requirement', stepIds: ['build'], kind: 'command' }], evidence: [],
    changes: { added: [], modified: ['src/app.ts'], removed: [], complete: false, truncated: true, attribution: 'observed_since_task_start' },
    usage: { modelRequests: 2, toolCalls: 1, activeMs: 60000 }, truncated: true };
  const markup = renderToStaticMarkup(createElement(WorkflowReceiptDetails, { receipt }));
  assert.match(markup, /历史记录/);
  assert.match(markup, /范围不完整/);
  assert.match(markup, /列表已截断/);
  assert.match(markup, /Actual requirement/);
  assert.match(markup, /src\/app.ts/);
  assert.match(markup, /任务：task/);
  assert.match(markup, /执行：run/);
  assert.doesNotMatch(markup, /已确认通过/);
});
