import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StateStore } from '../src/main/store';
import { getSessionIdentity, sameConversation } from '../src/shared/execution';
import { persistedStateSchema, sessionInputSchema, stateSchema } from '../src/shared/schema';
import type { Session } from '../src/shared/types';

function session(): Session {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), projectId: randomUUID(), title: 'Saved conversation', kind: 'agent', cwd: '/workspace',
    execution: { providerId: 'claude', mode: 'structured', conversationId: randomUUID() },
    started: true, model: '', effort: 'default', permissionMode: 'default', status: 'stopped',
    archived: false, createdAt: now, updatedAt: now, draft: 'Unsent draft',
  };
}
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdesk-identities-'));
  const store = new StateStore(directory);
  return { directory, store, dispose: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
function legacy(value: Session) {
  const { execution, kind: _kind, ...fields } = value;
  return {
    ...fields, kind: 'claude' as const, claudeId: execution.conversationId!, adapter: execution.mode,
    ...(execution.forkFrom ? { resumeFrom: execution.forkFrom } : {}),
    ...(execution.imported === undefined ? {} : { imported: execution.imported }),
  };
}

test('v1 import and fork identities migrate once without changing local IDs, drafts or journals', () => {
  const f = fixture();
  try {
    const imported = session(), forked = session();
    imported.execution.imported = true;
    forked.execution.forkFrom = imported.execution.conversationId;
    forked.started = false;
    const oldState = { ...f.store.state, version: 1, sessions: [legacy(imported), legacy(forked)], selectedSessionId: forked.id };
    const original = JSON.stringify(oldState);
    fs.writeFileSync(f.store.file, original);
    const journal = path.join(f.directory, 'chat', `${forked.id}.events.jsonl`);
    fs.mkdirSync(path.dirname(journal));
    fs.writeFileSync(journal, 'existing journal\n');
    const restored = new StateStore(f.directory);
    assert.equal(restored.state.version, 2);
    assert.deepEqual(restored.state.sessions.map(item => item.id), [imported.id, forked.id]);
    assert.deepEqual(restored.state.sessions.map(item => item.execution), [imported.execution, forked.execution]);
    assert.equal(restored.state.selectedSessionId, forked.id);
    assert.equal(restored.state.sessions[1].draft, 'Unsent draft');
    assert.equal(fs.readFileSync(journal, 'utf8'), 'existing journal\n');
    restored.flush();
    assert.equal(fs.readFileSync(`${restored.file}.bak`, 'utf8'), original);
    const saved = JSON.parse(fs.readFileSync(restored.file, 'utf8'));
    for (const item of saved.sessions) for (const field of ['claudeId', 'resumeFrom', 'imported', 'adapter']) assert.equal(field in item, false);
    assert.deepEqual(new StateStore(f.directory).state, restored.state);
  } finally { f.dispose(); }
});

test('conversation reset persists the new provider identity and preserves the local session', () => {
  const f = fixture();
  try {
    const value = session(), oldId = value.execution.conversationId;
    value.execution.forkFrom = randomUUID();
    f.store.change(state => state.sessions.push(value));
    const nextId = randomUUID();
    f.store.change(state => {
      const item = state.sessions[0];
      item.execution = { ...item.execution, conversationId: nextId, forkFrom: undefined };
    });
    const restored = new StateStore(f.directory).state.sessions[0];
    assert.deepEqual(getSessionIdentity(restored), { sessionId: value.id, providerId: 'claude', mode: 'structured', conversationId: nextId });
    assert.equal(restored.draft, value.draft);
    assert.ok(!fs.readFileSync(f.store.file, 'utf8').includes(oldId!));
  } finally { f.dispose(); }
});

test('unknown providers and opaque conversation IDs survive saves and restarts', () => {
  const f = fixture();
  try {
    const value = session();
    value.execution = { providerId: 'vendor.future-agent', mode: 'structured', conversationId: 'conversation/opaque:42', forkFrom: 'parent:opaque' };
    f.store.change(state => state.sessions.push(value));
    const restored = new StateStore(f.directory);
    restored.change(state => { state.sessions[0].title = 'Renamed'; });
    assert.deepEqual(new StateStore(f.directory).state.sessions[0].execution, value.execution);
    const input = sessionInputSchema.parse({ projectId: value.projectId, title: '', kind: 'agent', providerId: value.execution.providerId, conversationId: value.execution.conversationId, mode: 'structured', model: '', effort: 'default', isolated: false });
    assert.equal(input.conversationId, 'conversation/opaque:42');
  } finally { f.dispose(); }
});

test('legacy shell identity becomes a terminal execution without a fabricated conversation', () => {
  const f = fixture();
  try {
    const shell = { ...legacy(session()), kind: 'shell', adapter: 'structured', imported: true, resumeFrom: randomUUID() };
    const migrated = persistedStateSchema.parse({ ...f.store.state, version: 1, sessions: [shell] });
    assert.equal(migrated.sessions[0].kind, 'shell');
    assert.deepEqual(migrated.sessions[0].execution, { providerId: 'shell', mode: 'terminal' });
    assert.equal(stateSchema.safeParse(migrated).success, true);
    migrated.sessions[0].execution.conversationId = randomUUID();
    assert.equal(stateSchema.safeParse(migrated).success, false);
  } finally { f.dispose(); }
});

test('live state rejects mixed legacy identities and conversation ownership is provider-scoped', () => {
  const f = fixture();
  try {
    const value = session();
    assert.equal(stateSchema.safeParse({ ...f.store.state, sessions: [{ ...value, claudeId: randomUUID() }] }).success, false);
    assert.equal(persistedStateSchema.safeParse({ ...f.store.state, version: 1, sessions: [{ ...legacy(value), execution: value.execution }] }).success, false);
    assert.equal(sameConversation(value.execution, { ...value.execution, mode: 'terminal' }), true);
    assert.equal(sameConversation(value.execution, { ...value.execution, providerId: 'another' }), false);
    assert.equal(sameConversation({ providerId: 'shell', mode: 'terminal' }, { providerId: 'shell', mode: 'terminal' }), false);
  } finally { f.dispose(); }
});
