#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { verify } from './acceptance/verify.mjs';
import { baseline, git, suiteRoot, trustedRoot, sha, requireTrusted } from './acceptance/common.mjs';

/** Operator-only fixture QA. No model/service credentials or evaluation CLI integration. */
async function linkInstalledDependencies(root) {
  const destination = path.join(root, 'node_modules'); await fs.mkdir(destination);
  for (const item of await fs.readdir(path.join(trustedRoot, 'node_modules'))) {
    if (item === '@cc-desk' || item === 'claude-workbench') continue;
    await fs.symlink(path.join(trustedRoot, 'node_modules', item), path.join(destination, item), 'junction');
  }
  await fs.mkdir(path.join(destination, '@cc-desk'));
  for (const item of ['contracts', 'engine-claude', 'agent-core', 'agent-node']) await fs.symlink(path.join(root, 'packages', item), path.join(destination, '@cc-desk', item), 'junction');
  await fs.symlink(path.join(root, 'apps/desktop'), path.join(destination, 'claude-workbench'), 'junction');
}
async function suiteDigest() {
  const items = [];
  async function visit(relative = '') {
    for (const name of (await fs.readdir(path.join(suiteRoot, relative))).sort()) {
      const next = path.posix.join(relative, name); if (next === 'validation.json') continue;
      const file = path.join(suiteRoot, next), stat = await fs.lstat(file);
      if (stat.isDirectory()) await visit(next); else if (stat.isFile()) items.push([next, sha(await fs.readFile(file))]);
    }
  }
  await visit(); return sha(JSON.stringify(items));
}
const container = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-desk-e0-'));
const report = { suiteId: 'cc-desk-engineering-v1', taskBaseline: baseline, suiteDigest: await suiteDigest(),
  executedAt: new Date().toISOString(), node: process.version, platform: `${process.platform}/${process.arch}`,
  tooling: { esbuild: requireTrusted('esbuild').version, typescript: requireTrusted('typescript').version, react: requireTrusted('react').version },
  evidenceKind: 'local-fixture', realQualityStatus: 'pending', graphicalAcceptance: 'pending', tasks: [] };
try {
  const manifest = JSON.parse(await fs.readFile(path.join(suiteRoot, 'manifest.json'), 'utf8'));
  for (const task of manifest.tasks) {
    const root = path.join(container, task.id); git(trustedRoot, ['worktree', 'add', '--detach', root, baseline]);
    try {
      await linkInstalledDependencies(root);
      await fs.copyFile(path.join(suiteRoot, task.id, 'TASK.md'), path.join(root, 'TASK.md'));
      const entry = { id: task.id, originalBaselineOracle: 'not_applicable', initial: undefined, reference: undefined, tamperingRejected: false };
      if (task.injection) {
        await verify(task.id, root, { integrity: false, tests: false }); entry.originalBaselineOracle = 'pass';
        git(root, ['apply', path.join(suiteRoot, task.injection)]);
      }
      try { await verify(task.id, root, { integrity: false, tests: false }); throw new Error('initial fixture unexpectedly passed'); }
      catch (error) { if (error.message === 'initial fixture unexpectedly passed') throw error; entry.initial = { status: 'expected_fail', reason: error.message }; }
      git(root, ['apply', path.join(suiteRoot, task.reference)]);
      entry.reference = await verify(task.id, root);
      const protectedPath = 'apps/desktop/tests/chat-snapshot-sync.test.ts';
      const original = await fs.readFile(path.join(root, protectedPath));
      await fs.appendFile(path.join(root, protectedPath), '\n// forbidden baseline test alteration\n');
      await assert.rejects(verify(task.id, root), /Original instructions\/tests\/config must remain unchanged/);
      await fs.writeFile(path.join(root, protectedPath), original); entry.tamperingRejected = true;
      report.tasks.push(entry);
    } finally { git(trustedRoot, ['worktree', 'remove', '--force', root]); }
  }
  console.log(JSON.stringify(report, null, 2));
} finally { await fs.rm(container, { recursive: true, force: true }); }
