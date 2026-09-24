import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatHistory } from '../src/main/chat-history';
import type { ChatMessage, ChatSnapshot } from '../src/shared/chat';

const message = (id: string, text = ''): ChatMessage => ({ id, turnId: 'turn', role: 'assistant', text, createdAt: '2026-09-21T00:00:00.000Z' });
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-recovery-'));
  const id = randomUUID();
  const histories: ChatHistory[] = [];
  const history = () => { const value = new ChatHistory(directory, () => false); histories.push(value); return value; };
  const first = history();
  const journal = path.join(first.directory, id + '.jsonl');
  const snapshot = path.join(first.directory, id + '.json');
  const events = (...values: Record<string, unknown>[]) => fs.appendFileSync(journal, values.map(value => JSON.stringify(value) + '\n').join(''));
  return { id, first, history, journal, snapshot, events, cleanup: () => { for (const value of histories) value.flush(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('replays the UTF-8 journal suffix after a snapshot exactly once, including a crash before projection update', () => {
  const f = fixture();
  try {
    const original = message('assistant', '你好 🌏');
    f.first.append(f.id, { type: 'message', message: original });
    f.first.upsertMessage(f.id, original); f.first.changed(f.id); f.first.flush();
    const saved = JSON.parse(fs.readFileSync(f.snapshot, 'utf8'));
    assert.equal(saved.journalCursor, fs.statSync(f.journal).size);
    f.first.append(f.id, { type: 'text_delta', id: original.id, text: '，继续' });
    const recovered = f.history();
    assert.equal(recovered.getMessage(f.id, original.id)?.text, '你好 🌏，继续');
    assert.equal('journalCursor' in recovered.get(f.id), false);
    recovered.flush();
    assert.equal(f.history().getMessage(f.id, original.id)?.text, '你好 🌏，继续');
  } finally { f.cleanup(); }
});

test('reconstructs an unsnapshotted turn, metadata and usage while discarding old approvals', () => {
  const f = fixture();
  try {
    f.events(
      { type: 'message', message: message('assistant', 'partial') },
      { type: 'text_delta', id: 'assistant', text: ' reply' },
      { type: 'metadata', model: 'model-a', permissionMode: 'plan', mcpServers: [{ name: 'local', status: 'connected' }] },
      { type: 'result', success: true, usage: { inputTokens: 10, outputTokens: 4 }, summary: 'partial reply' },
      { type: 'approval_requested', approval: { requestId: 'expired', toolName: 'Bash', input: {} } },
      { type: 'state', taskState: 'waiting_approval' },
    );
    const snapshot = f.history().get(f.id);
    assert.equal(snapshot.messages.length, 1); assert.equal(snapshot.messages[0].text, 'partial reply');
    assert.equal(snapshot.taskState, 'interrupted'); assert.deepEqual(snapshot.pending, []);
    assert.equal(snapshot.model, 'model-a'); assert.equal(snapshot.permissionMode, 'plan');
    assert.deepEqual(snapshot.mcpServers, [{ name: 'local', status: 'connected' }]);
    assert.equal(snapshot.usage?.outputTokens, 4);
  } finally { f.cleanup(); }
});

test('legacy snapshots without a cursor do not replay deltas twice and preserve snapshot-only messages', () => {
  const f = fixture();
  try {
    const legacy: ChatSnapshot = { sessionId: f.id, taskState: 'thinking', pending: [{ requestId: 'old', toolName: 'Bash', input: {}, createdAt: '', kind: 'permission' }], messages: [message('imported', 'older import'), message('assistant', 'hello')] };
    fs.writeFileSync(f.snapshot, JSON.stringify(legacy));
    f.events(
      { type: 'message', message: message('assistant', 'hel') },
      { type: 'text_delta', id: 'assistant', text: 'lo' },
      { type: 'text_delta', id: 'assistant', text: ' world' },
    );
    const recovered = f.history();
    assert.deepEqual(recovered.get(f.id).messages.map(item => item.text), ['older import', 'hello world']);
    assert.equal(recovered.get(f.id).taskState, 'interrupted'); assert.deepEqual(recovered.get(f.id).pending, []);
    recovered.flush();
    assert.equal(f.history().getMessage(f.id, 'assistant')?.text, 'hello world');
  } finally { f.cleanup(); }
});

test('an intermediate result cannot restore a running background turn as completed', () => {
  const f = fixture();
  try {
    f.events({ type: 'state', taskState: 'thinking' }, { type: 'result', success: true, usage: { outputTokens: 5 }, summary: 'background work remains' });
    const recovered = f.history();
    assert.equal(recovered.get(f.id).taskState, 'interrupted');
    recovered.flush();
    f.events({ type: 'state', taskState: 'completed' });
    assert.equal(f.history().get(f.id).taskState, 'completed');
  } finally { f.cleanup(); }
});

test('preserves incomplete journal evidence and separates future records from a broken tail', () => {
  const f = fixture();
  try {
    f.events({ type: 'message', message: message('assistant', 'safe') });
    const boundary = fs.statSync(f.journal).size;
    const broken = '{"type":"text_delta","id":"assistant","text":"unfinished';
    fs.appendFileSync(f.journal, broken);
    const recovered = f.history();
    assert.equal(recovered.getMessage(f.id, 'assistant')?.text, 'safe');
    assert.equal(recovered.get(f.id).truncated, true);
    recovered.flush();
    assert.equal(JSON.parse(fs.readFileSync(f.snapshot, 'utf8')).journalCursor, boundary);
    assert.equal(fs.readFileSync(f.journal, 'utf8').endsWith(broken), true);
    const next = message('next', 'after recovery');
    recovered.append(f.id, { type: 'message', message: next });
    recovered.upsertMessage(f.id, next); recovered.changed(f.id); recovered.flush();
    assert.ok(fs.readFileSync(f.journal, 'utf8').includes(broken + '\n{"at":'));
    fs.rmSync(f.snapshot);
    const rebuilt = f.history().get(f.id);
    assert.deepEqual(rebuilt.messages.map(item => item.text), ['safe', 'after recovery']);
  } finally { f.cleanup(); }
});

test('bounds journal replay, individual messages and aggregate message bytes while preserving full events', () => {
  const f = fixture();
  try {
    for (let index = 0; index < 460; index++) f.events({ type: 'message', message: message(String(index), '旧'.repeat(3000)) });
    const large = message('large', '🌏'.repeat(400_000));
    f.events({ type: 'message', message: large }, { type: 'text_delta', id: 'large', text: 'finish' });
    const recovered = f.history();
    const snapshot = recovered.get(f.id);
    assert.ok(snapshot.messages.length <= 400);
    assert.ok(snapshot.messages.reduce((bytes, item) => bytes + Buffer.byteLength(JSON.stringify(item)), 0) <= 2 * 1024 * 1024);
    assert.equal(snapshot.truncated, true);
    assert.equal(recovered.getMessage(f.id, 'large')?.truncated, true);
    assert.ok(recovered.getMessage(f.id, 'large')!.text.endsWith('finish'));
    assert.ok(fs.statSync(f.journal).size > 5 * 1024 * 1024);
    recovered.flush();
    assert.equal(f.history().getMessage(f.id, 'large')?.text, recovered.getMessage(f.id, 'large')?.text);
  } finally { f.cleanup(); }
});

test('skips an oversized damaged record with bounded reads and recovers subsequent records', () => {
  const f = fixture();
  try {
    const block = 'x'.repeat(1024 * 1024);
    for (let index = 0; index < 33; index++) fs.appendFileSync(f.journal, block);
    fs.appendFileSync(f.journal, '\n');
    f.events({ type: 'message', message: message('after-large', 'still recoverable') });
    const snapshot = f.history().get(f.id);
    assert.equal(snapshot.messages[0].text, 'still recoverable'); assert.equal(snapshot.truncated, true);
  } finally { f.cleanup(); }
});

test('message updates serialize only the changed message and legacy direct pushes remain bounded', () => {
  const f = fixture();
  try {
    const snapshot = f.first.get(f.id);
    for (let index = 0; index < 400; index++) f.first.upsertMessage(f.id, message(String(index), 'history'));
    f.first.changed(f.id); f.first.flush();
    const stringify = JSON.stringify;
    let unrelated = 0;
    JSON.stringify = ((value: unknown, ...args: unknown[]) => {
      if (value && typeof value === 'object' && 'id' in value && value.id !== '399') unrelated++;
      return (stringify as (...args: unknown[]) => string | undefined)(value, ...args);
    }) as typeof JSON.stringify;
    try {
      for (let index = 0; index < 50; index++) {
        f.first.upsertMessage(f.id, message('399', 'updated ' + index)); f.first.changed(f.id);
      }
      assert.equal(unrelated, 0);
    } finally { JSON.stringify = stringify; }
    assert.equal(f.first.getMessage(f.id, '399')?.text, 'updated 49');
    snapshot.messages.push(message('legacy', 'direct push')); f.first.changed(f.id);
    assert.equal(snapshot.messages.length, 400); assert.equal(f.first.getMessage(f.id, '0'), undefined);
    assert.equal(f.first.getMessage(f.id, 'legacy')?.text, 'direct push');
    snapshot.messages[20] = message('replacement', 'same length'); f.first.changed(f.id);
    assert.equal(f.first.getMessage(f.id, 'replacement')?.text, 'same length');
  } finally { f.cleanup(); }
});

test('version migration removes a proven long result echo from an existing cursor snapshot without editing the journal', () => {
  const f = fixture();
  try {
    const turnId = randomUUID(); const text = '完整回复'.repeat(80_000);
    const block = { ...message(turnId + ':main:message-a:0', text), turnId };
    const echo = { ...message(randomUUID(), text), turnId };
    f.events({ type: 'message', message: block }, { type: 'result', success: true, summary: text }, { type: 'message', message: echo }, { type: 'state', taskState: 'completed' });
    const evidence = fs.readFileSync(f.journal, 'utf8');
    fs.writeFileSync(f.snapshot, JSON.stringify({ sessionId: f.id, taskState: 'completed', pending: [], journalCursor: Buffer.byteLength(evidence), messages: [message('snapshot-only', 'keep imported history'), ...[block, echo].map(value => ({ ...value, text: value.text.slice(-256 * 1024), truncated: true }))] }));
    const recovered = f.history();
    assert.deepEqual(recovered.get(f.id).messages.map(value => value.id), ['snapshot-only', block.id]);
    assert.equal(recovered.getMessage(f.id, block.id)?.text, text.slice(-256 * 1024));
    assert.equal(recovered.getMessage(f.id, block.id)?.truncated, true);
    assert.equal(fs.readFileSync(f.journal, 'utf8'), evidence);
    assert.equal('projectionVersion' in recovered.get(f.id), false);
    recovered.flush();
    assert.equal(JSON.parse(fs.readFileSync(f.snapshot, 'utf8')).projectionVersion, 1);
    assert.deepEqual(f.history().get(f.id).messages.map(value => value.id), ['snapshot-only', block.id]);
  } finally { f.cleanup(); }
});

test('result echo repair recognizes old and tuple block identities, aggregates, and the latest block', () => {
  for (const tuple of [false, true]) for (const summary of ['firstsecond', 'first\nsecond', 'first\n\nsecond', 'second']) {
    const f = fixture();
    try {
      const turnId = randomUUID(); const group = tuple ? JSON.stringify([turnId, null, 'msg-a']) : turnId + ':main:msg-a';
      const blocks = ['first', 'second'].map((text, index) => ({ ...message(group + ':' + index, text), turnId }));
      const echo = { ...message(randomUUID(), summary), turnId };
      f.events(...blocks.map(message => ({ type: 'message', message })), { type: 'result', success: true, summary }, { type: 'message', message: echo });
      const recovered = f.history().get(f.id);
      assert.deepEqual(recovered.messages.map(value => value.text), ['first', 'second']);
    } finally { f.cleanup(); }
  }
});

test('migration restores authoritative chronology when removing echoes frees projection slots', () => {
  const f = fixture();
  try {
    const turnId = randomUUID();
    const older = { ...message(turnId + ':main:older:0', 'older answer'), turnId };
    const recent = { ...message(turnId + ':main:recent:0', 'recent answer'), turnId };
    const echo = { ...message(randomUUID(), recent.text), turnId };
    const imported = message('snapshot-only-import', 'imported history');
    f.events({ type: 'message', message: older }, { type: 'message', message: recent }, { type: 'result', success: true, summary: recent.text }, { type: 'message', message: echo });
    fs.writeFileSync(f.snapshot, JSON.stringify({ sessionId: f.id, taskState: 'completed', pending: [], journalCursor: fs.statSync(f.journal).size, messages: [imported, recent, echo] }));
    const recovered = f.history();
    assert.deepEqual(recovered.get(f.id).messages.map(value => value.id), [imported.id, older.id, recent.id]);
    recovered.flush();
    assert.deepEqual(f.history().get(f.id).messages.map(value => value.id), [imported.id, older.id, recent.id]);
  } finally { f.cleanup(); }
});

test('result echo repair preserves repeated text when provenance, scope, adjacency or full content differs', () => {
  const cases = ['different-turn', 'child', 'noncanonical', 'real-id', 'source-id', 'nonadjacent', 'no-result', 'failed', 'different-prefix', 'older-root'] as const;
  for (const condition of cases) {
    const f = fixture();
    try {
      const turnId = randomUUID();
      const text = condition === 'different-prefix' ? 'original-prefix' + 'x'.repeat(270_000) : 'same reply';
      const block = { ...message(turnId + ':main:msg-a:0', text), turnId, ...(condition === 'child' ? { parentToolUseId: 'child' } : {}) };
      if (condition === 'noncanonical') block.id = 'unrecognized-assistant';
      const summary = condition === 'different-prefix' ? 'different-prefix' + 'x'.repeat(270_000) : text;
      const echo: ChatMessage = { ...message(randomUUID(), summary), turnId: condition === 'different-turn' ? randomUUID() : turnId };
      if (condition === 'real-id') echo.id = turnId + ':main:another-source:0';
      if (condition === 'source-id') echo.sourceId = 'actual-cli-message';
      if (condition === 'failed') echo.isError = true;
      f.events({ type: 'message', message: block });
      if (condition === 'older-root') f.events({ type: 'message', message: { ...message(turnId + ':main:newer:0', 'newer answer'), turnId } });
      if (condition !== 'no-result') f.events({ type: 'result', success: condition !== 'failed', summary });
      if (condition === 'nonadjacent') f.events({ type: 'metadata', model: 'later-event' });
      f.events({ type: 'message', message: echo });
      assert.ok(f.history().getMessage(f.id, echo.id), 'must retain: ' + condition);
    } finally { f.cleanup(); }
  }
});

test('legacy snapshots with identical messages and no journal remain untouched', () => {
  const f = fixture();
  try {
    const messages = [message(randomUUID(), 'same'), message(randomUUID(), 'same')];
    fs.writeFileSync(f.snapshot, JSON.stringify({ sessionId: f.id, taskState: 'completed', pending: [], messages }));
    assert.deepEqual(f.history().get(f.id).messages, messages);
  } finally { f.cleanup(); }
});
