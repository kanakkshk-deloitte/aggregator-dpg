import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reactPlugin = react() as any;

export default defineConfig({
  plugins: [reactPlugin],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/__tests__/setup.ts'],
    css: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70,
      },
      exclude: [
        'node_modules/',
        '.next/',
        'dist/',
        '**/*.config.*',
        '**/__tests__/**',
        'src/app/layout.tsx',
        'src/app/page.tsx',
        'next-env.d.ts',
      ],
    },
  },
});
