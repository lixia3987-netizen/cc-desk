import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';
await viteBuild();
// Retain the full OFL notices beside the bundled offline font files.
await fs.mkdir('dist/renderer/font-licenses', { recursive: true });
for (const family of ['noto-sans-sc', 'jetbrains-mono']) {
  await fs.copyFile(path.join('node_modules', '@fontsource-variable', family, 'LICENSE'), path.join('dist/renderer/font-licenses', family + '-OFL.txt'));
}
await build({ entryPoints: ['src/main/index.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/main/index.cjs', external: ['electron', 'node-pty'], sourcemap: true });
await build({ entryPoints: ['src/preload/index.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/preload/index.cjs', external: ['electron'] });
