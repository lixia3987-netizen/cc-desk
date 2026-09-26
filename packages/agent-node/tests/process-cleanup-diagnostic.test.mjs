import test from 'node:test';
import assert from 'node:assert/strict';
import { ProcessSupervisor } from '../dist/process-supervisor.js';

test('cleanup diagnostics report fixed stage and OS code without command or environment contents', { skip: process.platform === 'win32' }, async () => {
  const secret = 'diagnostic-must-not-copy-command-or-os-error';
  const supervisor = new ProcessSupervisor({ cleanupTimeoutMs: 150, terminationGraceMs: 10 });
  const originalKill = process.kill;
  const running = supervisor.run('diagnostic-owner', {
    executable: process.execPath, argv: ['-e', `/* ${secret} */ setInterval(() => {}, 1000)`], cwd: process.cwd(),
  });
  process.kill = function (pid, signal) {
    if (pid < 0) throw Object.assign(new Error(secret), { code: 'EPERM', path: secret });
    return originalKill.call(process, pid, signal);
  };
  try {
    await assert.rejects(supervisor.stopOwner('diagnostic-owner'), /occupied/);
    const result = await running;
    assert.equal(result.cleanup, 'cleanup_failed');
    assert.equal(result.cleanupDiagnostic.phase, 'posix_terminate');
    assert.equal(result.cleanupDiagnostic.code, 'os_error');
    assert.equal(result.cleanupDiagnostic.osCode, 'EPERM');
    assert.ok(Number.isSafeInteger(result.cleanupDiagnostic.elapsedMs));
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.ok(result.error.length < 1024, 'diagnostics have a bounded fixed schema');
    assert.equal(supervisor.has('diagnostic-owner'), true);
  } finally {
    process.kill = originalKill;
    await supervisor.dispose();
  }
});
