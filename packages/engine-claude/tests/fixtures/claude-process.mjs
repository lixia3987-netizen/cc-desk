import readline from 'node:readline';
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
let permissionMode = 'default';
readline.createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request') {
    const request = frame.request;
    if (request.subtype === 'set_permission_mode' && request.mode === 'plan') {
      write({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: 'fixture denied permission change' } });
      return;
    }
    if (request.subtype === 'set_permission_mode') permissionMode = request.mode;
    write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { commands: [] } } });
  } else if (frame.type === 'user') {
    write({ type: 'system', subtype: 'init', permissionMode });
    write({ type: 'control_request', request_id: 'reused-wire-request', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'fixture' } } });
  } else if (frame.type === 'control_response') {
    if (frame.response.request_id !== 'reused-wire-request') throw new Error('public approval token leaked into the Claude wire protocol');
    write({ type: 'result', subtype: 'success', result: 'fixture complete', is_error: frame.response.response.behavior !== 'allow' });
  }
}).on('close', () => process.exit(0));
