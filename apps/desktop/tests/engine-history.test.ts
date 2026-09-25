import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HistorySources } from '../src/main/execution/history-sources';
import { OfflineHistory } from '../src/main/execution/offline-history';

test('external histories retain provider identity across identical conversation IDs and pagination', async () => {
  const sources = new HistorySources();
  const calls: { providerId: string; cwd: string; offset?: number }[] = [];
  for (const providerId of ['claude', 'test.native']) sources.register(providerId, async (cwd, options) => {
    calls.push({ providerId, cwd, offset: options.offset });
    return { entries: [{ id: 'same-conversation', title: providerId, cwd, modifiedAt: '2026-09-25' }], total: 4, nextOffset: (options.offset ?? 0) + 1 };
  });
  const first = await sources.query('/project', { providerId: 'claude', offset: 0 });
  const second = await sources.query('/project', { providerId: 'test.native', offset: 2 });
  assert.equal(first.entries[0].providerId, 'claude');
  assert.equal(second.entries[0].providerId, 'test.native');
  assert.equal(first.entries[0].id, second.entries[0].id);
  assert.equal(second.nextOffset, 3);
  assert.deepEqual(calls, [{ providerId: 'claude', cwd: '/project', offset: 0 }, { providerId: 'test.native', cwd: '/project', offset: 2 }]);
  await assert.rejects(sources.query('/project', { providerId: 'missing' }), /不支持外部历史导入/);
  assert.equal(calls.length, 2, 'Missing providers must not fall back to Claude history');
});

test('offline display replay removes old approvals without rewriting or creating engine records', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdesk-offline-engine-'));
  try {
    const chat = path.join(directory, 'chat'); fs.mkdirSync(chat);
    const originals = new Map<string, string>();
    const ids = Array.from({ length: 12 }, () => randomUUID());
    for (const id of ids) {
      const snapshot = JSON.stringify({ sessionId: id, taskState: 'waiting_approval', pending: [{ requestId: 'stale', kind: 'permission', toolName: 'Write', input: {}, createdAt: '2026-09-25' }], messages: [{ id: 'message', turnId: 'turn', role: 'user', text: 'saved search phrase', createdAt: '2026-09-25' }] });
      const file = path.join(chat, `${id}.json`); originals.set(file, snapshot); fs.writeFileSync(file, snapshot);
    }
    const reader = new OfflineHistory(directory);
    for (const id of ids) {
      const snapshot = reader.snapshot(id, '未安装引擎');
      assert.deepEqual(snapshot.pending, []);
      assert.equal(snapshot.taskState, 'interrupted');
      assert.equal(snapshot.queue?.paused, true);
      assert.equal(snapshot.messages[0].text, 'saved search phrase');
    }
    assert.equal((await reader.search(ids[0], '未安装引擎', 'search phrase')).hits.length, 1);
    assert.equal((await reader.page(ids[0], '未安装引擎')).messages.length, 1);
    const missing = reader.snapshot(randomUUID(), '未知配置版本');
    assert.match(missing.error!, /没有可读取/);
    assert.deepEqual(missing.messages, []);
    assert.deepEqual(fs.readdirSync(chat).sort(), [...originals.keys()].map(file => path.basename(file)).sort());
    for (const [file, content] of originals) assert.equal(fs.readFileSync(file, 'utf8'), content, 'Cache eviction must not persist an offline projection');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
