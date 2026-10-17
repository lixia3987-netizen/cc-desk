import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EngineConfig, ExecutionDescriptor } from '../src/shared/execution';
import type { Session } from '../src/shared/types';
import type { NativeSessionSkillsSave, NativeSessionSkillsSaved, NativeSessionSkillsView } from '../src/shared/native-skills';
import { NativeSessionSkillsDraftStore, nativeSessionSkillsError } from '../src/renderer/native-session-skills-drafts';
import { SessionConfig, SessionConfigDraftStore } from '../src/renderer/SessionConfig';
import { NativeSessionSkills } from '../src/renderer/components/NativeSessionSkills';

const a = '.agents/skills/available/SKILL.md', b = '.claude/skills/another/SKILL.md', missing = 'tools/missing/SKILL.md';
const policy = (paths: readonly string[]) => ({ mode: 'legacy' as const, autoActivation: false, pins: paths.map(path => ({ kind: 'legacy' as const, path })), disabledIds: [] });
const config = (paths: readonly string[] = [a], version = 2): EngineConfig => ({ schemaVersion: version, options: {
  projectSkills: [...paths], mcpConnections: ['mcp-original'], permissionMode: 'default', ...(version === 2 ? { skills: policy(paths) } : {}),
} });
const view = (paths: readonly string[] = [a], version: 1 | 2 = 2, configDigest = 'original'): NativeSessionSkillsView => ({ schemaVersion: version,
  configDigest, policy: policy(paths), pinDiagnostics: paths.map(path => ({ path, status: path === missing ? 'unavailable' : 'available' })), runtimeEnabled: false });
const saved = (input: NativeSessionSkillsSave, digest = 'saved', extra = {}): NativeSessionSkillsSaved => {
  const paths = input.policy.pins.flatMap(pin => pin.kind === 'legacy' ? [pin.path] : []);
  return { ...view(paths, 2, digest), config: config(paths), migrated: false, backupCreated: false, ...extra };
};
function gate<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function ready(store = new NativeSessionSkillsDraftStore(), paths: string[] = [a], version: 1 | 2 = 2, id = 'one') {
  store.observeConfig(id, config(paths, version)); await store.read(id, { getSessionSkills: async () => view(paths, version) }); return store;
}

test('migration freezes every saved legacy path rather than an unsaved picker selection', async () => {
  const store = await ready(undefined, [a, missing], 1);
  store.change('one', [b]);
  let input!: NativeSessionSkillsSave;
  await store.save('one', { saveSessionSkills: async value => { input = value; return saved(value, 'migrated', { migrated: true, backupCreated: true }); } });
  assert.deepEqual(input.policy, policy([a, missing])); assert.equal(input.expectedConfigDigest, 'original');
  assert.deepEqual(store.get('one')!.selected, [b]); assert.equal(store.get('one')!.dirty, true);
  assert.match(store.get('one')!.notice, /原配置已备份/);
});

test('pending save installs its guard synchronously and keeps subsequent edits after ACK', async () => {
  const store = await ready(), pending = gate<NativeSessionSkillsSaved>(); let writes = 0, input!: NativeSessionSkillsSave;
  store.change('one', [a, b]);
  const api = { saveSessionSkills: async (value: NativeSessionSkillsSave) => { writes++; input = value; return pending.promise; } };
  const first = store.save('one', api); const duplicate = store.save('one', api);
  assert.equal(store.get('one')!.saving, true); assert.equal(writes, 1);
  store.change('one', [b]); pending.resolve(saved(input)); await Promise.all([first, duplicate]);
  assert.deepEqual(store.get('one')!.selected, [b]); assert.equal(store.get('one')!.dirty, true); assert.equal(store.get('one')!.saving, false);
});

test('an uncertain failure retries the exact original digest and policy without clearing newer edits', async () => {
  const store = await ready(); store.change('one', [a, b]);
  const inputs: NativeSessionSkillsSave[] = [];
  await store.save('one', { saveSessionSkills: async input => { inputs.push(input); throw new Error('lost ACK'); } });
  assert.match(store.get('one')!.error, /尚未确认/); store.change('one', [missing]);
  await store.save('one', { saveSessionSkills: async input => { inputs.push(input); return saved(input); } });
  assert.deepEqual(inputs[1], inputs[0]); assert.equal(inputs[1].expectedConfigDigest, 'original');
  assert.match(inputs[1].mutationId, /^[a-f0-9-]{36}$/i);
  assert.deepEqual(store.get('one')!.selected, [missing]); assert.equal(store.get('one')!.dirty, true); assert.equal(store.get('one')!.attempt, undefined);
});

