import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StateStore } from '../src/main/store';
import { registerNativeSkillHandlers } from '../src/main/ipc/native-skill-handlers';
import type { NativeInstructionsPreview, NativeSkillPreview, NativeSkillsListResult } from '../src/shared/native-skills';

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
  const inspect = (input: unknown) => Promise.resolve().then(() => handlers.get('native:skills-inspect')!(input)) as Promise<NativeSkillPreview>;
  const instructions = (input: unknown) => Promise.resolve().then(() => handlers.get('native:instructions-inspect')!(input)) as Promise<NativeInstructionsPreview>;
  const skill = async (directory: string, name: string, content: string) => {
    const target = path.join(directory, '.agents', 'skills', name);
    await fs.mkdir(target, { recursive: true }); await fs.writeFile(path.join(target, 'SKILL.md'), content);
  };
  return { root, project, worktree, data, store, id, list, inspect, instructions, skill, dispose: async () => { store.flush(); await fs.rm(root, { recursive: true, force: true }); } };
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

test('explicit Skill inspection loads custom worktree sources without adding them to discovery or configuration', async () => {
  const f = await fixture();
  try {
    const sourcePath = 'tools/quality/SKILL.md';
    const content = '---\nname: untrusted\n---\n<script>literal</script>\n@https://example.invalid/include';
    await fs.mkdir(path.dirname(path.join(f.worktree, sourcePath)), { recursive: true });
    await fs.writeFile(path.join(f.worktree, sourcePath), content);
    const before = structuredClone(f.store.state);
    assert.equal((await f.list()).entries.length, 0);
    const result = await f.inspect({ sessionId: f.id, path: sourcePath });
    assert.equal(result.path, sourcePath); assert.equal(result.name, 'quality');
    assert.equal(result.content, content); assert.equal(result.bytes, Buffer.byteLength(content));
    assert.match(result.hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(f.store.state, before);
  } finally { await f.dispose(); }
});

test('instruction inspection preserves root-to-target order, literal content and same-scope precedence', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.worktree, 'src'));
    for (const [source, content] of [['CLAUDE.md', 'Root Claude'], ['AGENTS.md', 'Root agents'], ['src/CLAUDE.md', 'Nested Claude'], ['src/AGENTS.md', 'Nested agents']]) await fs.writeFile(path.join(f.worktree, source), content);
    await f.skill(f.worktree, 'review', 'UNSELECTED-SKILL-NOT-IN-INSTRUCTION-PREVIEW');
    const before = structuredClone(f.store.state);
    const result = await f.instructions({ sessionId: f.id, targetPath: 'src' });
    assert.deepEqual(result.sources.map(item => [item.path, item.scope]), [['CLAUDE.md', '.'], ['AGENTS.md', '.'], ['src/CLAUDE.md', 'src'], ['src/AGENTS.md', 'src']]);
    assert.equal(result.sources.at(-1)!.content, 'Nested agents');
    assert.equal(result.sources.at(-1)!.bytes, 13);
    assert.match(result.digest, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(result), /UNSELECTED-SKILL|native-skills-ipc-/);
    assert.deepEqual(f.store.state, before);
  } finally { await f.dispose(); }
});

test('source inspection rejects arbitrary roots, sensitive paths, links, invalid text and budgets without disclosing content', async () => {
  const f = await fixture();
  try {
    await f.skill(f.worktree, 'review', 'source');
    const safe = '.agents/skills/review/SKILL.md';
    const reject = (promise: Promise<unknown>) => assert.rejects(promise, error => error instanceof Error && !error.message.includes(f.root) && !error.message.includes('SENTINEL'));
    for (const source of ['../SKILL.md', '/tmp/SKILL.md', '.env/SKILL.md', '.git/SKILL.md', '~/.claude/skills/review/SKILL.md', 'other.txt']) await reject(f.inspect({ sessionId: f.id, path: source }));
    for (const input of [{ sessionId: f.id, path: safe, cwd: f.project }, { sessionId: 'missing', path: safe }, { sessionId: f.id }, null]) await reject(f.inspect(input));
    for (const content of [Buffer.from([0xff]), Buffer.from([0, 1]), 'SENTINEL'.repeat(5000)]) {
      await fs.writeFile(path.join(f.worktree, safe), content);
      await reject(f.inspect({ sessionId: f.id, path: safe }));
    }
    const link = path.join(f.worktree, 'outside');
    await f.skill(f.project, 'private', 'SENTINEL');
    await fs.symlink(f.project, link, process.platform === 'win32' ? 'junction' : 'dir');
    await reject(f.inspect({ sessionId: f.id, path: 'outside/.agents/skills/private/SKILL.md' }));
    for (const targetPath of ['../', '.env', '.git', 'outside']) await reject(f.instructions({ sessionId: f.id, targetPath }));
    await fs.writeFile(path.join(f.worktree, 'AGENTS.md'), 'SENTINEL'.repeat(5000));
    await reject(f.instructions({ sessionId: f.id, targetPath: '.' }));
    f.store.change(state => { state.sessions[0].cwd = f.data; });
    await reject(f.inspect({ sessionId: f.id, path: safe }));
    await reject(f.instructions({ sessionId: f.id, targetPath: '.' }));
  } finally { await f.dispose(); }
});

for (const change of ['cwd', 'conversation', 'engine', 'remove']) test(`source inspection rejects results when session ${change} changes during the read`, async () => {
  const f = await fixture();
  try {
    await f.skill(f.worktree, 'review', 'source');
    const pending = [f.inspect({ sessionId: f.id, path: '.agents/skills/review/SKILL.md' }), f.instructions({ sessionId: f.id, targetPath: '.' })];
    await Promise.resolve();
    f.store.change(state => {
      if (change === 'cwd') state.sessions[0].cwd = f.project;
      if (change === 'conversation') state.sessions[0].execution.conversationId = randomUUID();
      if (change === 'engine') state.sessions[0].execution.providerId = 'claude';
      if (change === 'remove') state.sessions = [];
    });
    await Promise.all(pending.map(promise => assert.rejects(promise, /会话/)));
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
