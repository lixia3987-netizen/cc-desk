import path from 'node:path';

// Branch-only observation; never close or unref resources owned by tests.
const label = path.basename(process.argv[1] ?? 'runner');
const describe = () => ({
  pid: process.pid,
  file: label,
  resources: process.getActiveResourcesInfo(),
  handles: process._getActiveHandles().map(handle => ({
    type: handle.constructor?.name,
    pid: handle.pid,
    exitCode: handle.exitCode,
    signalCode: handle.signalCode,
    destroyed: handle.destroyed,
    readable: handle.readable,
    writable: handle.writable,
    hasRef: handle.hasRef?.(),
  })),
});
console.error('TEST_PROCESS_START ' + JSON.stringify({ pid: process.pid, file: label }));
setInterval(() => console.error('TEST_PROCESS_RESOURCES ' + JSON.stringify(describe())), 30_000).unref();
process.once('beforeExit', () => console.error('TEST_PROCESS_BEFORE_EXIT ' + JSON.stringify(describe())));
