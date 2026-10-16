import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { formatNativeDiagnostic, reportNativeDiagnostic, NATIVE_DIAGNOSTIC_CODES } from '../src/main/engines/native/diagnostic';
import { NativeProjection } from '../src/main/engines/native/projection';
import { ExecutionEvents } from '../src/main/execution/events';
import type { BeginRunRequest } from '@cc-desk/agent-core';
import type { Session } from '../src/shared/types';

const prefix = '[cc-desk:native-diagnostic]';
const parse = (line: string) => JSON.parse(line.slice(prefix.length));
const secret = 'sk-private-code-message-path-stack-never-log';

test('Native diagnostic output contains only fixed stages and whitelisted codes, never arbitrary error fields', () => {
  for (const code of NATIVE_DIAGNOSTIC_CODES) {
    const error = Object.assign(new Error(secret), { code, path: `/private/${secret}`, config: { secret }, toJSON() { throw new Error(secret); } });
    assert.deepEqual(parse(formatNativeDiagnostic('rename', error)), { stage: 'rename', code });
  }
  for (const code of [secret, `EPERM:${secret}`, { toString() { throw new Error(secret); } }, undefined, 123]) {
    const output = formatNativeDiagnostic(secret, { code, message: secret, stack: secret });
    assert.deepEqual(parse(output), { stage: 'other', code: 'unknown' });
    assert.equal(output.includes(secret), false);
  }
  assert.equal(Object.isFrozen(NATIVE_DIAGNOSTIC_CODES), true);
});

test('diagnostics do not evaluate error accessors, serialization hooks or hostile proxies', () => {
  let accessed = 0;
  const error = Object.defineProperties({}, {
    code: { get() { accessed++; throw new Error(secret); } },
    message: { get() { accessed++; throw new Error(secret); } },
    stack: { get() { accessed++; throw new Error(secret); } },
    toJSON: { get() { accessed++; throw new Error(secret); } },
  });
  assert.deepEqual(parse(formatNativeDiagnostic('execute', error)), { stage: 'execute', code: 'unknown' });
  assert.equal(accessed, 0);
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(secret); } });
  assert.deepEqual(parse(formatNativeDiagnostic('other', proxy)), { stage: 'other', code: 'unknown' });
});

test('diagnostics are opt-in and a failed stderr sink cannot change execution', t => {
  const previous = process.env.CC_DESK_CHAT_PERF;
  t.after(() => { if (previous === undefined) delete process.env.CC_DESK_CHAT_PERF; else process.env.CC_DESK_CHAT_PERF = previous; });
  const lines: unknown[][] = [];
  const output = t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args); });
  delete process.env.CC_DESK_CHAT_PERF; reportNativeDiagnostic('execute', { code: 'protocol', message: secret });
  process.env.CC_DESK_CHAT_PERF = 'true'; reportNativeDiagnostic('execute', { code: 'protocol', message: secret });
  assert.deepEqual(lines, []);
  process.env.CC_DESK_CHAT_PERF = '1'; reportNativeDiagnostic('execute', { code: 'protocol', message: secret });
  assert.deepEqual(lines, [[prefix + '{"stage":"execute","code":"protocol"}']]);
  output.mock.mockImplementation(() => { throw new Error(secret); });
  assert.doesNotThrow(() => reportNativeDiagnostic('other', { code: secret }));
});

for (const stage of ['write', 'sync', 'rename'] as const) test(`real Native projection ${stage} failure reports only safe classification and preserves the original rejection`, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-diagnostic-'));
  const id = randomUUID(), conversationId = randomUUID();
  const ledger = await NativeRunStore.open({ rootDirectory: path.join(directory, 'native'), conversationId });
  const session: Session = { id, projectId: randomUUID(), title: 'diagnostic', kind: 'agent', cwd: directory,
    execution: { providerId: 'native', mode: 'structured', conversationId }, started: true, engineConfig: { schemaVersion: 1, options: {} },
    status: 'running', archived: false, createdAt: '', updatedAt: '' };
  const projection = new NativeProjection(directory, new ExecutionEvents(), () => session, () => true, () => {});
  const request: BeginRunRequest = { identity: { sessionId: id, conversationId, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 },
    input: secret, inputDigest: 'digest', userItems: [{ role: 'user', content: secret }], protocol: { id: 'openai-responses', version: 1 },
    configuration: { model: 'fixture' }, policyRevision: 'test' };
  const error = Object.assign(new Error(secret), { code: 'EPERM', path: directory });
  const previous = process.env.CC_DESK_CHAT_PERF;
  const lines: string[] = [];
  t.mock.method(console, 'error', (line: string) => { lines.push(line); });
  process.env.CC_DESK_CHAT_PERF = '1';
  try {
    await ledger.beginRun(request);
    if (stage === 'rename') {
      const rename = fs.rename;
      t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
        if (args[1] === path.join(directory, 'chat', id + '.jsonl')) throw error;
        return rename(...args);
      });
    } else {
      const open = fs.open;
      t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (String(args[0]).includes(id + '.native-') && args[1] === 'wx') {
          if (stage === 'write') t.mock.method(handle, 'writeFile', async () => { throw error; });
          else t.mock.method(handle, 'sync', async () => { throw error; });
        }
        return handle;
      });
    }
    await assert.rejects(projection.hydrate(id, ledger), problem => problem === error);
    assert.deepEqual(lines.map(parse), [{ stage, code: 'EPERM' }]);
    assert.equal(lines.join('\n').includes(secret), false);
    assert.equal(lines.join('\n').includes(directory), false);
    assert.equal(ledger.listRuns()[0].status, 'active', 'diagnostics do not repair or alter durable execution state');
  } finally {
    if (previous === undefined) delete process.env.CC_DESK_CHAT_PERF; else process.env.CC_DESK_CHAT_PERF = previous;
    projection.flush(); await ledger.close(); await fs.rm(directory, { recursive: true, force: true });
  }
});
