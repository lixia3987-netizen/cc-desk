import { desktopRoot } from './paths';

/** Keep desktop tests on real windows and suppress only native test credential prompts. */
export function electronLaunchArgs(
  appArgs: readonly string[] = [desktopRoot],
  platform: NodeJS.Platform = process.platform,
  display = process.env.DISPLAY,
): string[] {
  // Playwright injects this through its loader for the development Electron
  // binary, but skips that loader when executablePath points to a packaged app.
  // Unsigned macOS apps can otherwise block network-service startup on a native
  // Keychain prompt before Playwright has an application/window to control.
  // This is a test launch argument, never a production app command-line default.
  // https://releases.electronjs.org/pr/53790
  if (platform === 'darwin') return [...appArgs, '--use-mock-keychain'];
  if (platform !== 'linux') return [...appArgs];
  if (!display?.trim()) {
    throw new Error('Linux 桌面测试需要 X11 DISPLAY。请使用 npm run test:e2e 自动启动 Xvfb；打包测试请使用 xvfb-run -a npm run test:packaged。');
  }
  return [...appArgs, '--no-sandbox', '--ozone-platform=x11', '--disable-gpu'];
}
