import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load, source, sha } from './common.mjs';
export default async function verify(root) {
  const core = await load(root, 'packages/agent-core/src/index.ts');
  const run = await load(root, 'packages/agent-core/src/run.ts');
  const shared = await load(root, 'packages/agent-core/src/canonical-json.ts');
  const corpus = [null, true, false, 0, -0, '中文\n"\\', [3, { z: null, a: [1, 2] }], { z: 1, a: { beta: 2, alpha: 1 } }, JSON.parse('{"__proto__":7,"constructor":8}')];
  const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  for (const value of corpus) for (const fn of [core.canonicalJson, run.canonicalJson, shared.canonicalJson]) assert.equal(fn(value), canonical(value));
  for (const fn of [core.canonicalJson, run.canonicalJson, shared.canonicalJson]) {
    for (const value of [NaN, Infinity, -Infinity]) assert.throws(() => fn(value), /Non-finite JSON number/);
    for (const value of [undefined, () => {}, { missing: undefined }]) assert.throws(() => fn(value), /Non-JSON value/);
  }
  for (const file of ['packages/agent-node/src/tools/local-tools.ts', 'packages/agent-node/src/mcp-tools.ts']) {
    const text = await source(root, file);
    assert.match(text, /import\s*\{[^}]*canonicalJson[^}]*\}\s*from\s*['"]@cc-desk\/agent-core['"]/s, 'both adapters consume the public shared implementation');
    assert.doesNotMatch(text, /const canonical\s*=\s*\(/, 'remove duplicate recursive serializers');
  }
  assert.doesNotMatch(await source(root, 'packages/agent-core/src/run.ts'), /export function canonicalJson\s*\(/, 'run.ts retains the public re-export, not a second implementation');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'e0-tool-digest-'));
  try {
    await fs.writeFile(path.join(temporary, 'sample.txt'), 'unchanged');
    const { createLocalToolPort } = await load(root, 'packages/agent-node/src/tools/local-tools.ts');
    const tool = createLocalToolPort({ projectRoot: temporary, ownerId: 'owner', supervisor: {} });
    const identity = { sessionId: 'session', conversationId: 'conversation', runId: 'run', requestId: 'request', workerGeneration: 1 };
    const input = { maxBytes: 30, path: 'sample.txt', startLine: 1 };
    const prepared = await tool.prepare({ id: 'read', name: 'read_file', arguments: JSON.stringify(input) }, { identity, policyRevision: 'policy', signal: new AbortController().signal, maxOutputBytes: 65536 });
    assert.equal(prepared.inputDigest, sha(canonical(input)), 'approval digest remains byte-compatible');
    assert.equal(prepared.requiresApproval, false);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  return { scope: 'canonical JSON corpus, public exports, adapter dependency and live local-tool approval digest' };
}
