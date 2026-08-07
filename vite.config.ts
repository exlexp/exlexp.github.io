import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  base: process.env.PAGES_BASE_PATH ?? '/',
  plugins: [react()],
  resolve: {
    alias: {
      path: 'path-browserify',
      crypto: fileURLToPath(new URL('./src/compat/nodeCryptoBrowser.ts', import.meta.url)),
      'webworker-threads': fileURLToPath(new URL('./src/compat/unusedNodeWorker.ts', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  },
  preview: {
    host: '127.0.0.1',
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  },
  build: {
    target: 'chrome138',
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    coverage: { reporter: ['text', 'json'] },
  },
});
