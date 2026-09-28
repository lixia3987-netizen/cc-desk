import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StateStore } from '../src/main/store';
import { SessionTitles, type SessionTitleGenerator, type SessionTitleRequest } from '../src/main/session-titles';
import { generateClaudeSessionTitle, sessionTitleArguments, titleCleanupSucceeded } from '../src/main/engines/claude/title-generator';
import type { Capabilities, Session } from '../src/shared/types';

const capabilities: Capabilities = { available: true, executable: process.execPath, version: 'fixture',
  flags: ['--print', '--output-format', '--tools', '--strict-mcp-config', '--mcp-config', '--settings', '--no-session-persistence', '--system-prompt', '--model', '--max-turns', '--effort', '--disable-slash-commands'],
  efforts: ['default', 'low'] };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(generate?: SessionTitleGenerator) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-title-agent-'));
  const store = new StateStore(directory);
  const timestamp = new Date().toISOString();
  const session: Session = { id: randomUUID(), projectId: randomUUID(), kind: 'agent', execution: { providerId: 'claude', mode: 'structured', conversationId: randomUUID() },
    title: '新的开发会话', titleSource: 'default', cwd: directory, model: '', effort: 'default', permissionMode: 'default',
    started: false, status: 'idle', archived: false, createdAt: timestamp, updatedAt: timestamp };
  store.change(state => state.sessions.push(session));
  let changes = 0;
  const titles = new SessionTitles(store, () => changes++, generate);
  return { directory, store, session, titles, changes: () => changes,
    current: () => store.state.sessions[0], cleanup: async () => { await titles.cancelAll(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('async titles deduplicate requests and preserve manual renames while generation is pending', async () => {
  let resolve!: (value: string) => void;
  const requests: string[] = [];
  const f = fixture(request => { requests.push(request.prompt); return new Promise(done => { resolve = done; }); });
  try {
    for (const text of ['', ' \n', '/clear', '/resume previous', '!git status']) f.titles.request(f.session.id, text, capabilities);
    await tick(); assert.deepEqual(requests, []);
    f.titles.request(f.session.id, '请检查登录过期后为何反复跳转', capabilities);
    f.titles.request(f.session.id, '另一条消息', capabilities);
    assert.equal(f.current().title, '新的开发会话');
    await tick(); assert.deepEqual(requests, ['请检查登录过期后为何反复跳转']);
    f.store.change(state => { state.sessions[0].title = '我自己的标题'; state.sessions[0].titleSource = 'manual'; });
    resolve('登录重定向排查'); await tick();
    assert.equal(f.current().title, '我自己的标题'); assert.equal(f.changes(), 0);
  } finally { await f.cleanup(); }
});

test('failed summaries keep the default title and can retry; deleted sessions never reappear', async () => {
  let count = 0; let resolve!: (value: string) => void;
  const f = fixture(async () => {
    count++;
    if (count === 1) throw new Error('fixture auth failure');
    if (count === 2) return '不合法的说明\n下一行';
    return new Promise<string>(done => { resolve = done; });
  });
  try {
    for (let i = 0; i < 2; i++) {
      f.titles.request(f.session.id, '原始消息不应该成为标题', capabilities); await tick();
      assert.equal(f.current().title, '新的开发会话'); assert.equal(f.current().titleSource, 'default');
    }
    f.titles.request(f.session.id, '最后一次', capabilities); await tick();
    f.store.change(state => { state.sessions = []; });
    resolve('生成的摘要'); await tick(); assert.equal(f.store.state.sessions.length, 0);
  } finally { await f.cleanup(); }
});

test('generated summaries persist, notify once, and do not trigger another naming request', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return '登录重定向排查'; });
  try {
    f.titles.request(f.session.id, '请检查登录过期后为何反复跳转', capabilities); await tick();
    assert.equal(f.current().title, '登录重定向排查'); assert.equal(f.current().titleSource, 'auto');
    f.titles.request(f.session.id, '后续问题', capabilities); await tick();
    assert.equal(calls, 1); assert.equal(f.changes(), 1);
    assert.equal(new StateStore(f.directory).state.sessions[0].title, '登录重定向排查');
  } finally { await f.cleanup(); }
});

