// ESLint Flat Config für den Handelskern (src/ + test/) und die Betriebs-Skripte.
// Die Workspaces functions/, frontend/ und shared/ werden über ihre eigenen
// tsconfigs geprüft (npm run typecheck --workspace …).
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
      // eigene Workspaces (eigene tsconfig/Prüfung)
      'frontend/**',
      'functions/**',
      'shared/**',
      'scripts-ci/**',
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
