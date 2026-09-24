/** Use real Electron windows on Linux; an absent display must never select Ozone headless. */
export function electronLaunchArgs(
  appArgs: readonly string[] = ['.'],
  platform: NodeJS.Platform = process.platform,
  display = process.env.DISPLAY,
): string[] {
  if (platform !== 'linux') return [...appArgs];
  if (!display?.trim()) {
    throw new Error('Linux 桌面测试需要 X11 DISPLAY。请使用 npm run test:e2e 自动启动 Xvfb；打包测试请使用 xvfb-run -a npm run test:packaged。');
  }
  return [...appArgs, '--no-sandbox', '--ozone-platform=x11', '--disable-gpu'];
}
