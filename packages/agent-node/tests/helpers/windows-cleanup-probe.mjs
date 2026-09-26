import { spawn } from 'node:child_process';
import path from 'node:path';
import { commandEnvironment } from '../../dist/process-supervisor.js';

// CI-only comparison. Never print inherited environment, process tables, or
// untrusted helper output. No file or target-process mutations and no API calls.
// Each bounded probe owns and, if necessary, terminates only its helper handle.
if (process.platform !== 'win32') process.exit(0);
const executable = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const scripts = {
  bootstrap: "[Console]::Out.WriteLine('cleanup-probe-ready'); exit 0",
  cim: "[Console]::Out.WriteLine('cleanup-probe-ready'); $ErrorActionPreference='Stop'; $null=Get-CimInstance -Query 'SELECT ProcessId,ParentProcessId,CreationDate FROM Win32_Process'; [Console]::Out.WriteLine('cleanup-probe-done'); exit 0",
};
async function probe(kind, environment, stdin) {
  const start = Date.now();
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', scripts[kind]], {
    env: environment === 'allowlist' ? commandEnvironment(process.env) : process.env,
    shell: false, windowsHide: true, stdio: [stdin, 'pipe', 'pipe'],
  });
  let bytes = 0, errors = 0, ready = false, done = false, text = '';
  child.stdout.on('data', chunk => {
    bytes += chunk.length;
    text = (text + chunk.toString('utf8')).slice(-128);
    ready ||= text.includes('cleanup-probe-ready'); done ||= text.includes('cleanup-probe-done');
  });
  child.stderr.on('data', chunk => { errors += chunk.length; });
  child.stdin?.on('error', () => {}); child.stdin?.end();
  const result = await new Promise((resolve, reject) => {
    let timedOut = false;
    let releaseTimer;
    const timer = setTimeout(() => {
      timedOut = true; child.kill('SIGKILL');
      releaseTimer = setTimeout(() => {
        child.kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); child.unref();
        reject(new Error('cleanup-probe-release-unconfirmed'));
      }, 1000);
    }, 3000);
    child.once('error', () => { clearTimeout(timer); clearTimeout(releaseTimer); resolve({ spawnError: true, exitCode: null }); });
    child.once('close', code => { clearTimeout(timer); clearTimeout(releaseTimer); resolve({ timedOut, exitCode: code, releaseConfirmed: true }); });
  });
  child.stdout.destroy(); child.stderr.destroy(); child.unref();
  console.log(JSON.stringify({ kind, environment, stdin, ready, done, outputBytes: bytes, errorBytes: errors, elapsedMs: Date.now() - start, ...result }));
}
try {
  for (const environment of ['inherited', 'allowlist']) for (const stdin of ['ignore', 'pipe']) await probe('bootstrap', environment, stdin);
  for (const environment of ['inherited', 'allowlist']) await probe('cim', environment, 'pipe');
} catch {
  console.log(JSON.stringify({ diagnostic: 'cleanup-probe-release-unconfirmed' }));
  process.exitCode = 1;
}
