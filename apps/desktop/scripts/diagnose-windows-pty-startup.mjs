import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Information only: real Runtime and full workspace checks remain the gates.
// Never serialize getReport(): it contains commands, paths and environment data.
if (process.platform === 'win32') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-pty-startup-'));
  const runtimeUrl = new URL('../src/main/runtime.ts', import.meta.url).href;
  const spawnUrl = new URL('../src/main/execution/spawn-terminal.ts', import.meta.url).href;
  const resourcesUrl = new URL('../src/main/execution/windows-pty-resources.ts', import.meta.url).href;
  const report = `console.log('report-start'); process.report.getReport(); console.log('report-complete');`;
  const imported = `console.log('import-start'); await import(${JSON.stringify(runtimeUrl)}); console.log('import-complete');`;
  const cases = [
    { name: 'node-report', args: [], source: report },
    { name: 'tsx-report', args: ['--import', 'tsx'], source: report },
    { name: 'runtime-report', args: ['--import', 'tsx'], source: imported + report },
    { name: 'test-runner-report', args: ['--import', 'tsx', '--test'], source:
      `import { before, test } from 'node:test'; ${imported} before(() => { ${report} }); test('report probe', () => {});` },
    { name: 'single-pty', args: ['--import', 'tsx'], source: `
      console.log('import-start');
      const { spawnTerminal } = await import(${JSON.stringify(spawnUrl)}).then(m => m.default ?? m);
      const { releaseWindowsPty } = await import(${JSON.stringify(resourcesUrl)}).then(m => m.default ?? m);
      console.log('import-complete'); console.log('spawn-start');
      const terminal = spawnTerminal({ file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: process.env }, process.cwd());
      terminal.onData(() => {});
      console.log('spawn-complete'); console.log('release-start');
      await releaseWindowsPty(terminal);
      console.log('release-complete');
    ` },
  ];
  try {
    for (const probe of cases) {
      const file = path.join(root, probe.name + '.mjs');
      await fs.writeFile(file, probe.source);
      const outcome = await new Promise(resolve => {
        const child = spawn(process.execPath, [...probe.args, file], {
          cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const phases = new Set();
        let tail = '', bytes = 0, timedOut = false, spawnError = false;
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, 15000);
        // Retain only hardcoded phase tokens, never arbitrary child diagnostics.
        child.stdout.on('data', chunk => {
          tail = (tail + chunk.toString()).slice(-4096);
          for (const phase of ['import-start', 'import-complete', 'report-start', 'report-complete',
            'spawn-start', 'spawn-complete', 'release-start', 'release-complete']) {
            if (tail.includes(phase)) phases.add(phase);
          }
        });
        child.stderr.on('data', chunk => { bytes += chunk.length; });
        child.on('error', () => { spawnError = true; });
        child.once('close', (code, signal) => {
          clearTimeout(timer);
          resolve({ probe: probe.name, phases: [...phases], code, signal, timedOut, spawnError, stderrBytes: bytes });
        });
      });
      console.log(JSON.stringify(outcome));
    }
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
