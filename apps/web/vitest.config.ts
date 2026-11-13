import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { applyTerms } from './src/i18n/terms';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reactPlugin = react() as any;

// Tests import the message files directly; fill their term placeholders the
// same way `src/i18n/request.ts` does at runtime.
const MESSAGE_FILE = /\/i18n\/messages\/(\w+)\.json$/;
const termsPlugin = {
  name: 'i18n-terms',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    const locale = MESSAGE_FILE.exec(id)?.[1];
    return locale ? JSON.stringify(applyTerms(JSON.parse(code), locale)) : null;
  },
};

export default defineConfig({
  plugins: [reactPlugin, termsPlugin],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // `server-only` has no npm package on disk — Next.js recognises the
      // bare specifier internally at build time. Vite's resolver can't do
      // that, so `*.server.ts` files are unimportable under Vitest without
      // this alias to a no-op shim. See src/__tests__/mocks/server-only.ts.
      'server-only': path.resolve(__dirname, './src/__tests__/mocks/server-only.ts'),
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
        // Pure `export type`/`export interface` re-export modules — zero
        // runtime statements after erasure, same rationale as *.d.ts.
        'src/types/**',
        // `ConsentDocContent`/`ParticipantConsent` are `export interface`
        // declarations only — zero runtime statements after erasure.
        'src/components/consent/consent-types.ts',
        // `src/i18n/request.ts`'s computed dynamic import
        // (`import(\`./messages/${locale}.json\`)`) makes Vite synthesize a
        // `\0vite/dynamic-import-helper.js` virtual module. V8 coverage
        // picks it up as a "file", and istanbul's html/lcov reporters crash
        // trying to turn its null-byte-prefixed id into a directory path.
        // It's Vite's own runtime shim, not our code — exclude it.
        '**/dynamic-import-helper.js',
      ],
    },
  },
});
