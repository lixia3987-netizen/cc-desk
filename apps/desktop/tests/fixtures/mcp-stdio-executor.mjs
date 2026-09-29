import fs from 'node:fs';
import readline from 'node:readline';

const [logFile, mode, journalFile, initializationGate] = process.argv.slice(2);
const record = event => fs.appendFileSync(logFile, JSON.stringify({ pid: process.pid, ...event }) + '\n');
const journal = JSON.parse('[' + fs.readFileSync(journalFile, 'utf8').trim().split('\n').join(',') + ']');
record({ event: 'spawn', cwd: process.cwd(), target: process.env.FIXTURE_TARGET ?? null,
  source: process.env.CC_DESK_STDIO_FIXTURE_SOURCE ?? null, unrelated: process.env.CC_DESK_STDIO_FIXTURE_UNRELATED ?? null,
  prepared: journal.filter(item => item.event.type === 'startup_prepared').length });
const tool = { name: 'record_note', description: 'Record an explicitly approved fixture note.', inputSchema: {
  type: 'object', properties: { note: { type: 'string' } }, required: ['note'], additionalProperties: false,
} };
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', async line => {
  const request = JSON.parse(line);
  record({ event: 'rpc', method: request.method, id: request.id, params: request.params });
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') {
    if (mode === 'gate_init') while (!fs.existsSync(initializationGate)) await new Promise(resolve => setTimeout(resolve, 5));
    result = { protocolVersion: mode === 'bad_init' ? '2026-07-28' : '2025-11-25', capabilities: { tools: {} },
      serverInfo: { name: 'local-stdio-executor-fixture', version: '1.0.0' } };
  } else if (request.method === 'tools/list') result = { tools: [tool] };
  else if (request.method === 'tools/call') {
    if (mode === 'hold') return;
    result = { content: [{ type: 'text', text: mode === 'echo_env' ? process.env.FIXTURE_TARGET : 'Recorded the approved note.' }] };
  } else throw new Error('Unexpected local MCP fixture method.');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
lines.on('close', () => { record({ event: 'eof' }); process.exit(0); });
process.on('SIGTERM', () => { record({ event: 'terminated' }); process.exit(0); });
