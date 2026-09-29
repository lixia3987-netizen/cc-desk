import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CLIUpdater, npmInvocation, runUpdateCommand, updateConfiguration } from '../src/main/cli-updater';
import { settingsSchema } from '../src/shared/schema';
import { cliUpdateFixture } from './fixtures/cli-updater';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-updater-')), files = await cliUpdateFixture(root);
  const old = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = files.config;
  const settings = settingsSchema.parse({ claudePath: files.cli, shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000 });
  const updater = new CLIUpdater(() => settings, async () => { throw new Error('npm installations must use their own registry'); });
  return { ...files, root, settings, updater, cleanup: async () => { if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old; await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}
test('npm checks are read-only, respect the channel, and run the selected CLI updater without a shell', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.config, 'settings.json'), JSON.stringify({ autoUpdatesChannel: 'stable' }));
    const plan = await f.updater.check();
    assert.equal(plan.currentVersion, '2.1.9'); assert.equal(plan.latestVersion, '2.1.10'); assert.equal(plan.channel, 'stable');
    const queries = (await fs.readFile(f.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(queries.length, 1); assert.deepEqual(queries[0].args.slice(0, 3), ['view', '@anthropic-ai/claude-code@stable', 'version']);
    await f.updater.install(plan);
    assert.equal(await fs.readFile(f.version, 'utf8'), '2.1.10');
    const update = JSON.parse((await fs.readFile(f.log, 'utf8')).trim().split('\n').at(-1)!);
    assert.deepEqual(update, { kind: 'update', args: ['update'], autoUpdater: '1' });
  } finally { await f.cleanup(); }
});
test('a changed CLI version is rejected before updating and subprocess errors never expose registry credentials', async () => {
  const f = await fixture();
  try {
    const plan = await f.updater.check(); await fs.writeFile(f.version, '2.1.11');
    await assert.rejects(f.updater.install(plan), /已变化/);
    assert.doesNotMatch(await fs.readFile(f.log, 'utf8'), /"update"/);
    await fs.writeFile(f.version, '2.1.9'); await fs.writeFile(f.mode, 'offline');
    await assert.rejects(f.updater.check(), error => { assert.doesNotMatch(String(error), /secret|token|registry.invalid/); return true; });
    await fs.writeFile(f.mode, 'fail');
    await assert.rejects(f.updater.install(plan), error => { assert.match(String(error), /更新失败/); assert.doesNotMatch(String(error), /secret|token/); return true; });
  } finally { await f.cleanup(); }
});
test('updates disabled by CLI configuration are respected and malformed configuration does not silently change channels', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.config, 'settings.json'), JSON.stringify({ env: { DISABLE_UPDATES: '1' } }));
    await assert.rejects(f.updater.check(), /禁用了更新/);
    assert.equal(await fs.readFile(f.log, 'utf8'), '');
    await fs.writeFile(path.join(f.config, 'settings.json'), '{broken');
    assert.throws(() => updateConfiguration({ CLAUDE_CONFIG_DIR: f.config }), /无法读取/);
  } finally { await f.cleanup(); }
});
test('Windows npm shims use their matching Node and npm-cli.js instead of a CMD shell', async () => {
  const f = await fixture();
  try {
    const node = path.join(f.prefix, 'node.exe'); await fs.writeFile(node, 'fixture');
    const command = npmInvocation(f.cli, { PATH: f.prefix }, 'win32');
    assert.equal(command.file, node); assert.deepEqual(command.prefix, [path.join(f.prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js')]);
  } finally { await f.cleanup(); }
});
test('native check only fetches bounded release metadata for the selected channel', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const standalone = path.join(f.root, 'claude');
    await fs.writeFile(standalone, '#!/usr/bin/env node\n' + await fs.readFile(path.join(f.prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'), 'utf8'), { mode: 0o755 });
    f.settings.claudePath = standalone;
    const urls: string[] = [];
    const updater = new CLIUpdater(() => f.settings, async (url, options) => { urls.push(url); assert.equal(options.credentials, 'omit'); return new Response('2.1.10\n'); });
    assert.equal((await updater.check()).latestVersion, '2.1.10');
    assert.deepEqual(urls, ['https://downloads.claude.ai/claude-code-releases/latest']);
    assert.equal(await fs.readFile(f.log, 'utf8'), '');
    const huge = new CLIUpdater(() => f.settings, async () => new Response('2.1.10 ' + 'x'.repeat(10000)));
    await assert.rejects(huge.check(), /检查更新失败/);
  } finally { await f.cleanup(); }
});
test('updater timeout stops its ignoring descendants before releasing the caller', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-update-timeout-')), heartbeat = path.join(root, 'heartbeat');
  const child = `const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),20);`;
  const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
  try {
    await assert.rejects(runUpdateCommand({ file: process.execPath, prefix: ['-e', script] }, process.env as Record<string, string>, 500), /更新超时/);
    const size = (await fs.stat(heartbeat)).size; assert.ok(size > 0);
    await new Promise(resolve => setTimeout(resolve, 150)); assert.equal((await fs.stat(heartbeat)).size, size);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
