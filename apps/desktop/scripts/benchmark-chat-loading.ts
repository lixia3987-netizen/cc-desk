import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ChatHistory } from '../src/main/chat-history';
import { ChatDisplayReader } from '../src/main/chat-display-reader';

// Synthetic display-log benchmark; does not open an executor or inspect user data.
// Run: node --import tsx apps/desktop/scripts/benchmark-chat-loading.ts
async function main() {
  const counts = process.argv.slice(2).length ? process.argv.slice(2).map(Number) : [100, 1000, 10000];
  if (counts.some(count => !Number.isSafeInteger(count) || count < 1 || count > 100000)) throw new Error('Message counts must be integers from 1 to 100000.');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-desk-chat-benchmark-'));
  const directory = path.join(root, 'chat');
  await fs.mkdir(directory);
  const results: object[] = [];
  try {
    for (const count of counts) {
      const id = randomUUID();
      const file = await fs.open(path.join(directory, id + '.jsonl'), 'wx', 0o600);
      try {
        for (let batch = 0; batch < count; batch += 100) {
          const records = [];
          for (let index = batch; index < Math.min(count, batch + 100); index++) {
            const tool = index % 3 === 2;
            records.push(JSON.stringify({ type: 'message', message: {
              id: `message-${index}`, turnId: `turn-${Math.floor(index / 3)}`, createdAt: '2026-10-16T00:00:00.000Z',
              role: tool ? 'tool' : index % 3 ? 'assistant' : 'user',
              text: tool ? 'tool-output '.repeat(256) : 'conversation '.repeat(80),
              ...(tool ? { toolName: 'read_file', input: { path: 'fixture.ts', content: 'source '.repeat(128) } } : {}),
            } }));
          }
          await file.writeFile(records.join('\n') + '\n');
        }
      } finally { await file.close(); }
      const journalBytes = (await fs.stat(path.join(directory, id + '.jsonl'))).size;
      const history = new ChatHistory(root, () => false, undefined, true);
      const oldStart = performance.now();
      const snapshot = history.get(id);
      const oldMs = performance.now() - oldStart;
      const reader = new ChatDisplayReader(directory);
      const coldStart = performance.now();
      const first = await reader.page(id);
      const coldMs = performance.now() - coldStart;
      const afterCold = reader.statistics;
      const warmStart = performance.now();
      const repeated = await reader.page(id);
      const warmMs = performance.now() - warmStart;
      if (first.messages.at(-1)?.id !== `message-${count - 1}` || repeated.messages.at(-1)?.id !== `message-${count - 1}`) throw new Error('The displayed tail must include the latest message.');
      results.push({ messages: count, journalBytes,
        original: { ms: Number(oldMs.toFixed(2)), displayed: snapshot.messages.length, payloadBytes: Buffer.byteLength(JSON.stringify(snapshot)) },
        display: { coldMs: Number(coldMs.toFixed(2)), warmMs: Number(warmMs.toFixed(2)), displayed: first.messages.length,
          payloadBytes: Buffer.byteLength(JSON.stringify(first)), ...afterCold, warmJournalBytesRead: reader.statistics.journalBytesRead - afterCold.journalBytesRead },
      });
    }
    console.log(JSON.stringify({ fixture: 'synthetic-display-log', excludes: ['executor reconciliation', 'Electron IPC', 'renderer paint'], results }, null, 2));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
