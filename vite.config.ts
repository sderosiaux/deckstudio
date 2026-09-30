import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'web', plugins: [react()], build: { outDir: '../dist/web', emptyOutDir: true, assetsDir: 'app' },
  server: { port: 5173, proxy: { '/api': 'http://localhost:4177', '/assets': 'http://localhost:4177', '/ws': { target: 'ws://localhost:4177', ws: true } } },
});
