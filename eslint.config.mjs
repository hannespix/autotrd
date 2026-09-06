// ESLint Flat Config für den Auto-Trader (src/ + test/).
// Der Altbestand der Firebase-Plattform (functions/, frontend/, shared/, …)
// bleibt bis zu seiner Löschung im Baum, wird aber nicht mehr geprüft.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/lib/**',
      '**/var/**',
      '**/*.d.ts',
      // Altbestand
      'frontend/**',
      'functions/**',
      'shared/**',
      'reference/**',
      'rules-test/**',
      'scripts-ci/**',
      'supabase/**',
      'vitest.rules.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Betriebs-Skripte (Optimierer-Workflow) laufen in Node: process/console sind dort global.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Ein Auto-Trader darf nie stumm scheitern: leere catch-Blöcke sind verboten.
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },
);
