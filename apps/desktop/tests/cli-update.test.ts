import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIUpdateService, cliVersion, newerVersion, type CLIUpdateActions, type CLIUpdateCandidate } from '../src/main/cli-update-service';

const candidate: CLIUpdateCandidate = { identity: 'fixture', currentVersion: '2.1.9', latestVersion: '2.1.10', channel: 'latest' };
const caps = (version: string) => ({ available: true, executable: 'fixture', version, flags: [], efforts: [] });
function fixture(overrides: Partial<CLIUpdateActions> = {}) {
  const calls: string[] = [];
  const service = new CLIUpdateService({
    check: async () => { calls.push('check'); return candidate; },
    confirm: async () => { calls.push('confirm'); return true; },
    verify: async () => { calls.push('verify'); },
    disconnect: async action => { calls.push('disconnect'); const result = await action(); calls.push('release'); return result; },
    install: async () => { calls.push('install'); }, refresh: async () => { calls.push('refresh'); return caps('2.1.10 (Claude Code)'); },
    changed: () => {}, ...overrides,
  });
  return { service, calls };
}
test('version comparison handles numeric order, prereleases and build metadata without downgrades', () => {
  assert.equal(cliVersion('2.1.10 (Claude Code)'), '2.1.10');
  assert.equal(newerVersion('2.1.10', '2.1.9'), true);
  assert.equal(newerVersion('2.1.9', '2.1.10'), false);
  assert.equal(newerVersion('2.1.10', '2.1.10-beta.12'), true);
  assert.equal(newerVersion('2.1.10-beta.12', '2.1.10-beta.9'), true);
  assert.equal(newerVersion('2.1.10-beta.12', '2.1.10'), false);
  assert.equal(newerVersion('2.1.10+build2', '2.1.10+build1'), false);
  assert.throws(() => cliVersion('<html>2.1.10</html>'));
});
test('startup check and dismiss never confirm, disconnect or install; a fresh launch prompts again', async () => {
  const f = fixture();
  await f.service.check(); assert.equal(f.service.state.phase, 'available');
  f.service.dismiss(); assert.equal(f.service.state.showBanner, false);
  assert.deepEqual(f.calls, ['check']);
  const next = fixture(); await next.service.check(); assert.equal(next.service.state.showBanner, true);
});
test('confirmation cancellation leaves every workspace running and preserves the offer', async () => {
  const f = fixture({ confirm: async () => false });
  await f.service.check(); await f.service.update();
  assert.deepEqual(f.calls, ['check']); assert.equal(f.service.state.phase, 'available'); assert.equal(f.service.busy, false);
});
test('install is ordered after confirmation and complete disconnection, followed by fresh capability detection', async () => {
  const f = fixture(); await f.service.check(); await f.service.update();
  assert.deepEqual(f.calls, ['check', 'confirm', 'verify', 'disconnect', 'verify', 'install', 'refresh', 'release']);
  assert.equal(f.service.state.phase, 'updated'); assert.equal(f.service.state.currentVersion, '2.1.10');
});
test('failure to disconnect any workspace never starts an updater', async () => {
  const f = fixture({ disconnect: async () => { throw new Error('workspace could not stop'); } });
  await f.service.check(); await f.service.update();
  assert.equal(f.calls.includes('install'), false); assert.equal(f.service.state.phase, 'error'); assert.equal(f.service.busy, false);
});
test('changed installation after confirmation requires a new check and confirmation', async () => {
  const f = fixture({ verify: async () => { throw new Error('path changed'); } });
  await f.service.check(); await f.service.update();
  assert.deepEqual(f.calls, ['check', 'confirm']); assert.equal(f.service.state.phase, 'error');
  await assert.rejects(f.service.update(), /先检查/);
});
test('failed installer refreshes capability information and allows an explicit retry', async () => {
  let fail = true;
  const f = fixture({ install: async () => { if (fail) throw new Error('installer failed'); } });
  await f.service.check(); await f.service.update();
  assert.equal(f.service.state.phase, 'error'); assert.match(f.service.state.message, /Claude 会话保持断开/); assert.ok(f.calls.includes('refresh'));
  fail = false; await f.service.check(); await f.service.update(); assert.equal(f.service.state.phase, 'updated');
});
test('zero exit with unchanged version or an unusable CLI is not reported as a successful upgrade', async () => {
  for (const capability of [caps('2.1.9'), { ...caps(''), available: false }]) {
    const f = fixture({ refresh: async () => capability });
    await f.service.check(); await f.service.update(); assert.equal(f.service.state.phase, 'error');
  }
});
test('quitting invalidates confirmation and every pre-install verification without starting the installer', async () => {
  for (const phase of ['confirm', 'first-verify', 'disconnect', 'second-verify'] as const) {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    let verifies = 0, installs = 0;
    const gate = async () => { enter(); await waiting; };
    const f = fixture({
      confirm: async () => { if (phase === 'confirm') await gate(); return true; },
      verify: async () => { verifies++; if ((verifies === 1 && phase === 'first-verify') || (verifies === 2 && phase === 'second-verify')) await gate(); },
      disconnect: async action => { if (phase === 'disconnect') await gate(); return action(); },
      install: async () => { installs++; },
    });
    await f.service.check();
    const update = f.service.update();
    await entered;
    assert.equal(f.service.cancelPendingUpdate(), true);
    release(); await update;
    assert.equal(installs, 0, phase); assert.equal(f.service.busy, false);
    assert.match(f.service.state.message, /正在退出/);
  }
});
test('quitting cannot cancel an installer that has already begun writing', async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ install: async () => { enter(); await waiting; } });
  await f.service.check(); const update = f.service.update(); await entered;
  assert.equal(f.service.state.phase, 'updating');
  assert.equal(f.service.cancelPendingUpdate(), false);
  release(); await update;
  assert.equal(f.service.state.phase, 'updated'); assert.ok(f.calls.includes('refresh'));
});
test('double clicks, path changes and checks cannot race the confirmation or update', async () => {
  let confirm!: (value: boolean) => void;
  const f = fixture({ confirm: () => new Promise(resolve => { confirm = resolve; }) });
  await f.service.check(); const update = f.service.update();
  await assert.rejects(f.service.update(), /正在更新/); assert.throws(() => f.service.reset(), /正在更新/);
  await f.service.check(); assert.deepEqual(f.calls, ['check']); f.service.dismiss(); assert.equal(f.service.state.showBanner, true);
  confirm(true); await update; assert.equal(f.calls.filter(call => call === 'install').length, 1);
});
test('old checks cannot overwrite a new path and check failures leave normal work available', async () => {
  let finish!: (candidate: CLIUpdateCandidate) => void, checks = 0;
  const f = fixture({ check: () => ++checks === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ...candidate, currentVersion: '2.2.0' }) });
  const old = f.service.check(); assert.equal(f.service.check(), old);
  f.service.reset(); await f.service.check(); finish(candidate); await old;
  assert.equal(f.service.state.phase, 'current'); assert.equal(f.service.state.currentVersion, '2.2.0');
  const failure = fixture({ check: async () => { throw new Error('offline'); } });
  await failure.service.check(); assert.equal(failure.service.busy, false); assert.equal(failure.service.state.showBanner, false);
  assert.deepEqual(failure.calls, []);
});
