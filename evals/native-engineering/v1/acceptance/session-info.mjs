import assert from 'node:assert/strict';
import { load, source, requireTrusted } from './common.mjs';
export default async function verify(root) {
  const handlers = new Map();
  const { registerSessionHandlers } = await load(root, 'apps/desktop/src/main/ipc/session-handlers.ts');
  const sessions = [
    { id: '11111111-1111-4111-8111-111111111111', title: '<private title>', archived: false, cwd: '/private/workspace', engineConfig: { secret: 'must-not-leak' }, execution: { providerId: 'native', mode: 'structured' } },
    { id: '22222222-2222-4222-8222-222222222222', title: '历史记录', archived: true, worktree: '/private/worktree', execution: { providerId: 'claude', mode: 'terminal' } },
  ];
  registerSessionHandlers((name, schema, action) => handlers.set(name, { schema, action }), { session: id => { const item = sessions.find(value => value.id === id); if (!item) throw new Error('unknown session'); return item; } });
  const handler = handlers.get('session:info'); assert.ok(handler, 'register readonly session:info');
  assert.throws(() => handler.schema.parse('')); assert.throws(() => handler.schema.parse({ id: 'one' }));
  const before = JSON.stringify(sessions);
  for (const item of sessions) {
    const output = await handler.action(handler.schema.parse(item.id));
    assert.deepEqual(output, { sessionId: item.id, title: item.title, providerId: item.execution.providerId, mode: item.execution.mode, archived: item.archived, workspaceKind: item.worktree ? 'worktree' : 'project' });
  }
  assert.equal(JSON.stringify(sessions), before); assert.throws(() => handler.action('missing'));
  let api; const invokes = [];
  globalThis.__e0Electron = { contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'desktop'); api = value; } },
    ipcRenderer: { invoke: (...args) => { invokes.push(args); return Promise.resolve({ sessionId: args[1] }); }, on() {}, removeListener() {} }, webUtils: {} };
  try { await load(root, 'apps/desktop/src/preload/index.ts', { electron: true }); await api.getSessionInfo('one'); assert.deepEqual(invokes, [['session:info', 'one']]); }
  finally { delete globalThis.__e0Electron; }
  const React = requireTrusted('react'), { renderToStaticMarkup } = requireTrusted('react-dom/server');
  const { SessionInfoCard } = await load(root, 'apps/desktop/src/renderer/SessionInfoCard.tsx');
  const info = { sessionId: 'one', title: '<private title>', providerId: 'native', mode: 'structured', archived: false, workspaceKind: 'project' };
  const markup = renderToStaticMarkup(React.createElement(SessionInfoCard, { info, loading: false, onRefresh() {} }));
  assert.match(markup, /&lt;private title&gt;/); assert.match(markup, /native/); assert.match(markup, /structured/); assert.match(markup, /project/); assert.match(markup, /刷新/);
  assert.doesNotMatch(markup, /<private title>|must-not-leak|\/private\//);
  const loading = renderToStaticMarkup(React.createElement(SessionInfoCard, { loading: true, onRefresh() {} })); assert.match(loading, /读取|加载/);
  const error = renderToStaticMarkup(React.createElement(SessionInfoCard, { error: 'fixture-error', loading: false, onRefresh() {} })); assert.match(error, /fixture-error/); assert.match(error, /刷新|重试/);
  const chat = await source(root, 'apps/desktop/src/renderer/ChatPane.tsx');
  assert.match(chat, /SessionInfoCard/); assert.match(chat, /getSessionInfo\s*\(/);
  assert.match(await source(root, 'apps/desktop/src/shared/types.ts'), /getSessionInfo\s*\(\s*id\s*:\s*string\s*\)\s*:\s*Promise\s*<\s*SessionInfo\s*>/);
  return { scope: 'actual IPC registration and preload bridge; server-rendered card; async UI race/visual behavior remains manual acceptance' };
}
