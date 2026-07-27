// ESLint Flat Config — gilt für alle Workspaces (shared/functions/frontend).
// reference/ (Python-Referenz) und Build-Artefakte sind ausgenommen.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/lib/**',
      'reference/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // Service Worker läuft im Worker-Global-Scope (self/caches/fetch)
  {
    files: ['frontend/public/sw.js'],
    languageOptions: {
      globals: {
        self: 'readonly',
        caches: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        Promise: 'readonly',
        console: 'readonly',
      },
    },
  },
  // CI-Hilfsscripte laufen in Node (process/console sind dort global)
  {
    files: ['scripts-ci/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        Buffer: 'readonly',
        URLSearchParams: 'readonly',
        AbortSignal: 'readonly',
      },
    },
  },
);
