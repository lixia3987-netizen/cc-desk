import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = fileURLToPath(new URL('../', import.meta.url));
await viteBuild({ configFile: path.join(desktopRoot, 'vite.config.ts') });
await build({ absWorkingDir: desktopRoot, entryPoints: ['src/main/index.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/main/index.cjs', external: ['electron', 'node-pty'], sourcemap: true });
await build({ absWorkingDir: desktopRoot, entryPoints: ['src/main/engines/native/worker-entry.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/native/worker.cjs', external: ['electron'] });
await build({ absWorkingDir: desktopRoot, entryPoints: ['src/preload/index.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/preload/index.cjs', external: ['electron'] });
