import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['shared/test/**/*.test.ts', 'functions/test/**/*.test.ts', 'frontend/test/**/*.test.ts'],
    environment: 'node',
  },
});
