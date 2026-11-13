import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Fakes shared by every unit test (e.g. the identity store).
    setupFiles: ['src/test-setup.ts'],
    // `DATABASE_URL` has no source default (it carries credentials), so the
    // suite supplies a credential-free placeholder. No test opens a socket —
    // `pg.Pool` is lazy — this only satisfies startup config validation.
    env: {
      DATABASE_URL: 'postgres://localhost:5432/aggregator_test',
      // Email copy (and every other config layer) is read from CONFIG_ROOT,
      // which defaults to the container path `/app/config`. Point it at the
      // repo's own config/ so the suite exercises the real files.
      CONFIG_ROOT: fileURLToPath(new URL('../../config', import.meta.url)),
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      exclude: ['node_modules/', 'dist/', '**/*.config.*', '**/server.ts'],
    },
  },
});
