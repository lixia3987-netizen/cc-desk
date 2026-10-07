import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { listenOnFetchLoopback } from './fixtures/fetch-loopback.mjs';

class Allocator extends EventEmitter {
  calls = [];
  listening = false;
  constructor(ports, error) { super(); this.ports = ports; this.error = error; }
  listen(port, host, ready) {
    assert.equal(this.listening, false, 'the previous listener must close before rebinding');
    assert.equal(port, 0); assert.equal(host, '127.0.0.1');
    this.calls.push('listen');
    queueMicrotask(() => {
      if (this.error) this.emit('error', this.error);
      else { this.port = this.ports.shift(); this.listening = true; ready(); }
    });
  }
  address() { return { address: '127.0.0.1', family: 'IPv4', port: this.port }; }
  close(done) { this.calls.push('close'); this.listening = false; queueMicrotask(done); }
}

test('fixture allocation closes Fetch-blocked 3659/4045 listeners before returning an allowed URL', async () => {
  const server = new Allocator([3659, 4045, 49152]);
  assert.equal(await listenOnFetchLoopback(server), 49152);
  assert.deepEqual(server.calls, ['listen', 'close', 'listen', 'close', 'listen']);
  assert.equal(server.listening, true);
  assert.equal(server.listenerCount('error'), 0);
});

test('fixture allocation is bounded and leaves the last blocked listener closed', async () => {
  const server = new Allocator(Array(32).fill(10080));
  await assert.rejects(listenOnFetchLoopback(server), /Fetch-compatible loopback port/);
  assert.equal(server.calls.filter(call => call === 'listen').length, 32);
  assert.equal(server.calls.filter(call => call === 'close').length, 32);
  assert.equal(server.listening, false);
  assert.equal(server.listenerCount('error'), 0);
});

test('a real listener error is returned without retrying or retaining error listeners', async () => {
  const failure = Object.assign(new Error('address unavailable'), { code: 'EADDRINUSE' });
  const server = new Allocator([], failure);
  await assert.rejects(listenOnFetchLoopback(server), error => error === failure);
  assert.deepEqual(server.calls, ['listen']);
  assert.equal(server.listenerCount('error'), 0);
});

test('an allocated real loopback listener accepts a native fetch without any client retry', async () => {
  let requests = 0;
  const server = http.createServer((_request, response) => { requests++; response.end('fixture reachable'); });
  try {
    const port = await listenOnFetchLoopback(server);
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(await response.text(), 'fixture reachable');
    assert.equal(requests, 1);
  } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