test('a migration ACK lost after host publication can still retry its original request', async () => {
  const store = await ready(undefined, [a, missing], 1), response = gate<NativeSessionSkillsSaved>(); let original!: NativeSessionSkillsSave;
  const pending = store.save('one', { saveSessionSkills: async input => { original = input; return response.promise; } });
  store.observeConfig('one', config([a, missing], 2)); response.reject(new Error('lost ACK')); await pending;
  assert.equal(store.get('one')!.view, undefined); assert.equal(store.get('one')!.conflict, true);
  let retry!: NativeSessionSkillsSave;
  await store.save('one', { saveSessionSkills: async input => { retry = input; return saved(input, 'upgraded', { migrated: true, backupCreated: true }); } });
  assert.deepEqual(retry, original); assert.equal(store.get('one')!.conflict, false); assert.equal(store.get('one')!.dirty, false);
});

test('an unrelated full config change during save remains a conflict when the old ACK arrives', async () => {
  const store = await ready(), response = gate<NativeSessionSkillsSaved>(); let original!: NativeSessionSkillsSave;
  store.change('one', [b]); const pending = store.save('one', { saveSessionSkills: async input => { original = input; return response.promise; } });
  const external = config([a]); external.options.permissionMode = 'read_only'; store.observeConfig('one', external);
  response.resolve(saved(original)); await pending;
  assert.deepEqual(store.get('one')!.config, external); assert.deepEqual(store.get('one')!.selected, [b]);
  assert.equal(store.get('one')!.conflict, true); assert.equal(store.get('one')!.view, undefined);
});

test('a configuration that changes away and back cannot be overwritten by an older save ACK', async () => {
  const store = await ready(), response = gate<NativeSessionSkillsSaved>(); let original!: NativeSessionSkillsSave;
  store.change('one', [b]); const pending = store.save('one', { saveSessionSkills: async input => { original = input; return response.promise; } });
  const external = config([a]); external.options.permissionMode = 'read_only';
  store.observeConfig('one', external); store.observeConfig('one', config([a]));
  response.resolve(saved(original)); await pending;
  assert.deepEqual(store.get('one')!.config, config([a])); assert.deepEqual(store.get('one')!.selected, [b]);
  assert.equal(store.get('one')!.conflict, true); assert.equal(store.get('one')!.view, undefined);
});

test('explicitly abandoning a failed attempt gives an identical new selection a fresh mutation identity', async () => {
  const store = await ready(), inputs: NativeSessionSkillsSave[] = []; store.change('one', [b]);
  await store.save('one', { saveSessionSkills: async input => { inputs.push(input); throw new Error('lost ACK'); } });
  store.resolve('one', false); store.change('one', [b]);
  await store.save('one', { saveSessionSkills: async input => { inputs.push(input); return saved(input); } });
  assert.deepEqual(inputs[0].policy, inputs[1].policy); assert.equal(inputs[0].expectedConfigDigest, inputs[1].expectedConfigDigest);
  assert.notEqual(inputs[0].mutationId, inputs[1].mutationId);
});

test('external permission changes need explicit rebasing and cannot silently refresh a stale save', async () => {
  const store = await ready(); store.change('one', [b]);
  const external = config([a]); external.options.permissionMode = 'read_only'; store.observeConfig('one', external);
  await store.read('one', { getSessionSkills: async () => view([a], 2, 'external-permission-digest') });
  let writes = 0; await store.save('one', { saveSessionSkills: async input => { writes++; return saved(input); } }); assert.equal(writes, 0);
  assert.deepEqual(store.get('one')!.selected, [b]); assert.equal(store.get('one')!.conflict, true);
  store.resolve('one', true);
  await store.save('one', { saveSessionSkills: async input => { writes++; assert.equal(input.expectedConfigDigest, 'external-permission-digest'); return saved(input); } });
  assert.equal(writes, 1);
});

test('stale reads cannot replace a newer config or a different session draft', async () => {
  const store = new NativeSessionSkillsDraftStore(), response = gate<NativeSessionSkillsView>();
  store.observeConfig('one', config([a])); const old = store.read('one', { getSessionSkills: () => response.promise });
  await ready(store, [b], 2, 'two'); store.change('two', [b, missing]);
  const external = config([missing]); store.observeConfig('one', external);
  await store.read('one', { getSessionSkills: async () => view([missing], 2, 'latest') });
  response.resolve(view([a], 2, 'stale')); await old;
  assert.deepEqual(store.get('one')!.selected, [missing]); assert.equal(store.get('one')!.view!.configDigest, 'latest');
  assert.deepEqual(store.get('two')!.selected, [b, missing].sort()); assert.equal(store.get('two')!.dirty, true);
});

test('a failed read preserves choices and an explicit retry recovers them without saving', async () => {
  const store = await ready(); store.change('one', [missing]);
  await store.read('one', { getSessionSkills: async () => { throw new Error('read unavailable'); } });
  assert.deepEqual(store.get('one')!.selected, [missing]); assert.equal(store.get('one')!.loading, false);
  await store.read('one', { getSessionSkills: async () => view() });
  assert.equal(store.get('one')!.error, ''); assert.deepEqual(store.get('one')!.selected, [missing]);
});

