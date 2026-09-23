import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'src/renderer', base: './', plugins: [react()],
  build: { outDir: '../../dist/renderer', emptyOutDir: true, assetsInlineLimit: 0 },
  server: { host: '127.0.0.1', port: 5173, strictPort: true }
});
