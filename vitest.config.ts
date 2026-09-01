import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Each suite builds its own temp directory and its own fakes, so there is
    // no shared state to serialise around and no reason to run them serially.
    passWithNoTests: false,
  },
});
