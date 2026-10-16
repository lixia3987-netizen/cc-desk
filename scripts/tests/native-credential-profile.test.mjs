import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { cleanupNativeCredentialProfile, credentialProfileCleanupAllowed, prepareNativeCredentialProfile, projectNativeOsCryptFields, verifyNativeProfileSourceUnchanged } from '../native-credential-profile.mjs';

const wrappedFixtureKey = Buffer.from('DPAPI-fixture-encrypted-bytes-only').toString('base64');
const state = () => ({ os_crypt: { encrypted_key: wrappedFixtureKey, audit_enabled: true, unrelated: 'must-not-copy' }, unrelated: { providerToken: 'fixture-only' } });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-profile-test-')), source = path.join(root, 'native-app'), temporaryRoot = path.join(root, 'temporary');
  await mkdir(path.join(source, 'native'), { recursive: true }); await mkdir(temporaryRoot);
  await writeFile(path.join(source, 'Local State'), JSON.stringify(state()));
  await writeFile(path.join(source, 'workspace.json'), JSON.stringify({ selectedSessionId: 'fixture' }));
  await writeFile(path.join(source, 'native/connections.json'), JSON.stringify({ schemaVersion: 1, connections: [] }));
  return { root, source, temporaryRoot, close: () => rm(root, { recursive: true, force: true }) };
}

test('OSCrypt临时profile只选必要保护字段，拒绝缺key/超限/不支持格式', () => {
  assert.deepEqual(projectNativeOsCryptFields(state()), { os_crypt: { encrypted_key: wrappedFixtureKey, audit_enabled: true } });
  assert.throws(() => projectNativeOsCryptFields({ os_crypt: {} }), { code: 'native_profile_key_missing' });
  assert.throws(() => projectNativeOsCryptFields({ os_crypt: { encrypted_key: 'a'.repeat(70000) } }), { code: 'native_profile_key_invalid' });
  assert.throws(() => projectNativeOsCryptFields({ os_crypt: { encrypted_key: Buffer.from('wrong-format').toString('base64') } }), { code: 'native_profile_key_unsupported' });
  assert.throws(() => projectNativeOsCryptFields({ os_crypt: { encrypted_key: wrappedFixtureKey, audit_enabled: 'true' } }), { code: 'native_profile_key_invalid' });
  assert.throws(() => projectNativeOsCryptFields({ os_crypt: { encrypted_key: wrappedFixtureKey, app_bound_encrypted_key: 'unsupported' } }), { code: 'native_profile_key_unsupported' });
});

test('准备过程保持原配置不变，临时key独立保存并经校验清理', async () => {
  const f = await fixture(); let profile;
  try {
    const before = await readFile(path.join(f.source, 'Local State'));
    profile = await prepareNativeCredentialProfile({ nativeDataDirectory: f.source, temporaryRoot: f.temporaryRoot });
    assert.deepEqual(JSON.parse(await readFile(path.join(profile.directory, 'Local State'), 'utf8')), { os_crypt: { encrypted_key: wrappedFixtureKey, audit_enabled: true } });
    assert.deepEqual(await readFile(path.join(f.source, 'Local State')), before);
    assert.deepEqual(await verifyNativeProfileSourceUnchanged(profile), { checkedFiles: 3, sourceFilesUnchanged: true });
    await writeFile(path.join(f.source, 'workspace.json'), JSON.stringify({ selectedSessionId: 'changed-fixture' }));
    assert.equal((await verifyNativeProfileSourceUnchanged(profile)).sourceFilesUnchanged, false);
    const target = profile.directory; assert.equal(await cleanupNativeCredentialProfile(profile), true); profile = undefined;
    await assert.rejects(lstat(target), { code: 'ENOENT' }); assert.equal((await lstat(f.source)).isDirectory(), true);
  } finally { if (profile) await cleanupNativeCredentialProfile(profile); await f.close(); }
});

test('清理不能接受伪造handle、原目录、父目录或非自建目录', async () => {
  const f = await fixture();
  try {
    assert.equal(credentialProfileCleanupAllowed(f.temporaryRoot, f.temporaryRoot), false);
    assert.equal(credentialProfileCleanupAllowed(f.source, f.temporaryRoot), false);
    assert.equal(credentialProfileCleanupAllowed(path.join(f.temporaryRoot, '../ccdesk-native-credential-outside'), f.temporaryRoot), false);
    assert.equal(credentialProfileCleanupAllowed(path.join(f.temporaryRoot, 'ordinary-user-folder'), f.temporaryRoot), false);
    await assert.rejects(cleanupNativeCredentialProfile({ directory: f.source, temporaryRoot: f.root, sourceDirectory: f.source }), { code: 'native_profile_cleanup_refused' });
    assert.equal((await lstat(path.join(f.source, 'Local State'))).isFile(), true);
  } finally { await f.close(); }
});

test('拒绝链接来源，不跟随目录联接读取其它profile', async t => {
  const f = await fixture();
  try {
    const link = path.join(f.root, 'linked-profile');
    try { await symlink(f.source, link, 'junction'); }
    catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('当前环境不能创建受控fixture目录联接'); return; } throw error; }
    await assert.rejects(prepareNativeCredentialProfile({ nativeDataDirectory: link, temporaryRoot: f.temporaryRoot }), { code: 'native_profile_source_unsafe' });
  } finally { await f.close(); }
});

test('超大Local State在读取与复制前拒绝', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.source, 'Local State'), 'x'.repeat(1024 * 1024 + 1));
    await assert.rejects(prepareNativeCredentialProfile({ nativeDataDirectory: f.source, temporaryRoot: f.temporaryRoot }), { code: 'native_profile_source_unsafe' });
  } finally { await f.close(); }
});
