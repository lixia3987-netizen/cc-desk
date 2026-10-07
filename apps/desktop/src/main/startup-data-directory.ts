import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

export interface StartupDataDirectoryOptions {
  defaultDirectory: string;
  profileDirectory?: string;
  developmentDirectory?: string;
  isPackaged: boolean;
}

/** Resolve an authorized profile root once, before services derive their storage paths. */
export function prepareStartupDataDirectory(options: StartupDataDirectoryOptions): string {
  const profile = options.profileDirectory;
  if (profile && (!path.isAbsolute(profile) || profile.length > 4096)) {
    throw new Error('自定义数据目录必须是有效的绝对路径。');
  }
  const selected = profile || (!options.isPackaged && options.developmentDirectory) || options.defaultDirectory;
  const directory = path.resolve(selected);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // The selected root may use a system alias (for example /var on macOS).
  // Descendant paths still pass their own symlink and containment guards.
  return realpathSync.native(directory);
}
