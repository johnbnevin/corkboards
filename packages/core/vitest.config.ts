import { defineConfig } from 'vitest/config';

// @corkboards/core is pure TS (no DOM/React), so its tests run in the plain node
// environment — where crypto.subtle, TextEncoder/Decoder and btoa/atob all exist.
// This gives core a REAL test runner: before, a test placed in core was executed
// by nobody (`test:core` only ran tsc + eslint), so a core regression could only
// be caught indirectly by whichever web test happened to import the module.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
