import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cliInvocation, detectCLI } from '@cc-desk/engine-claude/commands';

test('CLI launch uses host resolution and enriches the same environment passed to spawn', () => {
  const env = { PATH: '/host/bin', KEEP: 'host-value' };
  const calls = [];
  const host = {
    environment() { throw new Error('The caller already provided the launch environment.'); },
    findExecutable(name, received, platform) {
      calls.push({ name, received, platform });
      return process.execPath;
    },
  };
  const launch = cliInvocation({ claudePath: 'selected-claude' }, env, host);
  assert.deepEqual(launch, { file: process.execPath, prefix: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'selected-claude');
  assert.equal(calls[0].received, env);
  assert.equal(env.DISABLE_AUTOUPDATER, '1');
  assert.equal(env.KEEP, 'host-value');
});

test('CLI detection uses the host environment and does not expose host failure details', async () => {
  const env = { PATH: '/host/bin' };
  let environments = 0;
  let resolutions = 0;
  const capabilities = await detectCLI({ claudePath: '' }, {
    environment() { environments++; return env; },
    findExecutable(name, received) {
      resolutions++;
      assert.equal(name, 'claude');
      assert.equal(received, env);
      throw new Error('private-host-value');
    },
  });
  assert.equal(environments, 1);
  assert.equal(resolutions, 1);
  assert.equal(capabilities.available, false);
  assert.ok(capabilities.error);
  assert.ok(!capabilities.error.includes('private-host-value'));
});
