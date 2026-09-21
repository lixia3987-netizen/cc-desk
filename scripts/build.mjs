import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
await viteBuild();
await build({ entryPoints: ['src/main/index.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/main/index.cjs', external: ['electron', 'node-pty'], sourcemap: true });
await build({ entryPoints: ['src/preload/index.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/preload/index.cjs', external: ['electron'] });
