import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskNotifications } from '../src/main/task-notifications';

const identity = { sessionId: 'restored-session', providerId: 'native', mode: 'structured' as const, conversationId: 'restored-conversation' };

test('restoring a completed conversation establishes a baseline without sending a completion notification', () => {
  const notifications = new TaskNotifications();
  assert.equal(notifications.observe(identity, 'completed', false), false);
  assert.equal(notifications.observe(identity, 'completed', false), false);
  assert.equal(notifications.observe(identity, 'starting', true), false);
  assert.equal(notifications.observe(identity, 'completed', true), false, 'old completed history cannot finish a live request');
  assert.equal(notifications.observe(identity, 'thinking', true), false);
  assert.equal(notifications.observe(identity, 'completed', false), true);
  assert.equal(notifications.observe(identity, 'completed', false), false, 'snapshot refresh cannot duplicate the notification');
});

test('worker completion during cleanup does not consume the notification for actual host completion', () => {
  const notifications = new TaskNotifications();
  assert.equal(notifications.observe(identity, 'starting', true), false);
  assert.equal(notifications.observe(identity, 'thinking', true), false);
  assert.equal(notifications.observe(identity, 'completed', true), false);
  assert.equal(notifications.observe(identity, 'completed', true), false);
  assert.equal(notifications.observe(identity, 'completed', false), true);
});

test('approvals and errors still notify immediately and are deduplicated', () => {
  const notifications = new TaskNotifications();
  assert.equal(notifications.observe(identity, 'waiting_approval', true), true);
  assert.equal(notifications.observe(identity, 'waiting_approval', true), false);
  assert.equal(notifications.observe(identity, 'waiting_input', true), true);
  assert.equal(notifications.observe(identity, 'error', true), true);
  assert.equal(notifications.observe(identity, 'error', true), false);
});

test('switching conversation identity cannot reuse a previous conversation notification baseline', () => {
  const notifications = new TaskNotifications();
  notifications.observe(identity, 'thinking', true);
  assert.equal(notifications.observe({ ...identity, conversationId: 'new-conversation' }, 'completed', false), false);
  assert.equal(notifications.observe({ ...identity, sessionId: 'other-session' }, 'completed', false), false);
});
