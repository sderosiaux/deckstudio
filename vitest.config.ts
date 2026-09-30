import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'], environmentMatchGlobs: [['tests/web/**', 'jsdom']], testTimeout: 30_000, hookTimeout: 60_000 },
});
