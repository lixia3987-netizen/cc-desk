import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeCredentialStore } from '../src/main/engines/native/credentials';
import { NativeMcpConnectionStore } from '../src/main/engines/native/mcp-connections';
import { registerNativeMcpHandlers } from '../src/main/ipc/native-mcp-handlers';
import type { NativeMcpConnectionView } from '../src/shared/native-mcp';

const sentinel = 'MCP-IPC-SECRET-SENTINEL-12345';
const baseline = { name: 'MCP fixture', endpoint: 'https://example.test/mcp', allowLoopbackHttp: false, enabled: true, auth: { mode: 'memory' } };
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-desk-mcp-ipc-'));
  const store = new NativeMcpConnectionStore(directory, new NativeCredentialStore());
  const handlers = new Map<string, (input?: unknown) => unknown>();
  let changes = 0;
  registerNativeMcpHandlers((name, schema, action) => { handlers.set(name, input => action(schema.parse(input))); }, store, () => changes++);
  const call = (name: string, input?: unknown) => handlers.get(`native:mcp-connections-${name}`)!(input);
  return { directory, store, handlers, call, changes: () => changes, dispose: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test('MCP IPC: exposes only metadata operations and a write-only token channel', () => {
  const f = fixture();
  try {
    assert.deepEqual([...f.handlers.keys()].sort(), ['native:mcp-connections-credential', 'native:mcp-connections-list', 'native:mcp-connections-remove', 'native:mcp-connections-upsert']);
    const created = f.call('upsert', baseline) as NativeMcpConnectionView;
    assert.equal(f.changes(), 1);
    const saved = f.call('credential', { id: created.id, revision: created.revision, mode: 'memory', secret: sentinel }) as NativeMcpConnectionView;
    assert.equal(f.changes(), 2); assert.equal(saved.ready, true);
    assert.equal(f.store.resolve(saved.id).bearerToken, sentinel);
    assert.ok(!JSON.stringify(saved).includes(sentinel));
    assert.ok(!JSON.stringify(f.call('list')).includes(sentinel));
    assert.equal(f.changes(), 2);
    f.call('remove', { id: saved.id, revision: saved.revision });
    assert.equal(f.changes(), 3); assert.equal(f.store.list().connections.length, 0);
  } finally { f.dispose(); }
});

test('MCP IPC: malformed input and stale mutations never echo token material or signal a change', () => {
  const f = fixture();
  try {
    const created = f.call('upsert', baseline) as NativeMcpConnectionView;
    const malformed: Array<[string, unknown]> = [
      ['list', { [sentinel]: true }], ['upsert', { ...baseline, [sentinel]: true }],
      ['remove', { id: created.id, revision: created.revision, [sentinel]: true }],
      ['credential', { id: created.id, revision: created.revision, mode: 'memory', secret: sentinel + '\n' }],
      ['credential', { id: created.id, revision: created.revision, mode: 'memory', secret: sentinel + '密' }],
      ['credential', { id: created.id, revision: created.revision, mode: 'memory', secret: 'a'.repeat(8193) }],
      ['credential', { id: created.id, revision: created.revision, mode: 'memory', secret: sentinel, [sentinel]: true }],
      ['credential', { id: created.id, revision: created.revision + 1, mode: 'memory', secret: sentinel }],
    ];
    for (const [name, input] of malformed) {
      assert.throws(() => f.call(name, input), error => error instanceof Error && !error.message.includes(sentinel));
    }
    assert.equal(f.changes(), 1); assert.equal(f.store.list().connections[0].revision, 1);
    assert.ok(!fs.readFileSync(path.join(f.directory, 'native', 'mcp-connections.json'), 'utf8').includes(sentinel));
  } finally { f.dispose(); }
});