test('actionable queue and config conflict messages survive IPC wrapping while raw errors stay private', async () => {
  const store = await ready(); store.change('one', [b]);
  const queueMessage = '请先停止任务、处理恢复状态并清空待发送队列，再保存 Skills。';
  await store.save('one', { saveSessionSkills: async () => { throw new Error(`Error invoking remote method 'native:session-skills-save': Error: ${queueMessage}`); } });
  assert.equal(store.get('one')!.error, queueMessage); assert.deepEqual(store.get('one')!.selected, [b]); assert.ok(store.get('one')!.attempt);
  const conflictMessage = '会话配置已变化，请重新读取 Skills 后保存。';
  await store.read('one', { getSessionSkills: async () => { throw new Error(`Error invoking remote method 'native:session-skills': Error: ${conflictMessage}`); } });
  assert.equal(store.get('one')!.error, conflictMessage); assert.ok(store.get('one')!.attempt);
  assert.equal(nativeSessionSkillsError(new Error('EPERM: operation not permitted, open C:\\private\\workspace.json'), 'fallback'), 'fallback');
  assert.equal(nativeSessionSkillsError(new Error('无法写入 /private/workspace.json，请重试。'), 'fallback'), 'fallback');
});

test('canonical backend ordering does not leave equivalent choices dirty after saving', async () => {
  const store = await ready(); store.change('one', [missing, b, a]);
  await store.save('one', { saveSessionSkills: async input => saved({ ...input, policy: policy([a, b, missing]) }) });
  assert.equal(store.get('one')!.dirty, false); assert.deepEqual(store.get('one')!.selected, [a, b, missing]);
});

test('unsupported catalog policies stay unavailable instead of being coerced into legacy choices', async () => {
  const store = await ready();
  await store.read('one', { getSessionSkills: async () => ({ ...view(), policy: { mode: 'catalog', autoActivation: true, pins: [], disabledIds: [] } }) });
  assert.match(store.get('one')!.error, /尚不支持在此编辑/); assert.deepEqual(store.get('one')!.selected, [a]);
  assert.equal(store.get('one')!.view, undefined);
});

test('the settings draft owner retains independent Skills drafts across sections and sessions', async () => {
  const owner = new SessionConfigDraftStore(); owner.observe('one', config()); owner.observe('two', config([b]));
  await ready(owner.nativeSkills); owner.nativeSkills.change('one', [missing]); await ready(owner.nativeSkills, [b], 2, 'two');
  assert.equal(owner.hasDirty(), true); assert.deepEqual(owner.dirtySessionIds(), ['one']);
  assert.deepEqual(owner.get('one')!.value, config(), 'independent selection cannot alter the ordinary full config draft');
  owner.nativeSkills.resolve('one', false); assert.equal(owner.hasDirty(), false);
});

test('the ordinary save guard checks live Skills pending state before any React redraw', async () => {
  const owner = new SessionConfigDraftStore(); owner.observe('one', config()); await ready(owner.nativeSkills);
  owner.nativeSkills.change('one', [b]); const response = gate<NativeSessionSkillsSaved>(); let input!: NativeSessionSkillsSave;
  const pending = owner.nativeSkills.save('one', { saveSessionSkills: async value => { input = value; return response.promise; } });
  owner.change('one', { ...config(), options: { ...config().options, mcpConnections: ['new-mcp'] } });
  let ordinaryWrites = 0; await owner.save('one', async () => { ordinaryWrites++; });
  assert.equal(ordinaryWrites, 0); assert.equal(owner.get('one')!.dirty, true); assert.equal(owner.get('one')!.busy, false);
  response.resolve(saved(input)); await pending;
});

const session = (version = 2): Session => ({ id: 'one', projectId: 'project', title: 'Manual guides', kind: 'agent', cwd: '/project',
  execution: { providerId: 'native', mode: 'structured', conversationId: 'conversation' }, engineConfig: config([a, missing], version),
  started: false, status: 'stopped', archived: false, createdAt: '', updatedAt: '' });
const descriptor: ExecutionDescriptor = { providerId: 'native', mode: 'structured', displayName: 'Native', configuration: {
  schemaVersion: 2, supportedSchemaVersions: [1, 2], defaults: config(), fields: [] }, capabilities: {
  available: true, structured: true, terminal: false, approvals: true, resume: false, fork: false, commands: false, contextUsage: true, liveConfig: false, attachments: true } };

