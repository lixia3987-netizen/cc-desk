import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import type { ToolExecutionContext } from '@cc-desk/agent-core';
import { prepareStartupDataDirectory } from '../src/main/startup-data-directory';
import { StateStore } from '../src/main/store';
import { createAgentDelegationTools, type NativeAgentChildInput, type NativeAgentChildResult, type NativeDelegationReceipt } from '../src/main/engines/native/agent-delegation';
import { loadNativeAgents } from '../src/main/engines/native/agent-projection';

const execute = promisify(execFile);
const linkType = process.platform === 'win32' ? 'junction' : 'dir';
async function temporary(t: { after(fn: () => Promise<void>): void }) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cc-startup-profile-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return directory;
}
async function git(cwd: string, ...args: string[]) {
  return (await execute('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })).stdout.trim();
}
async function repository(directory: string) {
  const cwd = path.join(directory, 'repo'); await fs.mkdir(cwd);
  await git(cwd, 'init', '-b', 'main');
  await git(cwd, 'config', 'user.name', 'Test'); await git(cwd, 'config', 'user.email', 'test@localhost');
  await git(cwd, 'config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(cwd, 'file.txt'), 'initial\n');
  await git(cwd, 'add', '--all'); await git(cwd, 'commit', '-m', 'Initial');
  return cwd;
}
function delegation(store: StateStore, cwd: string, runChild: (input: NativeAgentChildInput) => Promise<NativeAgentChildResult>) {
  const identity = { sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 };
  const signal = new AbortController().signal, receipts = new Map<string, NativeDelegationReceipt>();
  const tools = createAgentDelegationTools({ identity, parentTaskId: randomUUID(), cwd, policy: 'workspace_write', signal,
    forbiddenValues: [], storeDirectory: path.join(store.directory, 'native'), worktreeRoot: path.join(store.directory, 'native', 'agent-worktrees'),
    budget: { consume: async () => true, remainingMs: () => 60000, snapshot: () => ({ modelRequests: 0, toolCalls: 0 }) },
    assertOwnership: async () => {}, runChild, requiresApproval: false, record: async receipt => { receipts.set(receipt.childId, receipt); } });
  const context: ToolExecutionContext = { identity, policyRevision: 'startup-profile', signal, maxOutputBytes: 65536 };
  return { identity, receipts, tools, async run() {
    const prepared = await tools.prepare({ id: randomUUID(), name: 'delegate_implement',
      arguments: JSON.stringify({ baseline: 'head', tasks: [{ title: '独立修改', goal: '在隔离工作树中修改文件' }] }) }, context);
    await tools.validate(prepared, context);
    return tools.execute(prepared, context);
  } };
}
const completed = (input: NativeAgentChildInput): NativeAgentChildResult => ({ identity: input.identity, taskId: input.taskId,
  status: 'completed', reason: 'model_completed', committed: true, summary: '修改完成', modelRequests: 1, toolCalls: 0 });

test('startup preserves profile selection and creates one canonical root for every service', async t => {
  const directory = await temporary(t), real = path.join(directory, 'real'), alias = path.join(directory, 'alias');
  await fs.mkdir(real); await fs.symlink(real, alias, linkType);
  const defaultDirectory = path.join(alias, 'default'), developmentDirectory = path.join(alias, 'development'), profileDirectory = path.join(alias, 'cli');
  const profile = prepareStartupDataDirectory({ defaultDirectory, developmentDirectory, profileDirectory, isPackaged: true });
  assert.equal(profile, path.join(real, 'cli'), 'a CLI profile also takes precedence in a packaged app');
  assert.equal(new StateStore(profile).directory, profile);
  await assert.rejects(fs.stat(path.join(real, 'default')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(real, 'development')), { code: 'ENOENT' });
  assert.equal(prepareStartupDataDirectory({ defaultDirectory, developmentDirectory, isPackaged: false }), path.join(real, 'development'));
  assert.equal(prepareStartupDataDirectory({ defaultDirectory, developmentDirectory, isPackaged: true }), path.join(real, 'default'));
  assert.equal(prepareStartupDataDirectory({ defaultDirectory, profileDirectory: '', developmentDirectory: '', isPackaged: false }), path.join(real, 'default'));
});

test('startup retains custom CLI profile validation', async t => {
  const directory = await temporary(t), options = { defaultDirectory: path.join(directory, 'default'), isPackaged: false };
  assert.throws(() => prepareStartupDataDirectory({ ...options, profileDirectory: 'relative-profile' }), /有效的绝对路径/);
  assert.throws(() => prepareStartupDataDirectory({ ...options, profileDirectory: path.join(directory, 'x'.repeat(4096)) }), /有效的绝对路径/);
  await assert.rejects(fs.stat(options.defaultDirectory), { code: 'ENOENT' });
});

async function failedMainStartup(options: { defaultDirectory: string; profileDirectory?: string; developmentDirectory?: string; isPackaged: boolean }, presentationError?: Error) {
  const mainFile = fileURLToPath(new URL('../src/main/index.ts', import.meta.url));
  const source = ts.transpileModule(await fs.readFile(mainFile, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const events: string[] = [], errors: string[] = [];
  const app = { isPackaged: options.isPackaged, commandLine: { getSwitchValue: () => options.profileDirectory ?? '' },
    getPath: () => options.defaultDirectory,
    setPath: () => { events.push('setPath'); },
    requestSingleInstanceLock: () => { events.push('lock'); return true; },
    whenReady: () => { events.push('ready'); throw new Error('Unexpected service initialization.'); },
    on: () => { events.push('listener'); }, quit: () => { events.push('quit'); } };
  // Evaluate the real entry point with Electron and service boundaries isolated;
  // directory preparation still performs its real filesystem operation.
  const context = vm.createContext({ exports: {}, __dirname: path.dirname(mainFile), Error,
    process: { env: { WORKBENCH_DATA_DIR: options.developmentDirectory, WORKBENCH_TEST_MODE: '1' } },
    require: (name: string) => {
      if (name === 'electron') return { app, dialog: { showErrorBox(title: string, message: string) {
        events.push('error'); assert.equal(title, '启动失败'); errors.push(message);
        if (presentationError) throw presentationError;
      } } };
      if (name === 'node:path') return path;
      if (name === './startup-data-directory') return { prepareStartupDataDirectory };
      if (name === './execution/history-sources') return { HistorySources: class { register() {} } };
      if (name === './store') return { StateStore: class { constructor() { events.push('store'); } } };
      return {};
    } });
  if (presentationError) assert.throws(() => vm.runInContext(source, context, { filename: mainFile }), error => error === presentationError);
  else vm.runInContext(source, context, { filename: mainFile });
  assert.equal(vm.runInContext('allowQuit', context), true);
  assert.deepEqual(events, ['error', 'quit'], 'no lock, ready callback, service or fallback directory is initialized');
  return errors;
}

for (const source of ['default', 'development', 'cli'] as const) {
  test(`${source} profile preparation errors show startup failure and stop before locking or services`, async t => {
    const directory = await temporary(t), blocked = path.join(directory, 'blocked'), unusedDefault = path.join(directory, 'default'), unusedDevelopment = path.join(directory, 'development');
    await fs.writeFile(blocked, 'a file cannot contain a profile directory');
    const unavailable = path.join(blocked, 'profile');
    const errors = await failedMainStartup({ defaultDirectory: source === 'default' ? unavailable : unusedDefault,
      developmentDirectory: source === 'development' ? unavailable : source === 'cli' ? unusedDevelopment : undefined,
      profileDirectory: source === 'cli' ? unavailable : undefined, isPackaged: source !== 'development' });
    assert.equal(errors.length, 1); assert.ok(errors[0].includes('blocked'));
    await assert.rejects(fs.stat(unusedDefault), { code: 'ENOENT' });
    await assert.rejects(fs.stat(unusedDevelopment), { code: 'ENOENT' });
  });
}

test('startup still exits if its error dialog fails', async t => {
  const directory = await temporary(t), blocked = path.join(directory, 'blocked'); await fs.writeFile(blocked, 'file');
  await failedMainStartup({ defaultDirectory: path.join(blocked, 'profile'), isPackaged: true }, new Error('Dialog unavailable.'));
});

for (const source of ['cli', 'development'] as const) {
  test(`${source} profile aliases support durable delegation, worktrees and receipt recovery`, async t => {
    const directory = await temporary(t), cwd = await repository(directory), real = path.join(directory, 'real-profile'), alias = path.join(directory, 'profile-alias');
    await fs.mkdir(real); await fs.symlink(real, alias, linkType);
    const root = prepareStartupDataDirectory({ defaultDirectory: path.join(directory, 'unused'), isPackaged: false,
      ...(source === 'cli' ? { profileDirectory: path.join(alias, 'data') } : { developmentDirectory: path.join(alias, 'data') }) });
    assert.equal(root, path.join(real, 'data'));
    const store = new StateStore(root), parentHead = await git(cwd, 'rev-parse', 'HEAD');
    const f = delegation(store, cwd, async input => {
      assert.equal(input.cwd, await fs.realpath(input.cwd));
      assert.ok(input.cwd.startsWith(`${path.join(root, 'native', 'agent-worktrees')}${path.sep}`));
      await fs.writeFile(path.join(input.cwd, 'file.txt'), 'child change\n');
      return completed(input);
    });
    try {
      assert.equal((await f.run()).status, 'completed');
      const receipt = [...f.receipts.values()][0];
      assert.equal(receipt.status, 'completed'); assert.equal(receipt.workspaceVerified, true);
      assert.deepEqual(JSON.parse(await fs.readFile(receipt.receiptPath, 'utf8')), receipt);
      assert.match(await fs.readFile(receipt.artifact!.patchPath, 'utf8'), /\+child change/);
      const restored = await loadNativeAgents(store.directory, f.identity);
      assert.deepEqual(restored.receipts(), [receipt]);
      assert.equal(restored.snapshot().items[0].status, 'completed');
      assert.equal(restored.snapshot().incomplete, undefined);
      assert.equal(await git(cwd, 'rev-parse', 'HEAD'), parentHead);
      assert.equal(await git(cwd, 'status', '--porcelain'), '');
      assert.equal(await fs.readFile(path.join(cwd, 'file.txt'), 'utf8'), 'initial\n');
    } finally { await f.tools.closeAll(); }
  });
}

for (const descendant of ['delegations', 'agent-worktrees'] as const) {
  test(`canonical startup roots still reject a replaced ${descendant} descendant`, async t => {
    const directory = await temporary(t), cwd = await repository(directory), real = path.join(directory, 'real-profile'), alias = path.join(directory, 'profile-alias');
    await fs.mkdir(real); await fs.symlink(real, alias, linkType);
    const root = prepareStartupDataDirectory({ defaultDirectory: alias, isPackaged: false }), store = new StateStore(root);
    const native = path.join(root, 'native'), target = path.join(native, descendant), outside = path.join(directory, 'outside');
    await fs.mkdir(target, { recursive: true }); await fs.mkdir(outside);
    await fs.rmdir(target); await fs.symlink(outside, target, linkType);
    let launches = 0;
    const f = delegation(store, cwd, async input => { launches++; return completed(input); });
    try {
      const result = await f.run();
      assert.equal(result.status, descendant === 'delegations' ? 'unknown' : 'failed');
      assert.match(JSON.stringify(result.output), descendant === 'delegations' ? /delegation_intent_unconfirmed/ : /baseline_materialization_failed/);
      assert.equal(launches, 0);
      assert.deepEqual(await fs.readdir(outside), []);
      assert.equal(await git(cwd, 'status', '--porcelain'), '');
    } finally { await f.tools.closeAll(); }
  });
}
