import { defineConfig } from 'vitest/config';

// Läuft NUR über `npm run test:rules` (firebase emulators:exec) —
// braucht den Firestore-Emulator (FIRESTORE_EMULATOR_HOST).
export default defineConfig({
  test: {
    include: ['rules-test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
