import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'functions/test/**/*.test.ts', 'shared/test/**/*.test.ts', 'scripts-ci/test/**/*.test.mjs'],
    environment: 'node',
    testTimeout: 20000,
  },
});
