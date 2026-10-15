import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

export interface StartupDataDirectoryOptions {
  defaultDirectory: () => string;
  profileDirectory?: string;
  developmentDirectory?: string;
  isPackaged: boolean;
}

/** 在各服务推导存储路径前，一次性解析已授权的配置根目录。 */
export function prepareStartupDataDirectory(options: StartupDataDirectoryOptions): string {
  const profile = options.profileDirectory;
  if (profile && (!path.isAbsolute(profile) || profile.length > 4096)) {
    throw new Error('自定义数据目录必须是有效的绝对路径。');
  }
  // Electron 默认的 userData 查询可能创建该目录。若显式配置
  // 已经确定已授权根目录，则不能访问默认目录。
  const selected = profile || (!options.isPackaged && options.developmentDirectory) || options.defaultDirectory();
  const directory = path.resolve(selected);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // 选定根目录可能使用系统别名（例如 macOS 上的 /var）。
  // 下级路径仍须通过各自的符号链接和范围检查。
  return realpathSync.native(directory);
}
