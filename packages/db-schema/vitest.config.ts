import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // schema-types.ts has only types, so there is no runtime code to cover.
      exclude: ['src/__tests__/**', 'src/schema-types.ts'],
      thresholds: { lines: 70 },
    },
  },
});
