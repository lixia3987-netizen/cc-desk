import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectDirectoryRegistry } from '../src/main/project-directory-registry';
import { StateStore } from '../src/main/store';
import { createClaudeConfig } from '@cc-desk/engine-claude/config';
import type { Project, Session } from '../src/shared/types';

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-project-directory-')));
  const directory = path.join(root, '工作目录 with spaces'); await fs.mkdir(directory);
  const alias = path.join(root, 'alias'); await fs.symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const store = new StateStore(path.join(root, 'data'));
  let changes = 0;
  return { root, directory, alias, store, registry: new ProjectDirectoryRegistry(store, () => { changes++; }),
    changes: () => changes, dispose: () => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}
function project(directory: string, name = 'Existing workspace'): Project {
  return { id: randomUUID(), name, path: directory, createdAt: new Date().toISOString() };
}
function session(workspace: Project): Session {
  return { id: randomUUID(), projectId: workspace.id, title: 'Existing session', kind: 'agent',
    execution: { providerId: 'claude', mode: 'structured', conversationId: randomUUID() }, cwd: workspace.path,
    started: false, engineConfig: createClaudeConfig(), status: 'idle', archived: false,
    draft: 'Keep this draft', createdAt: workspace.createdAt, updatedAt: workspace.createdAt };
}

test('choosing a directory registers its canonical path and reuses its identity without manual naming', async () => {
  const f = await fixture(); try {
    const first = await f.registry.add(f.alias);
    assert.equal(first.path, f.directory); assert.equal(first.name, path.basename(f.directory));
    assert.equal((await f.registry.add(f.directory + path.sep)).id, first.id);
    assert.equal((await f.registry.add(path.join(f.directory, '.'))).id, first.id);
    assert.equal(f.store.state.projects.length, 1); assert.equal(f.changes(), 1);
    const other = path.join(f.root, 'other', path.basename(f.directory)); await fs.mkdir(other, { recursive: true });
    const second = await f.registry.add(other);
    assert.equal(second.name, first.name); assert.notEqual(second.id, first.id);
    assert.equal(new StateStore(f.store.directory).state.projects.length, 2);
  } finally { await f.dispose(); }
});

test('legacy aliases and duplicate records reuse the first existing identity without migrating names, paths or sessions', async () => {
  const f = await fixture(); try {
    const legacy = project(f.alias, 'My original name'), duplicate = project(f.directory, 'Other existing record');
    f.store.change(state => { state.projects.push(legacy, duplicate); state.sessions.push(session(legacy), session(duplicate)); });
    const before = await fs.readFile(f.store.file, 'utf8');
    const selected = await f.registry.add(f.directory);
    assert.deepEqual(selected, legacy);
    assert.equal((await f.registry.add(f.alias)).id, legacy.id);
    assert.equal(await fs.readFile(f.store.file, 'utf8'), before);
    assert.deepEqual(f.store.state.sessions.map(item => item.projectId), [legacy.id, duplicate.id]);
    assert.equal(f.changes(), 0);
  } finally { await f.dispose(); }
});

test('simultaneous picker and direct-path registrations share one workspace across aliases', async () => {
  const f = await fixture(); try {
    const results = await Promise.all(Array.from({ length: 16 }, (_, index) => f.registry.add(index % 2 ? f.directory : f.alias)));
    assert.equal(new Set(results.map(item => item.id)).size, 1);
    assert.equal(f.store.state.projects.length, 1); assert.equal(f.changes(), 1);
  } finally { await f.dispose(); }
});

test('invalid selections do not modify missing old workspaces or poison later registration', async () => {
  const f = await fixture(); try {
    const missing = project(path.join(f.root, 'missing')); f.store.change(state => state.projects.push(missing));
    const file = path.join(f.root, 'file.txt'); await fs.writeFile(file, 'not a directory');
    await assert.rejects(f.registry.add('relative'), /绝对路径/);
    await assert.rejects(f.registry.add(file), /文件夹/);
    await assert.rejects(f.registry.add(missing.path));
    assert.deepEqual(f.store.state.projects, [missing]); assert.equal(f.changes(), 0);
    const selected = await f.registry.add(f.directory);
    assert.deepEqual(f.store.state.projects[0], missing);
    assert.notEqual(selected.id, missing.id); assert.equal(f.changes(), 1);
  } finally { await f.dispose(); }
});

test('storage failure leaves registration uncommitted and a retry creates exactly one workspace', async () => {
  const f = await fixture(); try {
    await fs.mkdir(f.store.file + '.tmp');
    await assert.rejects(f.registry.add(f.directory));
    assert.equal(f.store.state.projects.length, 0); assert.equal(f.changes(), 0);
    await fs.rmdir(f.store.file + '.tmp');
    const selected = await f.registry.add(f.directory);
    assert.equal((await f.registry.add(f.alias)).id, selected.id);
    assert.equal(f.store.state.projects.length, 1); assert.equal(f.changes(), 1);
  } finally { await f.dispose(); }
});

test('a workspace removed while its legacy alias is resolving is never returned as a stale identity', async t => {
  const f = await fixture(); try {
    const old = project(f.directory); f.store.change(state => state.projects.push(old));
    const realpath = fs.realpath;
    let reached!: () => void, release!: () => void, held = false;
    const inspecting = new Promise<void>(resolve => { reached = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    t.mock.method(fs, 'realpath', async (...args: Parameters<typeof fs.realpath>) => {
      if (args[0] === f.directory && !held) { held = true; reached(); await resume; }
      return realpath(...args);
    });
    const registering = f.registry.add(f.alias);
    await inspecting;
    f.store.change(state => { state.projects = []; });
    release();
    const selected = await registering;
    assert.notEqual(selected.id, old.id);
    assert.deepEqual(f.store.state.projects.map(item => item.id), [selected.id]);
  } finally { t.mock.restoreAll(); await f.dispose(); }
});

test('Windows directory spelling differences reuse the same workspace', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture(); try {
    const first = await f.registry.add(f.directory);
    assert.equal((await f.registry.add(f.directory.toUpperCase())).id, first.id);
    assert.equal(f.store.state.projects.length, 1);
  } finally { await f.dispose(); }
});
