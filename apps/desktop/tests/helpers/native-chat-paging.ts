import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BeginRunRequest } from '@cc-desk/agent-core';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { NativeProjection } from '../../src/main/engines/native/projection';
import { ExecutionEvents } from '../../src/main/execution/events';
import type { AppState, Session } from '../../src/shared/types';

export interface PagingSession { session: Session; runId: string; finalId: string; finalText: string; firstDisplayCount: number; total: number }

/** Legal offline ledger records: no model requests and no tools are actually executed. */
export async function prepareNativePagingWorkspace(long = false) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cc-desk-native-paging-')));
  const data = path.join(directory, 'data'), projectPath = path.join(directory, 'project');
  await fs.mkdir(data); await fs.mkdir(projectPath);
  const now = new Date().toISOString(), projectId = randomUUID(), sessions: PagingSession[] = [];
  const specs = [{ title: '分页 A：首屏自动补页', count: 36, outputBytes: 256 * 1024, prefix: 'PAGING_A' },
    ...(long ? [{ title: '分页 B：长历史与刷新', count: 110, outputBytes: 64 * 1024, prefix: 'PAGING_B' }] : [])];
  try {
    for (const spec of specs) {
      const conversationId = randomUUID();
      const session: Session = { id: randomUUID(), projectId, title: spec.title, titleSource: 'manual', kind: 'agent', cwd: projectPath,
        execution: { providerId: 'native', mode: 'structured', conversationId }, engineConfig: { schemaVersion: 1, options: { model: 'offline-paging-fixture' } },
        started: true, status: 'stopped', taskState: 'completed', draft: '', archived: false, createdAt: now, updatedAt: now };
      const store = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
      const projection = new NativeProjection(data, new ExecutionEvents(), () => session, () => false, (_id, error) => { throw error; });
      const request: BeginRunRequest = { identity: { sessionId: session.id, conversationId, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 },
        input: spec.prefix + '_OFFLINE_USER', inputDigest: spec.prefix + '-offline-input', userItems: [{ role: 'user', content: spec.prefix + '_OFFLINE_USER' }],
        protocol: { id: 'openai-responses', version: 1 }, configuration: { model: 'offline-paging-fixture' }, policyRevision: 'paging-regression-v1' };
      try {
        await store.beginRun(request);
        const calls = Array.from({ length: spec.count }, (_, index) => ({ id: 'fixture-tool-' + index, name: 'read_file',
          arguments: JSON.stringify({ path: spec.prefix + '-' + index + '.txt', detail: 'i'.repeat(20_000) }) }));
        await store.append(request.identity, { type: 'model_response', response: { outputItems: calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments })),
          toolCalls: calls, finishReason: 'tool_calls', usage: null } });
        for (const [index, call] of calls.entries()) {
          const output = spec.prefix + '_TOOL_OUTPUT_' + index + '\n' + 'O'.repeat(spec.outputBytes - 40);
          await store.append(request.identity, { type: 'tool_prepared', prepared: { call,
            definition: { name: call.name, description: 'Offline paging fixture; no tool executed', risk: 'read', inputSchema: {} },
            input: JSON.parse(call.arguments) as Record<string, string>, inputDigest: spec.prefix + '-tool-' + index,
            policyRevision: request.policyRevision, requiresApproval: false, preconditions: {} } });
          await store.append(request.identity, { type: 'tool_completed', call, result: { status: 'completed', output },
            resultItems: [{ type: 'function_call_output', call_id: call.id, output }] });
        }
        const finalText = spec.prefix + '_SAVED_FINAL';
        const response = await store.append(request.identity, { type: 'model_response', response: { outputItems: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: finalText }] }],
          toolCalls: [], finishReason: 'completed', usage: null } });
        await store.append(request.identity, { type: 'run_finished', result: { identity: request.identity, status: 'completed', reason: 'completed', modelRequests: 2,
          toolCalls: spec.count, usage: null, context: store.loadContext()!, committed: true } });
        await projection.hydrate(session.id, store);
        const first = await projection.readDisplay(session.id);
        sessions.push({ session, runId: request.identity.runId, finalId: `${request.identity.runId}:response:${response.seq}:0`, finalText,
          firstDisplayCount: first.messages.length, total: spec.count + 2 });
      } finally { projection.flush(); await store.close(); }
    }
    const state: AppState = { version: 3, projects: [{ id: projectId, name: '离线分页验证', path: projectPath, createdAt: now }],
      sessions: sessions.map(value => value.session), settings: { engineDefaults: {}, claudePath: path.join(directory, 'unavailable-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000 } };
    await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify(state));
    return { directory, data, sessions };
  } catch (error) { await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); throw error; }
}

export async function appendNativePagingTurn(data: string, session: Session, text: string) {
  const conversationId = session.execution.conversationId!;
  const store = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
  const request: BeginRunRequest = { identity: { sessionId: session.id, conversationId, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 2 },
    input: 'PAGING_OFFLINE_UPDATE_USER', inputDigest: 'paging-offline-update', userItems: [{ role: 'user', content: 'PAGING_OFFLINE_UPDATE_USER' }],
    protocol: { id: 'openai-responses', version: 1 }, configuration: { model: 'offline-paging-fixture' }, policyRevision: 'paging-regression-v1' };
  try {
    await store.beginRun(request);
    const response = await store.append(request.identity, { type: 'model_response', response: { outputItems: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
      toolCalls: [], finishReason: 'completed', usage: null } });
    await store.append(request.identity, { type: 'run_finished', result: { identity: request.identity, status: 'completed', reason: 'completed', modelRequests: 1,
      toolCalls: 0, usage: null, context: store.loadContext()!, committed: true } });
    return `${request.identity.runId}:response:${response.seq}:0`;
  } finally { await store.close(); }
}
