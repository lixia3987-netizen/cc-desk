import http from 'node:http';
import assert from 'node:assert/strict';

export const chatSse = event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\r\n\r\n`;
export const chatChunk = (delta, finish_reason = null, extra = {}) => ({
  id: 'chat_fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
  choices: [{ index: 0, delta, finish_reason }], usage: null, ...extra,
});
export function chatEvents(message = { role: 'assistant', content: '完成🙂' }, options = {}) {
  const events = [chatChunk({ role: 'assistant', content: '' })];
  if (message.content !== undefined && message.content !== null) events.push(chatChunk({ content: message.content }));
  if (message.refusal !== undefined) events.push(chatChunk({ refusal: message.refusal }));
  for (const [index, call] of (message.tool_calls ?? []).entries()) {
    const midpoint = Math.max(1, Math.floor(call.function.arguments.length / 2));
    events.push(chatChunk({ tool_calls: [{ index, id: call.id, type: call.type, function: { name: call.function.name, arguments: call.function.arguments.slice(0, midpoint) } }] }));
    events.push(chatChunk({ tool_calls: [{ index, function: { arguments: call.function.arguments.slice(midpoint) } }] }));
  }
  events.push(chatChunk({}, options.finishReason ?? (message.tool_calls?.length ? 'tool_calls' : 'stop')));
  if (options.usage !== null) events.push(chatChunk({}, null, { choices: [], usage: options.usage ?? { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }));
  return [...events, '[DONE]'];
}

/** Local HTTP/SSE service; handler({body,index,request}) may override message/events/raw. */
export async function startChatCompletionsFixture(options = {}) {
  const requests = [];
  const errors = [];
  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        assert.ok(bytes <= 16 * 1024 * 1024);
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      assert.equal(body.store, false);
      assert.equal(body.stream, true);
      assert.equal(body.n, 1);
      assert.deepEqual(body.stream_options, { include_usage: true });
      assert.ok(Array.isArray(body.messages));
      assert.ok(body.max_completion_tokens > 0);
      assert.equal(body.previous_response_id, undefined);
      if (body.tools) {
        assert.equal(body.parallel_tool_calls, false);
        assert.ok(body.tools.every(tool => tool.type === 'function' && typeof tool.function.name === 'string'));
      }
      const result = options.handler ? await options.handler({ body, index: requests.length - 1, request }) : {};
      response.writeHead(result.httpStatus ?? 200, { 'Content-Type': 'text/event-stream; charset=utf-8', ...result.headers });
      if (result.hang) { response.flushHeaders(); return; }
      const raw = result.raw ?? (result.events ?? chatEvents(result.message, result)).map(chatSse).join('');
      const encoded = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
      if (result.splitBytes) {
        for (let offset = 0; offset < encoded.length; offset += result.splitBytes) {
          if (response.destroyed) return;
          response.write(encoded.subarray(offset, offset + result.splitBytes));
          await new Promise(resolve => setImmediate(resolve));
        }
      } else response.write(encoded);
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