test('cancellation aborts pending work and rejects a late success', async () => {
  let request!: SessionTitleRequest; let resolve!: (value: string) => void;
  const f = fixture(input => { request = input; return new Promise(done => { resolve = done; }); });
  try {
    f.titles.request(f.session.id, '检查状态', capabilities); await tick();
    const cancellation = f.titles.cancel(f.session.id);
    assert.equal(request.signal.aborted, true); assert.equal(f.titles.has(f.session.id), true);
    resolve('过期的状态摘要'); await cancellation;
    assert.equal(f.current().titleSource, 'default'); assert.equal(f.titles.has(f.session.id), false);
  } finally { await f.cleanup(); }
});

test('print arguments isolate the title agent and retain explicit provider model choices', () => {
  const args = sessionTitleArguments({ model: 'custom-provider-model' }, capabilities)!;
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(value('--tools'), ''); assert.equal(value('--output-format'), 'json');
  assert.deepEqual(JSON.parse(value('--mcp-config')), { mcpServers: {} });
  assert.deepEqual(JSON.parse(value('--settings')), { disableAllHooks: true });
  assert.equal(value('--model'), 'custom-provider-model'); assert.equal(value('--effort'), 'low');
  assert.equal(value('--max-turns'), '1'); assert.ok(args.includes('--no-session-persistence'));
  for (const forbidden of ['--resume', '--session-id', '--fork-session', '--dangerously-skip-permissions']) assert.ok(!args.includes(forbidden));
  const defaults = sessionTitleArguments({ model: '' }, capabilities)!;
  assert.ok(!defaults.includes('--model'), 'an empty model retains CLI/settings/provider defaults');
  assert.equal(sessionTitleArguments({ model: '' }, { ...capabilities, flags: capabilities.flags.filter(flag => flag !== '--tools') }), undefined);
});

test('real title subprocess receives stdin only and returns a bounded standalone result', { timeout: 15000 }, async () => {
  const f = fixture();
  try {
    const script = path.join(f.directory, 'title.cjs'); const record = path.join(f.directory, 'request.json');
    fs.writeFileSync(script, `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data', chunk => input+=chunk);process.stdin.on('end', () => {
      require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ input, args: process.argv.slice(2), cwd: process.cwd() }));
      process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'登录重定向排查'}));
    });`);
    const input = 'prefix-' + '中'.repeat(20000) + '-final-request';
    const result = await generateClaudeSessionTitle({ session: f.session, prompt: input, settings: f.store.state.settings, capabilities, signal: new AbortController().signal },
      { invocation: { file: process.execPath, prefix: [script] } });
    assert.equal(result, '登录重定向排查');
    const sent = JSON.parse(fs.readFileSync(record, 'utf8'));
    assert.ok(sent.input.includes('prefix-')); assert.ok(sent.input.includes('-final-request')); assert.ok(sent.input.length < 13000);
    assert.equal(sent.cwd, f.session.cwd); assert.ok(!sent.args.some((arg: string) => arg.includes('prefix-')));
  } finally { await f.cleanup(); }
});

test('real title subprocess failures, malformed results and timeout never return user text', { timeout: 20000 }, async () => {
  const f = fixture();
  try {
    for (const code of [
      `process.stdout.write('not json');`,
      `process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:123}));`,
      `process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'错误进程的标题'}));process.exitCode=2;`,
      `process.stdout.write('x'.repeat(70*1024));`,
      `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`,
    ]) {
      const script = path.join(f.directory, 'failure.cjs'); fs.writeFileSync(script, code);
      const result = await generateClaudeSessionTitle({ session: f.session, prompt: '不要截取这个文本', settings: f.store.state.settings, capabilities, signal: new AbortController().signal },
        { invocation: { file: process.execPath, prefix: [script] }, timeoutMs: 100 });
      assert.equal(result, undefined);
    }
  } finally { await f.cleanup(); }
});


test('Windows title cleanup accepts an already-closed root but not an unconfirmed abort', () => {
  assert.equal(titleCleanupSucceeded(false, true, 'win32'), true);
  assert.equal(titleCleanupSucceeded(false, false, 'win32'), false);
  assert.equal(titleCleanupSucceeded(true, false, 'win32'), true);
  assert.equal(titleCleanupSucceeded(false, true, 'linux'), false, 'POSIX group ownership still includes descendants after root exit');
});
