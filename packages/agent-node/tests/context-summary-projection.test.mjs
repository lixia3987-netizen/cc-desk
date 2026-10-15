import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { projectContextForSummary, requireCompleteContext } from '../dist/context-maintenance.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('Responses summary projection reduces opaque payload bytes and preserves complete tool evidence', t => {
  const privateState = { type: 'reasoning', id: 'rs_original', summary: [{ type: 'summary_text', text: 'Visible historical summary.' }], encrypted_content: 'encrypted'.repeat(4000) };
  const result = { status: 'completed', output: { path: 'src/a.ts', fileHash: 'source-hash', excerpt: '源代码 evidence '.repeat(500), truncated: false } };
  const context = { protocol: { id: 'openai-responses', version: 1 }, items: [
    { role: 'user', content: 'Exact original constraint.' }, privateState,
    { type: 'function_call', call_id: 'read_1', name: 'read_file', arguments: '{"path":"src/a.ts"}' },
    { type: 'function_call_output', call_id: 'read_1', output: JSON.stringify(result) },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Evidence read; testing not executed.' }] },
  ], continuation: { responseId: 'original-response', encrypted: 'continuation'.repeat(2000) } };
  const original = structuredClone(context), projection = projectContextForSummary(context);
  assert.deepEqual(context, original, 'source ledger payload stays byte-for-byte replayable');
  requireCompleteContext(context);
  assert.equal(projection.sourceBytes, Buffer.byteLength(JSON.stringify(original)));
  assert.equal(projection.projectedBytes, Buffer.byteLength(JSON.stringify(projection.history)));
  assert.ok(projection.projectedBytes < projection.sourceBytes, 'offline optimization is measured in payload bytes, not claimed model tokens');
  t.diagnostic(`Responses fixture UTF-8 bytes: ${projection.sourceBytes} -> ${projection.projectedBytes}`);
  assert.equal(projection.opaqueReferences, 2);
  assert.equal(projection.history.items[1].sha256, hash(privateState));
  assert.equal(projection.history.items[1].bytes, Buffer.byteLength(JSON.stringify(privateState)));
  assert.deepEqual(projection.history.items[1].summary, privateState.summary);
  assert.deepEqual(projection.history.items.slice(2), context.items.slice(2), 'call ID, arguments, full result and verification status remain intact');
  assert.equal(projection.history.continuation.sha256, hash(original.continuation));
  assert.doesNotMatch(JSON.stringify(projection.history), /encryptedencrypted|continuationcontinuation/);
  assert.throws(() => requireCompleteContext(projection.history), { code: 'unsupported_protocol' }, 'summary data references are never valid native replay blocks');
});

test('Anthropic signed and redacted state uses references without rewriting native state or tool pairing', t => {
  const thinking = { type: 'thinking', thinking: 'private thought'.repeat(2000), signature: 'signed'.repeat(2000) };
  const redacted = { type: 'redacted_thinking', data: 'redacted'.repeat(3000) };
  const call = { type: 'tool_use', id: 'toolu_original', name: 'read_file', input: { path: 'source.txt' } };
  const result = { type: 'tool_result', tool_use_id: call.id, content: '{"status":"denied","output":"No execution."}', is_error: true };
  const context = { protocol: { id: 'anthropic-messages', version: 1 }, items: [
    { role: 'user', content: 'Read only; keep failures.' },
    { role: 'assistant', content: [thinking, redacted, { type: 'text', text: 'Checking source.' }, call] },
    { role: 'user', content: [result] },
  ] };
  const original = structuredClone(context), projection = projectContextForSummary(context);
  assert.deepEqual(context, original); requireCompleteContext(context);
  assert.ok(projection.projectedBytes < projection.sourceBytes);
  t.diagnostic(`Anthropic fixture UTF-8 bytes: ${projection.sourceBytes} -> ${projection.projectedBytes}`);
  assert.equal(projection.opaqueReferences, 2);
  assert.equal(projection.history.items[1].content[0].sha256, hash(thinking));
  assert.equal(projection.history.items[1].content[1].sha256, hash(redacted));
  assert.deepEqual(projection.history.items[1].content.slice(2), original.items[1].content.slice(2));
  assert.deepEqual(projection.history.items[2], original.items[2]);
  assert.doesNotMatch(JSON.stringify(projection.history), /private thoughtprivate|signedsigned|redactedredacted/);
  assert.throws(() => requireCompleteContext(projection.history), { code: 'unsupported_protocol' });
});

test('plain-text Chat history remains exact and unfinished or unsupported data cannot be projected', () => {
  const context = { protocol: { id: 'openai-chat-completions', version: 1 }, items: [{ role: 'user', content: '中文🙂 constraints' }, { role: 'assistant', content: 'Not verified.' }] };
  const projection = projectContextForSummary(context);
  assert.deepEqual(projection.history, context); assert.equal(projection.sourceBytes, projection.projectedBytes);
  assert.equal(projection.opaqueReferences, 0);
  assert.throws(() => projectContextForSummary({ protocol: { id: 'openai-responses', version: 1 }, items: [{ type: 'function_call', call_id: 'missing', name: 'read_file', arguments: '{}' }] }), { code: 'pending_tools' });
  assert.throws(() => projectContextForSummary({ protocol: { id: 'unsupported', version: 1 }, items: [] }), { code: 'unsupported_protocol' });
});
