import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'shared/test/**/*.test.ts',
      'functions/test/**/*.test.ts',
      'frontend/test/**/*.test.ts',
      // Die CI-Skripte sind reines JS (dependency-frei, damit der Watchdog
      // ohne npm ci läuft) — ihre Tests deshalb .mjs statt .ts.
      'scripts-ci/test/**/*.test.mjs',
    ],
    environment: 'node',
  },
});
