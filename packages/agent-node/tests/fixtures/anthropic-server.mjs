import http from 'node:http';
import assert from 'node:assert/strict';
import { listenOnFetchLoopback } from './fetch-loopback.mjs';

export const anthropicSse = event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;
export const messageStart = (overrides = {}) => ({ type: 'message_start', message: {
  id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture-model', content: [], stop_reason: null, stop_sequence: null,
  usage: { input_tokens: 11, output_tokens: 1 }, ...overrides,
} });
export const blockStart = (content_block, index = 0) => ({ type: 'content_block_start', index, content_block });
export const blockDelta = (delta, index = 0) => ({ type: 'content_block_delta', index, delta });
export const blockStop = (index = 0) => ({ type: 'content_block_stop', index });
export const messageDelta = (stop_reason = 'end_turn', usage = { output_tokens: 7 }) => ({ type: 'message_delta', delta: { stop_reason, stop_sequence: null }, ...(usage === null ? {} : { usage }) });
export const messageStop = () => ({ type: 'message_stop' });
export function anthropicEvents(content = [{ type: 'text', text: '完成🙂' }], options = {}) {
  const events = [messageStart(options.startMessage)];
  for (const [index, block] of content.entries()) {
    if (block.type === 'text') {
      const midpoint = Math.floor(block.text.length / 2);
      events.push(blockStart({ type: 'text', text: '' }, index), { type: 'ping' },
        blockDelta({ type: 'text_delta', text: block.text.slice(0, midpoint) }, index),
        blockDelta({ type: 'text_delta', text: block.text.slice(midpoint) }, index));
    } else if (block.type === 'thinking' && typeof block.thinking === 'string' && (block.signature === undefined || typeof block.signature === 'string')) {
      const midpoint = Math.floor(block.thinking.length / 2);
      events.push(blockStart({ ...block, thinking: '', ...(block.signature === undefined ? {} : { signature: '' }) }, index),
        blockDelta({ type: 'thinking_delta', thinking: block.thinking.slice(0, midpoint) }, index),
        blockDelta({ type: 'thinking_delta', thinking: block.thinking.slice(midpoint) }, index));
      if (block.signature !== undefined) {
        const midpoint = Math.floor(block.signature.length / 2);
        events.push(blockDelta({ type: 'signature_delta', signature: block.signature.slice(0, midpoint) }, index),
          blockDelta({ type: 'signature_delta', signature: block.signature.slice(midpoint) }, index));
      }
    } else if (block.type === 'tool_use') {
      const json = JSON.stringify(block.input), midpoint = Math.floor(json.length / 2);
      events.push(blockStart({ ...block, input: {} }, index),
        blockDelta({ type: 'input_json_delta', partial_json: json.slice(0, midpoint) }, index),
        blockDelta({ type: 'input_json_delta', partial_json: json.slice(midpoint) }, index));
    } else events.push(blockStart(block, index));
    events.push(blockStop(index));
  }
  return [...events, messageDelta(options.stopReason ?? (content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn'), options.usage), messageStop()];
}

/** Real loopback HTTP transport; request bodies and headers stay in memory for assertions. */
export async function startAnthropicFixture(options = {}) {
  const requests = [], requestHeaders = [], requestPaths = [], errors = [], sockets = new Set();
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, options.expectedPath ?? '/v1/messages');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        assert.ok(bytes <= 16 * 1024 * 1024);
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body); requestHeaders.push(request.headers); requestPaths.push(request.url);
      assert.equal(body.stream, true);
      assert.ok(Array.isArray(body.messages));
      assert.ok(body.max_tokens > 0);
      assert.equal(body.thinking, undefined);
      assert.equal(body.previous_response_id, undefined);
      assert.equal(body.store, undefined);
      assert.equal(request.headers['anthropic-version'], '2023-06-01');
      if (body.tools) {
        assert.deepEqual(body.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
        assert.ok(body.tools.every(tool => typeof tool.name === 'string' && typeof tool.input_schema === 'object'));
      }
      const result = options.handler ? await options.handler({ body, index: requests.length - 1, request }) : {};
      response.writeHead(result.httpStatus ?? 200, { 'Content-Type': 'text/event-stream; charset=utf-8', ...result.headers });
      if (result.hang) { response.flushHeaders(); return; }
      const raw = result.raw ?? (result.events ?? anthropicEvents(result.content, result)).map(anthropicSse).join('');
      const encoded = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
      if (result.splitBytes) {
        for (let offset = 0; offset < encoded.length; offset += result.splitBytes) {
          if (response.destroyed) return;
          response.write(encoded.subarray(offset, offset + result.splitBytes));
          await new Promise(resolve => setImmediate(resolve));
        }
      } else response.write(encoded);
      if (result.disconnect) { await result.beforeDisconnect?.(); response.destroy(); }
      else response.end();
    } catch (error) {
      errors.push(error);
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end('{"error":"local fixture assertion failed"}');
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await listenOnFetchLoopback(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { baseURL: origin, origin, requests, requestHeaders, requestPaths, errors,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
