import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeConnectionRequest, nativeConnectionUnavailable } from '../src/renderer/useNativeConnectionReadiness';
import type { Session } from '../src/shared/types';

function session(options: Session['engineConfig']['options'] = {}, providerId = 'native'): Session {
  return {
    id: 'session-one', projectId: 'project-one', title: 'Readiness test', kind: 'agent', cwd: '/project',
    execution: { providerId, mode: 'structured' }, engineConfig: { schemaVersion: 1, options }, started: false,
    status: 'idle', archived: false, createdAt: '', updatedAt: '',
  };
}

test('native readiness does not block sessions owned by other providers', () => {
  for (const provider of ['claude', 'shell', 'future-provider']) {
    const other = session({ connectionId: '', model: '' }, provider);
    assert.equal(nativeConnectionRequest(other), undefined);
    assert.equal(nativeConnectionUnavailable(other), undefined);
    assert.equal(nativeConnectionUnavailable(other, { key: '["",null]', result: { ready: false, error: 'Missing native credential' } }), undefined);
  }
});

test('a native session without a connection stays blocked even with an old successful result', () => {
  const priorSuccess = { key: '["connected",null]', result: { ready: true } };
  const configurations: Session['engineConfig']['options'][] = [{}, { connectionId: '' }, { connectionId: ' \t ' }, { connectionId: 42 }];
  for (const options of configurations) {
    const unconfigured = session(options);
    assert.equal(nativeConnectionRequest(unconfigured)?.id, '');
    assert.match(nativeConnectionUnavailable(unconfigured, priorSuccess)!, /尚未选择模型连接/);
  }
});

test('an empty model override requests the connection default and accepts its readiness', () => {
  const defaultReady = { key: '["connected",null]', result: { ready: true, connectionId: 'connected', revision: 1, model: 'connection-default' } };
  const configurations: Session['engineConfig']['options'][] = [{ connectionId: 'connected' }, { connectionId: 'connected', model: '' }, { connectionId: 'connected', model: ' \t ' }];
  for (const options of configurations) {
    const useDefault = session(options);
    assert.deepEqual(nativeConnectionRequest(useDefault), { sessionId: 'session-one', id: 'connected' });
    assert.equal(nativeConnectionUnavailable(useDefault, defaultReady), undefined);
  }
  assert.deepEqual(nativeConnectionRequest(session({ connectionId: 'connected', model: ' explicit-model ' })), {
    sessionId: 'session-one', id: 'connected', model: 'explicit-model',
  });
});

test('a successful check for the previous connection or model cannot unblock edited session configuration', () => {
  const original = session({ connectionId: 'connection-a', model: 'model-a' });
  const priorSuccess = { key: '["connection-a","model-a"]', result: { ready: true, connectionId: 'connection-a', revision: 1, model: 'model-a' } };
  assert.equal(nativeConnectionUnavailable(original, priorSuccess), undefined);
  assert.match(nativeConnectionUnavailable(session({ connectionId: 'connection-b', model: 'model-a' }), priorSuccess)!, /正在检查/);
  assert.match(nativeConnectionUnavailable(session({ connectionId: 'connection-a', model: 'model-b' }), priorSuccess)!, /正在检查/);
  assert.match(nativeConnectionUnavailable(session({ connectionId: 'connection-a', model: '' }), priorSuccess)!, /正在检查/);
  assert.match(nativeConnectionUnavailable(original)!, /正在检查/);
});

test('the current connection missing-key error blocks only its native session and remains actionable', () => {
  const missingKey = '主进程未找到此连接指定的环境变量，请设置后重启应用。';
  const current = session({ connectionId: 'missing-key' });
  assert.equal(nativeConnectionUnavailable(current, { key: '["missing-key",null]', result: { ready: false, error: missingKey } }), missingKey);
  assert.match(nativeConnectionUnavailable(current, { key: '["missing-key",null]', result: { ready: false } })!, /尚未就绪/);
  assert.equal(nativeConnectionUnavailable(session({ connectionId: 'configured' }), { key: '["configured",null]', result: { ready: true } }), undefined);
});
