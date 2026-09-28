import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StateStore } from '../src/main/store';
import { registerNativeSkillHandlers } from '../src/main/ipc/native-skill-handlers';
import type { NativeSkillsListResult } from '../src/shared/native-skills';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-skills-ipc-'));
  const project = path.join(root, 'project'), worktree = path.join(root, 'worktree');
  const data = path.join(root, 'data');
  await fs.mkdir(project); await fs.mkdir(worktree);
  const store = new StateStore(data), id = randomUUID(), projectId = randomUUID();
  const now = new Date().toISOString();
  store.change(state => {
    state.projects.push({ id: projectId, path: project, name: 'project', createdAt: now });
    state.sessions.push({ id, projectId, title: 'Native', kind: 'agent', cwd: worktree,
      execution: { providerId: 'native', mode: 'structured', conversationId: randomUUID() },
      engineConfig: { schemaVersion: 1, options: {} }, started: false, status: 'idle', archived: false, createdAt: now, updatedAt: now });
  });
  const handlers = new Map<string, (input: unknown) => unknown>();
  registerNativeSkillHandlers((name, schema, action) => { handlers.set(name, input => action(schema.parse(input))); }, store);
  const list = (...input: unknown[]) => Promise.resolve().then(() => handlers.get('native:skills-list')!(input.length ? input[0] : { sessionId: id })) as Promise<NativeSkillsListResult>;
  const skill = async (directory: string, name: string, content: string) => {
    const target = path.join(directory, '.agents', 'skills', name);
    await fs.mkdir(target, { recursive: true }); await fs.writeFile(path.join(target, 'SKILL.md'), content);
  };
  return { root, project, worktree, data, store, id, list, skill, dispose: async () => { store.flush(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('Skills IPC resolves the session worktree and returns metadata without instructions or changing selection', async () => {
  const f = await fixture();
  try {
    const secretText = 'PRIVATE-SKILL-CONTENT-NOT-FOR-IPC';
    await f.skill(f.project, 'main-only', 'Not in the session worktree');
    await f.skill(f.worktree, 'review', secretText);
    const before = structuredClone(f.store.state), result = await f.list();
    assert.deepEqual(result.entries.map(entry => entry.path), ['.agents/skills/review/SKILL.md']);
    assert.equal(result.entries[0].name, 'review');
    assert.match(result.entries[0].hash, /^[a-f0-9]{64}$/);
    assert.equal(result.entries[0].bytes, Buffer.byteLength(secretText));
    assert.equal(JSON.stringify(result).includes(secretText), false);
    assert.equal(JSON.stringify(result).includes(f.root), false);
    assert.deepEqual(f.store.state, before);
  } finally { await f.dispose(); }
});

test('Skills IPC rejects arbitrary roots, malformed input, missing sessions and other engines', async () => {
  const f = await fixture();
  try {
    for (const input of [undefined, null, {}, { sessionId: '' }, { sessionId: f.id, cwd: f.project }, { sessionId: 'missing' }]) {
      await assert.rejects(f.list(input));
    }
    f.store.change(state => { state.sessions[0].execution.providerId = 'claude'; });
    await assert.rejects(f.list(), /Native/);
    f.store.change(state => { state.sessions[0].execution = { providerId: 'shell', mode: 'terminal' }; state.sessions[0].kind = 'shell'; });
    await assert.rejects(f.list(), /Native/);
  } finally { await f.dispose(); }
});

test('Skills IPC excludes host data and does not disclose filesystem errors', async () => {
  const f = await fixture();
  try {
    await f.skill(f.data, 'private', 'HOST-DATA-MUST-STAY-PRIVATE');
    f.store.change(state => { state.sessions[0].cwd = f.data; });
    await assert.rejects(f.list(), error => error instanceof Error && !error.message.includes(f.root) && !error.message.includes('HOST-DATA'));
  } finally { await f.dispose(); }
});

test('Skills IPC rejects a result if its session disappears while discovery is pending', async () => {
  const f = await fixture();
  try {
    await f.skill(f.worktree, 'review', 'Review guide');
    const pending = f.list();
    await Promise.resolve();
    f.store.change(state => { state.sessions = []; });
    await assert.rejects(pending, /会话/);
  } finally { await f.dispose(); }
});
