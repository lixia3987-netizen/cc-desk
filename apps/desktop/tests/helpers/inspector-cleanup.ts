import type { ElectronApplication, TestInfo } from '@playwright/test';

/** Runs in Electron's main process, before IPC discards nested Error causes. */
export function installInspectorStopDiagnostics({ ipcMain }: Pick<typeof import('electron'), 'ipcMain'>, sessionId: string) {
  // Keep this callback self-contained: Playwright serializes it into Electron.
  const tokens = new Set(['windows.tree', 'pty.release', 'resource.close', 'posix.release_inspection',
    'windows_snapshot', 'windows_terminate', 'windows_helper_release', 'running', 'timeout', 'spawn_error', 'helper_exit',
    'invalid_snapshot', 'identity_changed', 'identity_unavailable', 'unreleased', 'os_error', 'bootstrap', 'modules',
    'input', 'compile', 'snapshot', 'capture', 'terminate', 'ENOENT', 'EACCES', 'EPERM', 'ESRCH', 'UNKNOWN']);
  const serializer = { read(value: unknown, depth = 0): unknown {
    if (!value || typeof value !== 'object' || depth > 6) return {};
    const item = value as Record<string, unknown>, result: Record<string, unknown> = {};
    for (const key of ['cleanupPhase', 'phase', 'code', 'helperStage', 'osCode']) {
      if (typeof item[key] === 'string' && tokens.has(item[key])) result[key] = item[key];
    }
    for (const key of ['snapshots', 'terminationAttempts', 'liveProcesses', 'nativeCode', 'helperExitCode', 'helperOutputBytes']) {
      if (typeof item[key] === 'number' && Number.isSafeInteger(item[key])) result[key] = item[key];
    }
    if (typeof item.helperExited === 'boolean') result.helperExited = item.helperExited;
    if (item.cause) result.cause = serializer.read(item.cause, depth + 1);
    if (value instanceof AggregateError) result.errors = value.errors.slice(0, 8).map(error => serializer.read(error, depth + 1));
    const prefix = 'Windows process descendants have not released. ';
    if (value instanceof Error && value.message.startsWith(prefix)) {
      try { result.windows = serializer.read(JSON.parse(value.message.slice(prefix.length)), depth + 1); } catch { /* Unknown payloads remain opaque. */ }
    }
    return result;
  } };
  const handlers = ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> };
  const original = handlers._invokeHandlers.get('session:stop');
  if (!original) throw new Error('The real session:stop handler is missing.');
  const globals = globalThis as typeof globalThis & { inspectorStopDiagnostics?: unknown[] };
  globals.inspectorStopDiagnostics = [];
  ipcMain.removeHandler('session:stop');
  ipcMain.handle('session:stop', async (event, id: string) => {
    try { return await original(event, id); }
    catch (error) {
      if (id === sessionId && globals.inspectorStopDiagnostics!.length < 8) {
        try { globals.inspectorStopDiagnostics!.push(serializer.read(error)); }
        catch { globals.inspectorStopDiagnostics!.push({ diagnosticUnavailable: true }); }
      }
      throw error;
    }
  });
}

export function readInspectorStopDiagnostics(): unknown[] {
  return (globalThis as typeof globalThis & { inspectorStopDiagnostics?: unknown[] }).inspectorStopDiagnostics ?? [];
}

async function within<T>(work: Promise<T>, milliseconds: number, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Inspector ${phase} exceeded ${milliseconds}ms`)), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Failure-only process recovery never satisfies the normal release assertion. */
export async function finishInspectorApp(app: ElectronApplication, sessionId: string,
  attach: TestInfo['attach'], failures: unknown[]) {
  // Capture Playwright's original ChildProcess before closing its dispatcher.
  const child = app.process();
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  let onExit: () => void = () => {};
  const actualExit = exited() ? Promise.resolve() : new Promise<void>(resolve => { onExit = resolve; child.once('exit', onExit); });
  let phase = 'stop';
  try {
    const page = app.windows()[0];
    if (!page || page.isClosed()) throw new Error('Inspector window closed before terminal release was confirmed.');
    await within(page.evaluate(id => window.desktop.stopSession(id), sessionId), 15_000, phase);
    phase = 'close';
    await within((async () => { await app.close(); await actualExit; })(), 5_000, phase);
    if (child.exitCode !== 0 || child.signalCode !== null) {
      throw new Error('Inspector application did not confirm a normal process exit.');
    }
  } catch (error) {
    failures.push(error);
    const detail: Record<string, unknown> = { phase, exitCode: child.exitCode, signalCode: child.signalCode };
    detail.cleanup = await within(app.evaluate(readInspectorStopDiagnostics), 2_000, 'diagnostics')
      .catch(() => ({ diagnosticUnavailable: true }));
    // Emit before recovery, so even an OS refusal cannot hide the stop failure.
    console.error(JSON.stringify({ phase: 'inspector.test.cleanup-error', detail }));
    if (!exited()) {
      try {
        // Never re-resolve a numeric PID or claim this stopped the session tree.
        if (!child.kill('SIGKILL') && !exited()) throw new Error('Inspector test process termination was refused.');
        await within(actualExit, 5_000, 'failure recovery exit');
      } catch (recoveryError) {
        failures.push(recoveryError);
        detail.recoveryFailed = true;
      }
    }
    detail.finalExitCode = child.exitCode;
    detail.finalSignalCode = child.signalCode;
    try { await attach('inspector-cleanup.json', { body: Buffer.from(JSON.stringify(detail, null, 2)), contentType: 'application/json' }); }
    catch (attachmentError) { failures.push(attachmentError); }
  } finally { child.removeListener('exit', onExit); }
  if (failures.length) throw new AggregateError(failures, 'Inspector assertions or terminal cleanup failed.', { cause: failures[0] });
}
