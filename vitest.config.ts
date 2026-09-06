import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'functions/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
  },
});
