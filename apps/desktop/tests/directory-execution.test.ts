import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalDirectory, DirectoryExecutionCoordinator } from '../src/main/directory-execution';

test('directory acquisition is atomic across roots and blocks same-root/ancestor/descendant across providers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'directory-owner-'));
  try {
    const a = path.join(root, 'a'), b = path.join(root, 'b'), child = path.join(a, 'src');
    await fs.mkdir(child, { recursive: true }); await fs.mkdir(b);
    const coordinator = new DirectoryExecutionCoordinator();
    const held = coordinator.acquire({ sessionId: 'native', providerId: 'native', generation: 1 }, [a, child]);
    for (const providerId of ['native', 'claude', 'shell']) {
      assert.throws(() => coordinator.acquire({ sessionId: providerId + '-other', providerId, generation: 1 }, [a]), /native.*占用/);
      assert.throws(() => coordinator.acquire({ sessionId: providerId + '-other', providerId, generation: 1 }, [child]), /占用/);
      assert.throws(() => coordinator.acquire({ sessionId: providerId + '-other', providerId, generation: 1 }, [root]), /占用/);
    }
    assert.throws(() => coordinator.acquire({ sessionId: 'failed', providerId: 'shell', generation: 1 }, [b, child]), /占用/);
    const independent = coordinator.acquire({ sessionId: 'independent', providerId: 'shell', generation: 1 }, [b]);
    assert.equal(coordinator.size, 2, 'failed multi-root acquisition must not reserve its nonconflicting root');
    coordinator.release(held);
    const replacement = coordinator.acquire({ sessionId: 'native', providerId: 'native', generation: 2 }, [a]);
    assert.throws(() => coordinator.release(held), /旧执行代次/);
    assert.equal(coordinator.owns(replacement), true);
    coordinator.release(replacement); coordinator.release(independent);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('canonical aliases and missing descendants cannot escape an existing lease', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'directory-alias-'));
  try {
    const target = path.join(root, 'target'), alias = path.join(root, 'alias');
    await fs.mkdir(target); await fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(canonicalDirectory(alias), canonicalDirectory(target));
    const coordinator = new DirectoryExecutionCoordinator();
    coordinator.acquire({ sessionId: 'owner', providerId: 'claude', generation: 1 }, [target]);
    assert.throws(() => coordinator.acquire({ sessionId: 'other', providerId: 'shell', generation: 1 }, [path.join(alias, 'not-created')]), /占用/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('renewing a retained outer owner invalidates the old generation without unlocking its roots', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'directory-generation-'));
  try {
    const coordinator = new DirectoryExecutionCoordinator();
    const original = coordinator.acquire({ sessionId: 'queue', providerId: 'native', generation: 1 }, [root]);
    const renewed = coordinator.acquire({ sessionId: 'queue', providerId: 'native', generation: 2 }, [root]);
    assert.notEqual(renewed.token, original.token);
    assert.equal(coordinator.size, 1);
    assert.equal(coordinator.owns(original), false);
    assert.throws(() => coordinator.release(original), /旧执行代次/);
    assert.throws(() => coordinator.acquire({ sessionId: 'shell', providerId: 'shell', generation: 1 }, [root]), /占用/);
    assert.equal(coordinator.owns(renewed), true);
    coordinator.release(renewed);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