test('legacy migration is explicit and locked while general config has unsaved changes', async () => {
  const store = await ready(undefined, [a, missing], 1);
  const html = renderToStaticMarkup(createElement(NativeSessionSkills, { session: session(1), store, parentDirty: true }));
  assert.match(html, /技能目录与自动匹配尚未开放/); assert.match(html, /保留已保存的全部路径/);
  assert.match(html, /先保存或放弃会话草稿/); assert.match(html, /disabled=""[^>]*>升级技能配置/);
  assert.doesNotMatch(html, /保存技能选择|type="checkbox"/);
});

test('v2 choices display missing diagnostics and keep ordinary MCP save separate', async () => {
  const owner = new SessionConfigDraftStore(); owner.observe('one', session().engineConfig); await ready(owner.nativeSkills, [a, missing]);
  const html = renderToStaticMarkup(createElement(SessionConfig, { session: session(), descriptor, draftStore: owner, group: 'tools', onError: () => {} }));
  assert.equal((html.match(/aria-label="项目 Skills"/g) ?? []).length, 1); assert.match(html, /保存技能选择/); assert.match(html, /保存配置/);
  assert.match(html, /已选文件读取情况/); assert.match(html, /tools\/missing\/SKILL.md · 当前不可用/);
  assert.match(html, /MCP/); assert.doesNotMatch(html, /升级技能配置/);
});

test('a conflict preserves chosen paths and requires an explicit decision before a fresh save', async () => {
  const store = await ready(undefined, [a, missing]); store.change('one', [b]);
  const external = config([a]); external.options.permissionMode = 'read_only'; store.observeConfig('one', external);
  await store.read('one', { getSessionSkills: async () => view([a], 2, 'changed') });
  const html = renderToStaticMarkup(createElement(NativeSessionSkills, { session: session(), store }));
  assert.match(html, /当前技能选择已保留/); assert.match(html, /基于最新配置保留选择/);
  assert.match(html, /aria-label="\.claude\/skills\/another\/SKILL.md"[^>]*checked=""/);
  assert.match(html, /disabled=""[^>]*>保存技能选择/);
});

test('a bounded diagnostic that did not inspect a pin is displayed as unverified', async () => {
  const store = await ready(undefined, [a]);
  await store.read('one', { getSessionSkills: async () => ({ ...view([a]), pinDiagnostics: [{ path: a, status: 'unverified', message: '本次读取已达到总量限制；选择已保留。' }] }) });
  const html = renderToStaticMarkup(createElement(NativeSessionSkills, { session: session(), store }));
  assert.match(html, /尚未核查/); assert.match(html, /本次读取已达到总量限制/); assert.doesNotMatch(html, /当前不可用|文件损坏/);
});

test('sparse legacy configs keep the same subagent budget display after migration without importing default Skills', () => {
  const supported: ExecutionDescriptor = { ...descriptor, configuration: { schemaVersion: 1, supportedSchemaVersions: [1, 2], defaults: {
    schemaVersion: 1, options: { maxModelRequests: 60, maxToolCalls: 120, maxActiveMs: 1_800_000, maxSubagents: 4,
      projectSkills: [b], mcpConnections: ['default-mcp'] } }, fields: [
    { key: 'maxModelRequests', label: '子请求上限', type: 'number', apply: 'stopped' },
    { key: 'maxToolCalls', label: '子工具上限', type: 'number', apply: 'stopped' },
    { key: 'maxActiveMs', label: '子时长上限', type: 'number', numberScale: 60_000, apply: 'stopped' },
    { key: 'maxSubagents', label: '子并发上限', type: 'number', apply: 'stopped' },
  ] } };
  const sparseV1: EngineConfig = { schemaVersion: 1, options: { projectSkills: [a] } };
  const sparseV2: EngineConfig = { schemaVersion: 2, options: { projectSkills: [a], skills: policy([a]) } };
  for (const engineConfig of [sparseV1, sparseV2]) {
    const original = structuredClone(engineConfig), owner = new SessionConfigDraftStore(); owner.observe('one', engineConfig);
    const value = { ...session(), engineConfig };
    const html = renderToStaticMarkup(createElement(SessionConfig, { session: value, descriptor: supported, draftStore: owner, group: 'limits', onError: () => {} }));
    for (const [label, amount] of [['子请求上限', 60], ['子工具上限', 120], ['子时长上限', 30], ['子并发上限', 4]]) {
      assert.match(html, new RegExp(`aria-label="会话${label}"[^>]*value="${amount}"`));
    }
    const tools = renderToStaticMarkup(createElement(SessionConfig, { session: value, descriptor: supported, draftStore: owner, group: 'tools', onError: () => {} }));
    assert.match(tools, /aria-label="\.agents\/skills\/available\/SKILL.md"[^>]*checked=""/);
    assert.doesNotMatch(tools, /another\/SKILL.md|default-mcp/);
    assert.deepEqual(owner.get('one')!.value, original); assert.deepEqual(engineConfig, original);
    assert.equal(owner.hasDirty(), false);
  }
});
