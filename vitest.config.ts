import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Every run loop records to the scoreboard by default, and the scoreboard
    // lives in the REAL machine folder (`%LOCALAPPDATA%\aiui\stats`,
    // docs/specs/SPEC-scoreboard.md §6.1). Off for the whole suite, so no test
    // that drives a loop writes there; the tests that are ABOUT recording turn
    // it back on and point the user root at a temp folder of their own.
    env: { AIUI_STATS: 'off' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
    },
  },
});
