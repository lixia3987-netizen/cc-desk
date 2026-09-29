import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)), base: './', plugins: [react()],
  build: { outDir: fileURLToPath(new URL('./dist/renderer', import.meta.url)), emptyOutDir: true, assetsInlineLimit: 0 },
  server: { host: '127.0.0.1', port: 5173, strictPort: true }
});
