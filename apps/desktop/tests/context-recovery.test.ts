import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatRuntime } from '../src/main/chat-runtime';
import { ChatHistory } from '../src/main/chat-history';
import { StateStore } from '../src/main/store';
import { chatArguments } from '../src/main/chat-protocol';
import { MISSING_TRANSCRIPT_ERROR } from '../src/shared/session-recovery';
import type { Capabilities, Session } from '../src/shared/types';

const capabilities: Capabilities = { available: true, executable: 'fixture', version: 'fixture', efforts: ['default'],
  flags: ['--session-id', '--resume', '--fork-session', '--permission-mode', '--print', '--input-format', '--output-format', '--verbose', '--permission-prompt-tool', '--include-partial-messages'] };
const fixtureSource = String.raw`
const readline = require('node:readline');
const output = frame => process.stdout.write(JSON.stringify(frame) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request') output({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
  else if (frame.type === 'user') output({ type: 'result', subtype: 'success', session_id: process.argv[2], result: '新上下文回复' });
});
`;

function setup(exists: (id: string) => Promise<boolean> = async () => false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-context-recovery-'));
  const worktree = path.join(directory, 'worktree'); fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(worktree, 'uncommitted.txt'), 'keep this work');
  const store = new StateStore(directory), now = new Date().toISOString();
  const session: Session = { id: randomUUID(), projectId: randomUUID(), title: 'existing session', kind: 'agent', cwd: worktree,
    worktree, worktreeBase: directory, execution: { providerId: 'claude', mode: 'structured', conversationId: randomUUID(), imported: true, forkFrom: randomUUID() },
    started: true, status: 'error', taskState: 'error', error: MISSING_TRANSCRIPT_ERROR, archived: false,
    model: '', effort: 'default', permissionMode: 'default', draft: '保留草稿', createdAt: now, updatedAt: now };
  store.change(state => state.sessions.push(session));
  const history = new ChatHistory(directory, () => false), snapshot = history.get(session.id);
  const message = { id: randomUUID(), turnId: randomUUID(), role: 'user' as const, text: '保留历史消息', createdAt: now };
  history.append(session.id, { type: 'message', message }); history.upsertMessage(session.id, message);
  snapshot.context = { status: 'ready', inputTokens: 12000, contextWindow: 200000 };
  snapshot.usage = { inputTokens: 10000 };
  snapshot.error = MISSING_TRANSCRIPT_ERROR; snapshot.taskState = 'error';
  history.append(session.id, { type: 'context', context: snapshot.context });
  history.append(session.id, { type: 'result', success: true, summary: 'old', usage: snapshot.usage });
  history.append(session.id, { type: 'state', taskState: 'error', error: snapshot.error });
  history.changed(session.id); history.flush();
  const script = path.join(directory, 'fixture.cjs'); fs.writeFileSync(script, fixtureSource);
  const launches: string[][] = [];
  const runtime = new ChatRuntime(store, () => {}, () => {}, { transcriptExists: exists, initializationTimeoutMs: 2000,
    invocation: (session, caps, resumed) => {
      launches.push(chatArguments(session, caps, resumed));
      return { file: process.execPath, args: [script, session.execution.conversationId!] };
    } });
  return { directory, store, session, runtime, launches, async dispose() { await runtime.shutdown(); store.flush(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('explicit missing-transcript recovery preserves local records and worktree, persists a fresh identity and clears context through journal replay', async () => {
  const f = setup();
  try {
    await assert.rejects(f.runtime.prepareCommands(f.session.id, capabilities), /未找到原会话记录/);
    assert.equal(f.store.state.sessions[0].execution.conversationId, f.session.execution.conversationId);
    await f.runtime.recoverContext(f.session.id);
    const recovered = f.store.state.sessions[0];
    assert.notEqual(recovered.execution.conversationId, f.session.execution.conversationId);
    assert.equal(recovered.execution.imported, undefined); assert.equal(recovered.execution.forkFrom, undefined);
    assert.equal(recovered.started, false); assert.equal(recovered.error, undefined); assert.equal(recovered.taskState, 'idle');
    assert.equal(recovered.worktree, f.session.worktree); assert.equal(recovered.cwd, f.session.cwd); assert.equal(recovered.draft, '保留草稿');
    assert.equal(fs.readFileSync(path.join(recovered.cwd, 'uncommitted.txt'), 'utf8'), 'keep this work');
    assert.equal(new StateStore(f.directory).state.sessions[0].execution.conversationId, recovered.execution.conversationId);
    fs.rmSync(path.join(f.directory, 'chat', f.session.id + '.json'));
    const replayed = new ChatHistory(f.directory, () => false), snapshot = replayed.get(f.session.id);
    assert.equal(snapshot.context, undefined); assert.equal(snapshot.usage, undefined); assert.equal(snapshot.error, undefined);
    assert.ok(snapshot.messages.some(message => message.text === '保留历史消息'));
    assert.ok(snapshot.messages.some(message => message.role === 'system' && message.text.includes(f.session.execution.conversationId!)));
    replayed.flush();
    assert.equal((await f.runtime.send(f.session.id, '继续处理', capabilities)).success, true);
    assert.ok(f.launches.at(-1)?.includes('--session-id')); assert.ok(!f.launches.at(-1)?.includes('--resume'));
    await f.runtime.stopIdle(f.session.id);
    await assert.rejects(f.runtime.send(f.session.id, '不能静默丢弃新的上下文', capabilities), /未找到原会话记录/);
  } finally { await f.dispose(); }
});

test('recovery refuses existing transcripts, unrelated failures and fresh sessions', async () => {
  let exists = true;
  const f = setup(async () => exists);
  try {
    await assert.rejects(f.runtime.recoverContext(f.session.id), /已找到原会话记录/);
    exists = false;
    f.store.change(state => { state.sessions[0].started = false; });
    await assert.rejects(f.runtime.recoverContext(f.session.id), /只有缺失原始记录/);
    f.store.change(state => { state.sessions[0].started = true; state.sessions[0].error = '网络错误'; });
    // Both independently retained error surfaces must lack the missing-transcript condition.
    const file = path.join(f.directory, 'chat', f.session.id + '.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')); saved.error = '网络错误'; fs.writeFileSync(file, JSON.stringify(saved));
    const other = new ChatRuntime(f.store, () => {}, () => {}, { transcriptExists: async () => false });
    try { await assert.rejects(other.recoverContext(f.session.id), /只有缺失原始记录/); }
    finally { await other.shutdown(); }
    assert.equal(f.store.state.sessions[0].execution.conversationId, f.session.execution.conversationId);
  } finally { await f.dispose(); }
});

test('recovery serializes transcript verification against sends, concurrent recovery and shutdown', async () => {
  let release!: (value: boolean) => void;
  const checked = new Promise<boolean>(resolve => { release = resolve; });
  const f = setup(async () => checked);
  try {
    const recovery = f.runtime.recoverContext(f.session.id);
    await assert.rejects(f.runtime.recoverContext(f.session.id), /正在处理任务/);
    await assert.rejects(f.runtime.send(f.session.id, '竞态发送', capabilities), /上一轮/);
    f.runtime.setMaintenance(true); release(false);
    await assert.rejects(recovery, /连接已暂停/);
    assert.equal(f.store.state.sessions[0].execution.conversationId, f.session.execution.conversationId);
    assert.equal(f.runtime.isBusy(f.session.id), false);
  } finally { release?.(false); await f.dispose(); }
});

test('failed workspace persistence keeps the old resume identity and never sends a prompt', async () => {
  const f = setup();
  try {
    fs.mkdirSync(f.store.file + '.tmp');
    await assert.rejects(f.runtime.recoverContext(f.session.id));
    assert.equal(f.store.state.sessions[0].execution.conversationId, f.session.execution.conversationId);
    assert.equal(f.store.state.sessions[0].started, true);
    assert.equal(f.launches.length, 0);
  } finally { fs.rmSync(f.store.file + '.tmp', { recursive: true, force: true }); await f.dispose(); }
});
