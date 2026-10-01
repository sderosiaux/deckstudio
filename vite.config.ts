import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'web', plugins: [react()], build: { outDir: '../dist/web', emptyOutDir: true, assetsDir: 'app' },
  // Server paths only: /d/<id>/ itself and its screens stay with the SPA.
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4177',
      '/fonts': 'http://localhost:4177',
      '^/d/[^/]+/(api|assets)/': 'http://localhost:4177',
      '^/d/[^/]+/ws': { target: 'ws://localhost:4177', ws: true },
    },
  },
});
