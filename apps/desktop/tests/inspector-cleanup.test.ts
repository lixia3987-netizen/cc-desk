import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ElectronApplication, TestInfo } from '@playwright/test';
import { finishInspectorApp, installInspectorStopDiagnostics, readInspectorStopDiagnostics } from './helpers/inspector-cleanup';

test('inspector stop diagnostics preserve the real handler and retain only bounded lifecycle fields', async () => {
  const secret = 'private-command-path-credential';
  const native = Object.assign(new Error('Windows process descendants have not released. ' + JSON.stringify({
    phase: 'windows_snapshot', code: 'identity_changed', snapshots: 2, terminationAttempts: 0, liveProcesses: 1,
    helperStage: 'capture', nativeCode: 5, command: secret, stack: secret,
  })), { cleanupPhase: 'windows.tree', code: secret, path: secret });
  const failure = new AggregateError([new Error(secret, { cause: native })], secret);
  const calls: unknown[][] = [];
  const original = async (...args: unknown[]) => { calls.push(args); if (args[1] !== 'success') throw failure; return 'unchanged'; };
  const handlers = new Map([['session:stop', original]]);
  const ipcMain = {
    _invokeHandlers: handlers,
    removeHandler: (channel: string) => { handlers.delete(channel); },
    handle: (channel: string, handler: typeof original) => { handlers.set(channel, handler); },
  };
  // The exact function passed to app.evaluate must work without module closures.
  const install = new Function(`return (${installInspectorStopDiagnostics.toString()})`)() as typeof installInspectorStopDiagnostics;
  install({ ipcMain } as unknown as Pick<typeof import('electron'), 'ipcMain'>, 'target');
  const event = {};
  try {
    const invoke = handlers.get('session:stop')!;
    assert.equal(await invoke(event, 'success'), 'unchanged');
    await assert.rejects(invoke(event, 'other-session'), error => error === failure);
    assert.deepEqual(readInspectorStopDiagnostics(), []);
    await assert.rejects(invoke(event, 'target'), error => error === failure);
    assert.equal(calls.length, 3);
    assert.equal(calls[2][0], event);
    assert.deepEqual(readInspectorStopDiagnostics(), [{ errors: [{ cause: { cleanupPhase: 'windows.tree', windows: {
      phase: 'windows_snapshot', code: 'identity_changed', helperStage: 'capture', snapshots: 2,
      terminationAttempts: 0, liveProcesses: 1, nativeCode: 5,
    } } }] }]);
    assert.equal(JSON.stringify(readInspectorStopDiagnostics()).includes(secret), false);
  } finally { delete (globalThis as typeof globalThis & { inspectorStopDiagnostics?: unknown[] }).inspectorStopDiagnostics; }
});

function fixture(stopFailure?: Error, closeFailure?: Error) {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    kill(signal: NodeJS.Signals) {
      assert.equal(signal, 'SIGKILL');
      calls.push('kill-original-child');
      queueMicrotask(() => { child.signalCode = signal; child.emit('exit', null, signal); });
      return true;
    },
  });
  const calls: string[] = [];
  const app = {
    process: () => child,
    windows: () => [{ isClosed: () => false, evaluate: async () => { calls.push('stop'); if (stopFailure) throw stopFailure; } }],
    evaluate: async () => [{ cleanupPhase: 'windows.tree', code: 'identity_changed' }],
    close: async () => {
      calls.push('close');
      if (closeFailure) throw closeFailure;
      // The process exit notification may arrive after Playwright close resolves.
      setImmediate(() => { child.exitCode = 0; child.emit('exit', 0, null); });
    },
  } as unknown as ElectronApplication;
  const attachments: string[] = [];
  const attach: TestInfo['attach'] = async (_name, options) => { attachments.push(String(options?.body)); };
  return { app, child, calls, attachments, attach };
}

test('inspector failure recovery retains assertion and stop errors after the original test process exits', async () => {
  const primary = new Error('layout assertion failed'), stop = new Error('stop failed');
  const f = fixture(stop);
  await assert.rejects(finishInspectorApp(f.app, 'target', f.attach, [primary]), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [primary, stop]);
    assert.equal(error.cause, primary);
    return true;
  });
  assert.deepEqual(f.calls, ['stop', 'kill-original-child']);
  assert.equal(f.child.signalCode, 'SIGKILL');
  assert.equal(f.child.listenerCount('exit'), 0);
  assert.equal(f.attachments.length, 1);
  assert.equal(JSON.parse(f.attachments[0]).phase, 'stop');
  assert.equal(f.attachments[0].includes(stop.message), false);
});

test('inspector close failure remains failed after recovery while a normal exit never needs force termination', async () => {
  const close = new Error('close failed'), f = fixture(undefined, close);
  await assert.rejects(finishInspectorApp(f.app, 'target', f.attach, []), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [close]);
    return true;
  });
  assert.deepEqual(f.calls, ['stop', 'close', 'kill-original-child']);
  assert.equal(JSON.parse(f.attachments[0]).phase, 'close');
  const normal = fixture();
  await finishInspectorApp(normal.app, 'target', normal.attach, []);
  assert.deepEqual(normal.calls, ['stop', 'close']);
  assert.equal(normal.attachments.length, 0);
});
