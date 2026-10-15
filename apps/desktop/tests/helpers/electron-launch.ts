import { desktopRoot } from './paths';

/** 桌面测试使用真实窗口，仅屏蔽原生测试凭据提示。 */
export function electronLaunchArgs(
  appArgs: readonly string[] = [desktopRoot],
  platform: NodeJS.Platform = process.platform,
  display = process.env.DISPLAY,
): string[] {
  // Playwright 会通过加载器向开发版 Electron 可执行文件注入此参数，
  // 但 executablePath 指向已打包应用时会跳过加载器。
  // 否则，未签名的 macOS 应用可能在 Playwright 尚未获得可控制的应用或窗口前，
  // 因原生钥匙串提示而阻塞网络服务启动。
  // 这是测试启动参数，不是生产应用的默认命令行参数。
  // https://releases.electronjs.org/pr/53790
  if (platform === 'darwin') return [...appArgs, '--use-mock-keychain'];
  if (platform !== 'linux') return [...appArgs];
  if (!display?.trim()) {
    throw new Error('Linux 桌面测试需要 X11 DISPLAY。请使用 npm run test:e2e 自动启动 Xvfb；打包测试请使用 xvfb-run -a npm run test:packaged。');
  }
  return [...appArgs, '--no-sandbox', '--ozone-platform=x11', '--disable-gpu'];
}
