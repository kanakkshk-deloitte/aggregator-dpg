import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // `DATABASE_URL` has no source default (it carries credentials), so the
    // suite supplies a credential-free placeholder. No test opens a socket —
    // `pg.Pool` is lazy — this only satisfies startup config validation.
    env: {
      DATABASE_URL: 'postgres://localhost:5432/aggregator_test',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      exclude: ['node_modules/', 'dist/', '**/*.config.*', '**/main.ts'],
    },
  },
});
