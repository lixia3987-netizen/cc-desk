import http from 'node:http';
import assert from 'node:assert/strict';

export const functionCall = (id, name, input) => ({
  type: 'function_call', id: `fc_${id}`, call_id: id, name,
  arguments: typeof input === 'string' ? input : JSON.stringify(input), status: 'completed',
});
export const assistantMessage = (id, text, phase = 'final_answer') => ({
  type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', phase,
  content: [{ type: 'output_text', text, annotations: [] }],
});
export const reasoningItem = id => ({ type: 'reasoning', id: `rs_${id}`, summary: [], encrypted_content: `fixture-encrypted-${id}` });
export const sse = event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;

/** Real Responses HTTP/SSE envelope. The fixture only substitutes the model. */
export function responseEvents(output, { id = 'resp_fixture', usage = { input_tokens: 11, output_tokens: 7, total_tokens: 18 }, status = 'completed' } = {}) {
  const events = [{ type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } }];
  for (const [output_index, item] of output.entries()) {
    const added = item.type === 'function_call' ? { ...item, arguments: '', status: 'in_progress' }
      : item.type === 'message' ? { ...item, content: [], status: 'in_progress' } : item;
    events.push({ type: 'response.output_item.added', response_id: id, output_index, item: added });
    if (item.type === 'function_call') {
      const midpoint = Math.max(1, Math.floor(item.arguments.length / 2));
      for (const delta of [item.arguments.slice(0, midpoint), item.arguments.slice(midpoint)]) {
        events.push({ type: 'response.function_call_arguments.delta', response_id: id, output_index, item_id: item.id, delta });
      }
      events.push({ type: 'response.function_call_arguments.done', response_id: id, output_index, item_id: item.id, arguments: item.arguments });
    }
    if (item.type === 'message') {
      for (const [content_index, part] of item.content.entries()) {
        if (part.type === 'output_text') {
          events.push({ type: 'response.content_part.added', response_id: id, output_index, item_id: item.id, content_index, part: { ...part, text: '' } });
          events.push({ type: 'response.output_text.delta', response_id: id, output_index, item_id: item.id, content_index, delta: part.text });
          events.push({ type: 'response.output_text.done', response_id: id, output_index, item_id: item.id, content_index, text: part.text });
          events.push({ type: 'response.content_part.done', response_id: id, output_index, item_id: item.id, content_index, part });
        }
      }
    }
    events.push({ type: 'response.output_item.done', response_id: id, output_index, item });
  }
  events.push({ type: `response.${status}`, response: { id, object: 'response', status, output, usage } });
  return events.map((event, sequence_number) => ({ ...event, sequence_number }));
}

function taskResponse(body, task) {
  const input = body.input;
  const turn = input.filter(item => item.role === 'user').length;
  const prefix = `turn${turn}`;
  const results = new Map(input.filter(item => item.type === 'function_call_output').map(item => [item.call_id, JSON.parse(item.output)]));
  const read = results.get(`${prefix}_read`);
  const patched = results.get(`${prefix}_patch`);
  const commanded = results.get(`${prefix}_command`);
  let item;
  if (turn > 1) {
    // A fresh worker must send all prior opaque protocol items, not a summary or
    // previous_response_id. The first request of this turn is enough to prove it.
    assert.ok(input.some(value => value.type === 'reasoning' && value.encrypted_content === 'fixture-encrypted-turn1_read'));
    assert.ok(input.some(value => value.type === 'message' && value.phase === 'final_answer'));
    assert.ok(results.has('turn1_command'));
    item = assistantMessage(`${prefix}_final`, `续聊已保留完整上下文 ${turn}`);
  } else if (!read) {
    item = functionCall(`${prefix}_read`, 'read_file', { path: task.path });
  } else if (!patched) {
    const hash = read.status === 'completed' ? read.output?.hash : null;
    assert.ok(hash === null || typeof hash === 'string', 'read_file must return a full-content hash');
    item = functionCall(`${prefix}_patch`, 'apply_patch', { path: task.path, content: task.content, expectedHash: hash });
  } else if (patched.status !== 'completed') {
    item = assistantMessage(`${prefix}_denied`, `修改未执行：${patched.status}`);
  } else if (!commanded) {
    item = functionCall(`${prefix}_command`, 'run_command', task.command);
  } else {
    item = assistantMessage(`${prefix}_final`, `本地任务完成 ✅ command=${commanded.status}`);
  }
  const id = item.call_id ?? `${prefix}_final`;
  return { output: [reasoningItem(id), ...(item.type === 'function_call' ? [assistantMessage(`${id}_note`, '检查项目并执行已批准的操作。', 'commentary')] : []), item] };
}

/**
 * startResponsesFixture({ task?: {path, content, command}, handler?, assertReplay? })
 * returns {baseURL, requests, errors, close}. requests contains bodies only.
 * handler({body,index,request}) -> {output,events?,raw?,usage?,status?,httpStatus?,
 * headers?,splitBytes?,disconnect?,hang?}; never makes a remote request.
 */
export async function startResponsesFixture(options = {}) {
  const requests = [];
  const errors = [];
  const sockets = new Set();
  let expectedPrefix;
  const task = {
    path: 'fixture.txt', content: 'native fixture complete\n',
    command: { executable: process.execPath, argv: ['-e', 'process.stdout.write("native-command-ok")'], cwd: '.' },
    ...options.task,
  };
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/responses');
      let bytes = 0;
      const chunks = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        assert.ok(bytes <= 16 * 1024 * 1024);
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      assert.equal(body.store, false);
      assert.equal(body.stream, true);
      assert.equal(body.parallel_tool_calls, false);
      assert.ok(Array.isArray(body.input));
      assert.equal(body.previous_response_id, undefined);
      assert.ok(body.include.includes('reasoning.encrypted_content'));
      assert.ok(body.tools.every(tool => tool.type === 'function'));
      if (expectedPrefix && options.assertReplay !== false) assert.deepEqual(body.input.slice(0, expectedPrefix.length), expectedPrefix);
      const result = options.handler ? await options.handler({ body, index: requests.length - 1, request }) : taskResponse(body, task);
      const output = result.output ?? [];
      if (result.output) expectedPrefix = [...body.input, ...structuredClone(output)];
      response.writeHead(result.httpStatus ?? 200, { 'Content-Type': 'text/event-stream; charset=utf-8', ...result.headers });
      if (result.hang) { response.flushHeaders(); return; }
      const raw = result.raw ?? (result.events ?? responseEvents(output, { id: `resp_${requests.length}`, ...result })).map(sse).join('');
      const encoded = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
      if (result.splitBytes) {
        for (let offset = 0; offset < encoded.length; offset += result.splitBytes) {
          if (response.destroyed) return;
          response.write(encoded.subarray(offset, offset + result.splitBytes));
          await new Promise(resolve => setImmediate(resolve));
        }
      } else {
        // Split through the first non-ASCII code point, then coalesce the rest.
        const unicode = encoded.findIndex(byte => byte > 127);
        const split = unicode < 0 ? Math.min(47, encoded.length) : unicode + 1;
        response.write(encoded.subarray(0, split));
        await new Promise(resolve => setImmediate(resolve));
        response.write(encoded.subarray(split));
      }
      if (result.disconnect) response.destroy();
      else response.end();
    } catch (error) {
      errors.push(error);
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end('{"error":"local fixture assertion failed"}');
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/v1`, requests, errors,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
