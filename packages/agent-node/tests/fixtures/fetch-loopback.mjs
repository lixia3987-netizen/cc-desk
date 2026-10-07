// Fetch Standard port-blocking table, checked 2026-10-08:
// https://fetch.spec.whatwg.org/#port-blocking
// Windows may allocate one of these ports for listen(0); fetch rejects it before
// dispatch. Rebind only the test listener, before handing its URL to any client.
const badPorts = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);
const MAX_BIND_ATTEMPTS = 32;

export async function listenOnFetchLoopback(server) {
  for (let attempt = 0; attempt < MAX_BIND_ATTEMPTS; attempt++) {
    await new Promise((resolve, reject) => {
      const error = failure => { server.off('error', error); reject(failure); };
      server.once('error', error);
      try {
        server.listen(0, '127.0.0.1', () => { server.off('error', error); resolve(); });
      } catch (failure) { error(failure); }
    });
    const port = server.address().port;
    if (!badPorts.has(port)) return port;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  throw new Error('Unable to allocate a Fetch-compatible loopback port.');
}
