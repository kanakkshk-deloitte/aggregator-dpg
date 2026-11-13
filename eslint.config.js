import tseslint from 'typescript-eslint';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import importX from 'eslint-plugin-import-x';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import globals from 'globals';

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/*.tsbuildinfo',
      '**/pnpm-lock.yaml',
    ],
  },

  // Base TS rules for all packages
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    plugins: {
      'import-x': importX,
    },
    settings: {
      // Use import-x's modern resolver (interfaceVersion 3) instead of the
      // legacy default. Without this, import-x falls back to loading a legacy
      // 'node' resolver, whose loader throws "node with invalid interface" in
      // this toolchain and crashes `import-x/no-cycle`. The TypeScript resolver
      // handles workspace path aliases (@/*) and node_modules alike.
      'import-x/resolver-next': [
        createTypeScriptImportResolver({
          alwaysTryTypes: true,
          project: ['apps/*/tsconfig.json', 'packages/*/tsconfig.json'],
        }),
      ],
    },
    rules: {
      // Disallow unused vars except those prefixed with _
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Enforce consistent type imports
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // No barrel re-exports of everything
      'import-x/no-cycle': 'error',
    },
  },

  // Extra a11y rules for the web app only
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: {
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...jsxA11y.configs.recommended.rules,
    },
  },

  // Looser rules for config / script files
  {
    files: ['**/*.config.{js,mjs,cjs}', '**/scripts/**/*.{js,mjs}'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
