import { test, expect, type ElectronApplication } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const cleanups = new WeakMap<ElectronApplication, Promise<void>>();

async function within<T>(work: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** 保留关闭失败信息，同时避免退出确认对话框阻塞 CI。 */
export function closeNativeApp(app: ElectronApplication): Promise<void> {
  const existing = cleanups.get(app);
  if (existing) return existing;
  // Playwright 在关闭后销毁应用调度器。须在任何关闭操作前获取一次真实
  // 进程，并将该 Promise 与 finally 块共享。
  const child = app.process();
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const cleanup = (async () => {
    try {
      if (!exited()) {
        await within((async () => {
          const page = app.windows()[0];
          if (page && !page.isClosed()) await page.evaluate(async () => {
            const sessions = (await window.desktop.snapshot()).state.sessions;
            const results = await Promise.allSettled(sessions.map(session => window.desktop.stopSession(session.id)));
            const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
            if (errors.length) throw new Error(errors.map(result => String(result.reason)).join('\n'));
          });
          await app.close();
        })(), 20_000, 'Native test graceful shutdown');
      }
      expect(child.exitCode, 'Native test application must exit normally').toBe(0);
      expect(child.signalCode).toBeNull();
    } catch (error) {
      const diagnostic: Record<string, unknown> = {
        error: String(error), pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode,
      };
      const page = app.windows()[0];
      if (page && !page.isClosed()) {
        diagnostic.sessions = await within(page.evaluate(async () => (await window.desktop.snapshot()).state.sessions.map(session => ({
          id: session.id, execution: session.execution, status: session.status, error: session.error,
        }))), 2_000, 'Native shutdown diagnostics').catch(problem => ({ error: String(problem) }));
        await page.screenshot({ path: test.info().outputPath('native-shutdown.png'), timeout: 2_000 }).catch(() => {});
      }
      // 仅在失败时清理本测试创建的进程。强制终止不能将
      // 正常关闭失败变为测试通过。
      if (!exited() && child.pid) {
        try {
          if (process.platform === 'win32') await execFileAsync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { timeout: 5_000, windowsHide: true });
          else {
            // Playwright 在独立的脱离进程组中启动 POSIX Electron。
            try { process.kill(-child.pid, 'SIGKILL'); }
            catch (problem) { if ((problem as NodeJS.ErrnoException).code !== 'ESRCH') throw problem; child.kill('SIGKILL'); }
          }
          if (!exited()) await within(new Promise<void>(resolve => child.once('exit', () => resolve())), 5_000, 'Forced native test process exit');
        } catch (problem) { diagnostic.forceCleanupError = String(problem); }
      }
      diagnostic.finalExitCode = child.exitCode;
      diagnostic.finalSignalCode = child.signalCode;
      await test.info().attach('native-shutdown.json', { body: Buffer.from(JSON.stringify(diagnostic, null, 2)), contentType: 'application/json' });
      throw error;
    }
  })();
  cleanups.set(app, cleanup);
  return cleanup;
}
