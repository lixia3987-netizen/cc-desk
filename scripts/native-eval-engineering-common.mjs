import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const evaluatorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const suiteRoot = path.join(evaluatorRoot, 'evals/native-engineering/v1');
export const ENGINEERING_SUITE = Object.freeze({
  id: 'cc-desk-engineering-v1',
  taskBaseline: 'b45bd0623d2a44a2878c46d4701fa4b388c7d9be',
  digest: '7ac65759b84e3946f632a931ff7bece2e50051fc25b2ee9a5e0c23bd2cbfba8a',
});
export const ENGINEERING_TASK_IDS = Object.freeze(['01-snapshot-refresh', '02-session-info', '03-canonical-json']);
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  throw new Error('Engineering metadata must contain finite JSON values.');
};
export const hashJson = value => sha(canonical(value));

export async function ordinaryDirectory(directory) {
  if (typeof directory !== 'string' || !directory || directory.includes('\0')) throw new Error('An ordinary directory is required.');
  const absolute = path.resolve(directory), stat = await fs.lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(absolute) !== absolute) throw new Error('Directory aliases and symbolic links are not allowed.');
  return absolute;
}

export function assertSeparate(...directories) {
  for (let left = 0; left < directories.length; left++) for (let right = left + 1; right < directories.length; right++) {
    for (const [a, b] of [[directories[left], directories[right]], [directories[right], directories[left]]]) {
      const relative = path.relative(path.resolve(a), path.resolve(b));
      if (relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)) {
        throw new Error('Candidate, evaluator and operator directories must be separate, without ancestor overlap.');
      }
    }
  }
}

export async function readJson(file, { maxBytes = 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw new Error('Invalid engineering JSON byte budget.');
  const absolute = path.resolve(file);
  await ordinaryDirectory(path.dirname(absolute));
  const before = await fs.lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new Error('Invalid or oversized engineering JSON file.');
  const handle = await fs.open(absolute, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maxBytes) throw new Error('Engineering JSON file changed while opening.');
    const buffer = Buffer.alloc(maxBytes + 1); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    const after = await handle.stat();
    if (bytes.length > maxBytes || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('Engineering JSON file changed or exceeded its budget.');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { await handle.close(); }
}

/** Publish a new, durable JSON artifact; existing successes and failures are never replaced. */
export async function createJson(file, value, { maxBytes = 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw new Error('Invalid engineering JSON byte budget.');
  const absolute = path.resolve(file), parent = await ordinaryDirectory(path.dirname(absolute));
  canonical(value);
  const bytes = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(bytes) > maxBytes) throw new Error('Engineering JSON exceeds its output budget.');
  const temporary = path.join(parent, '.engineering-' + randomUUID() + '.tmp');
  let published = false;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await ordinaryDirectory(parent);
    await fs.link(temporary, absolute);
    published = true;
    await fs.unlink(temporary);
    if (process.platform !== 'win32') {
      const directory = await fs.open(parent, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    // Never remove a published artifact, including after a directory-sync failure.
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  return { file: absolute, digest: hashJson(value), published };
}

export function commandEnvironment() {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LANG|LC_ALL)$/i.test(key))),
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  };
}

/** Resolve only the supported immutable suite; a changed v1 requires a new version. */
export async function loadEngineeringSuite() {
  await ordinaryDirectory(suiteRoot);
  const files = []; let totalBytes = 0;
  async function visit(relative = '') {
    for (const name of (await fs.readdir(path.join(suiteRoot, relative))).sort()) {
      const next = path.posix.join(relative, name);
      if (next === 'validation.json') continue;
      const absolute = path.join(suiteRoot, next), stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error('Engineering suite contains a symbolic link.');
      if (stat.isDirectory()) await visit(next);
      else {
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024 || files.length >= 256 || (totalBytes += stat.size) > 16 * 1024 * 1024) throw new Error('Invalid or oversized engineering suite.');
        const content = await fs.readFile(absolute);
        if (content.length !== stat.size) throw new Error('Engineering suite changed while reading.');
        files.push([next, sha(content)]);
      }
    }
  }
  await visit();
  if (sha(JSON.stringify(files)) !== ENGINEERING_SUITE.digest) throw new Error('Engineering suite digest mismatch; use the exact supported version.');
  const manifest = await readJson(path.join(suiteRoot, 'manifest.json'));
  const template = await readJson(path.join(suiteRoot, 'record-template.json'));
  if (manifest.schemaVersion !== 1 || manifest.suiteId !== ENGINEERING_SUITE.id || manifest.taskBaseline !== ENGINEERING_SUITE.taskBaseline || JSON.stringify(manifest.tasks?.map(task => task.id)) !== JSON.stringify(ENGINEERING_TASK_IDS)) throw new Error('Engineering suite manifest mismatch.');
  return { suite: { ...ENGINEERING_SUITE }, manifest, template, suiteRoot, evaluatorRoot };
}
