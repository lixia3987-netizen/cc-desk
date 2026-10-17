/**
 * Standalone read-only projection benchmark.
 * Usage: node scripts/native-skill-history-benchmark.mjs /absolute/repo [100 500 1000]
 * Builds synthetic committed-evidence facades whose starts, versions, receipts,
 * protocol result items and hashes all pass the production projection validator.
 * It does not benchmark journal loading/fsync or create a live NativeRunStore.
 * Same exact immutable version appears in every run, exercising retention lookup
 * independently of the distinct-version safety cap. No timing pass/fail cutoff.
 */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const repo = process.argv[2];
if (!repo || !path.isAbsolute(repo)) throw new Error('Pass an absolute repository root.');
const imp = file => import(pathToFileURL(path.join(repo, file)).href);
const { canonicalJson } = await imp('packages/agent-core/dist/index.js');
const { readConversationSkillContinuityEvidence } = await imp('packages/agent-node/dist/skill-continuity.js');
const { nativeToolResultItems } = await imp('packages/agent-node/dist/context-maintenance.js');
const { SKILL_GUIDE_AUTHORITY } = await imp('packages/agent-node/dist/skill-tools.js');
const h = text => createHash('sha256').update(text).digest('hex');
const hash = value => h(canonicalJson(value));
const skillId = 'skill:' + h('skill'), body = 'Exact guide body.';
const protocol = { id: 'openai-responses', version: 1 };
const version = { skillId, sourceRevision: 1, sourceFingerprint: h('source'), fullFileHash: h(body), bodyHash: h(body), bytes: Buffer.byteLength(body), format: 'legacy' };
const descriptor = { skillId, sourceId: 'agents', relativePath: 'guide/SKILL.md', sourceRevision: 1, sourceFingerprint: h('source'), metadataHash: h('metadata'), format: 'legacy' };
const configuration = { modelInstructions: 'Current host rules', nativeSkillCatalog: { revision: h('catalog'), entries: [descriptor], truncated: false }, initialNativeSkills: { activationRevision: 0, digest: hash([]), activations: [] } };
for (const count of (process.argv.slice(3).length ? process.argv.slice(3).map(Number) : [100, 500, 1000])) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Counts must be positive integers.');
  const records = [], runs = new Map();
  for (let index = 0; index < count; index++) {
    const identity = { sessionId: 'session', conversationId: 'conversation', runId: `run-${index}`, requestId: `request-${index}`, workerGeneration: index + 1 };
    const startedSeq = records.length + 1;
    records.push({ seq: startedSeq, hash: h(String(startedSeq)), identity, event: { type: 'run_started', request: { identity, configuration, protocol } } });
    const call = { id: `call-${index}`, name: 'load_skill', arguments: JSON.stringify({ skillId, catalogRevision: configuration.nativeSkillCatalog.revision }) };
    const result = { status: 'completed', output: { skillId, sourceId: descriptor.sourceId, relativePath: descriptor.relativePath, version, authority: SKILL_GUIDE_AUTHORITY, body, complete: true } };
    const seq = records.length + 1;
    records.push({ seq, hash: h(String(seq)), identity, event: { type: 'tool_completed', call, result, resultItems: nativeToolResultItems(protocol, call, result) } });
    runs.set(identity.runId, { identity, startedSeq });
  }
  const head = { seq: records.length, hash: records.at(-1).hash };
  let pages = 0;
  const store = { head, getRun: id => runs.get(id), replay: (after, limit) => { pages++; return records.slice(after, after + limit); } };
  const retainedContext = { protocol, items: Array.from({ length: count }, () => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a'.repeat(1000) }] })) };
  const startedAt = performance.now();
  const evidence = readConversationSkillContinuityEvidence(store, retainedContext);
  const elapsedMs = Number((performance.now() - startedAt).toFixed(2));
  if (evidence.manifest.entries.length !== 1 || evidence.manifest.entries[0].identity.runId !== 'run-0' || pages !== Math.ceil(records.length / 256)) throw new Error('Unexpected projection result.');
  console.log(JSON.stringify({ runs: count, retainedItems: count, retainedTextBytesEach: 1000, distinctVersions: evidence.manifest.entries.length, journalPages: pages, elapsedMs }));
}
