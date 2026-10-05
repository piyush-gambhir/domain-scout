import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC emits the decorator metadata Nest dependency injection needs; esbuild does not.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    exclude: process.env.DOMAIN_SCOUT_LIVE_TESTS ? [] : ['test/live/**'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 20_000,
  },
});
