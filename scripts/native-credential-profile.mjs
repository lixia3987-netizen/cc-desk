import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const prefix = 'ccdesk-native-credential-';
const issued = new WeakSet();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = code => Object.assign(new Error(code), { code });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 只选该应用的同步 OSCrypt 所需字段，受 DPAPI 保护的值不会进入返回报告。 */
export function projectNativeOsCryptFields(value) {
  const source = value?.os_crypt;
  if (!record(value) || !record(source)) throw failure('native_profile_key_missing');
  if (source.app_bound_encrypted_key !== undefined) throw failure('native_profile_key_unsupported');
  const key = source.encrypted_key;
  if (typeof key !== 'string' || !key.length) throw failure('native_profile_key_missing');
  if (key.length > 65536 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(key)) throw failure('native_profile_key_invalid');
  if (!Buffer.from(key, 'base64').subarray(0, 5).equals(Buffer.from('DPAPI'))) throw failure('native_profile_key_unsupported');
  if (source.audit_enabled !== undefined && typeof source.audit_enabled !== 'boolean') throw failure('native_profile_key_invalid');
  return { os_crypt: { encrypted_key: key, ...(source.audit_enabled === undefined ? {} : { audit_enabled: source.audit_enabled }) } };
}

/** 拒绝链接和非普通文件，并检查打开前后身份/长度，避免读到替换中的配置。 */
async function readRegularBounded(file, limit) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit) throw failure('native_profile_source_unsafe');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw failure('native_profile_source_changed');
    const bytes = Buffer.alloc(opened.size + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0), after = await handle.stat();
    if (bytesRead !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw failure('native_profile_source_changed');
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

async function canonicalDirectory(directory) {
  const lexical = path.resolve(directory), info = await lstat(lexical);
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure('native_profile_source_unsafe');
  return realpath(lexical);
}

async function sourceManifest(directory) {
  await canonicalDirectory(directory);
  const native = await lstat(path.join(directory, 'native'));
  if (!native.isDirectory() || native.isSymbolicLink()) throw failure('native_profile_source_unsafe');
  const result = {};
  for (const file of ['Local State', 'workspace.json', 'native/connections.json']) result[file] = digest(await readRegularBounded(path.join(directory, file), file === 'Local State' ? 1024 * 1024 : 16 * 1024 * 1024));
  return result;
}

/** 清理边界是自建临时根的直接子目录；绝不接受源 profile 或任意自定义目录。 */
export function credentialProfileCleanupAllowed(directory, temporaryRoot) {
  const target = path.resolve(directory), root = path.resolve(temporaryRoot);
  return path.dirname(target) === root && path.basename(target).startsWith(prefix) && target !== root;
}

export async function prepareNativeCredentialProfile({ nativeDataDirectory, temporaryRoot = tmpdir() }) {
  const sourceDirectory = await canonicalDirectory(nativeDataDirectory), root = await canonicalDirectory(temporaryRoot);
  const before = await sourceManifest(sourceDirectory), source = await readRegularBounded(path.join(sourceDirectory, 'Local State'), 1024 * 1024);
  let projected;
  try { projected = projectNativeOsCryptFields(JSON.parse(source.toString('utf8'))); }
  catch (error) { if (error?.code?.startsWith('native_profile_')) throw error; throw failure('native_profile_key_invalid'); }
  const directory = await realpath(await mkdtemp(path.join(root, prefix)));
  if (!credentialProfileCleanupAllowed(directory, root)) throw failure('native_profile_cleanup_refused');
  const profile = Object.freeze({ directory, temporaryRoot: root, sourceDirectory, sourceManifestBefore: Object.freeze(before) }); issued.add(profile);
  try {
    await chmod(directory, 0o700);
    await writeFile(path.join(directory, 'Local State'), JSON.stringify(projected), { flag: 'wx', mode: 0o600 });
    return profile;
  } catch (error) { await cleanupNativeCredentialProfile(profile); throw error; }
}

export async function verifyNativeProfileSourceUnchanged(profile) {
  if (!issued.has(profile)) throw failure('native_profile_cleanup_refused');
  const after = await sourceManifest(profile.sourceDirectory);
  return { checkedFiles: Object.keys(after).length, sourceFilesUnchanged: Object.keys(after).every(key => after[key] === profile.sourceManifestBefore[key]) };
}

export async function cleanupNativeCredentialProfile(profile) {
  if (!issued.has(profile) || !credentialProfileCleanupAllowed(profile.directory, profile.temporaryRoot)) throw failure('native_profile_cleanup_refused');
  const targetInfo = await lstat(profile.directory), target = await realpath(profile.directory), root = await realpath(profile.temporaryRoot);
  if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink() || target !== profile.directory || root !== profile.temporaryRoot || !credentialProfileCleanupAllowed(target, root) || target === profile.sourceDirectory) throw failure('native_profile_cleanup_refused');
  await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); issued.delete(profile);
  return true;
}
