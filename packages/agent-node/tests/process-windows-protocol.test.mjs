import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runWindowsTreeCleanup } from '../dist/windows-process-tree.js';

test('failed Windows helper retains late and trailing ancestors before its physical close barrier', async () => {
  const originalSpawn = childProcess.spawn;
  const helper = new EventEmitter();
  helper.stdin = new PassThrough();
  helper.stdout = new PassThrough();
  helper.stderr = new PassThrough();
  let kills = 0;
  helper.kill = () => { kills++; return true; };
  childProcess.spawn = () => helper;
  syncBuiltinESMExports();
  const anchors = [];
  const progress = [];
  let whenClosed;
  try {
    const result = await runWindowsTreeCleanup({
      anchors: [{ pid: 321, exited: true }], environment: {}, timeoutMs: 10,
      onAnchor: anchor => anchors.push(anchor), onProgress: value => progress.push(value),
      onHelper: (_helper, closed) => { whenClosed = closed; },
    });
    assert.equal(result.released, false);
    assert.equal(result.diagnostic.code, 'timeout');
    assert.equal(kills, 1);
    const failedDiagnostic = structuredClone(result.diagnostic);
    const created = '20260926123456123456';
    helper.stdout.write(JSON.stringify({ type: 'anchor', pid: 322, created, minimumCreated: created }) + '\n');
    helper.stdout.write(JSON.stringify({ type: 'result', released: true, phase: 'windows_terminate', code: 'running', snapshots: 1, terminationAttempts: 1, liveProcesses: 0, nativeCode: 0 }) + '\n');
    // The final ownership line was written before helper termination but arrives
    // without a newline. It must be consumed before close releases retry admission.
    helper.stdout.write(JSON.stringify({ type: 'anchor', pid: 323, created: 'tombstone', exited: true, minimumCreated: created }));
    helper.emit('exit', 0, null);
    helper.stdout.end(); helper.stderr.end();
    helper.emit('close', 0, null);
    await whenClosed;
    assert.deepEqual(anchors.map(anchor => anchor.pid), [322, 323]);
    assert.equal(anchors[1].exited, true);
    assert.equal(anchors[1].minimumCreated, created);
    assert.deepEqual(progress, [], 'late progress must not overwrite a subsequent cleanup attempt');
    assert.equal(result.released, false);
    assert.deepEqual(result.diagnostic, failedDiagnostic, 'a published cleanup failure is immutable');
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    helper.stdin.destroy(); helper.stdout.destroy(); helper.stderr.destroy();
  }
});
