import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the pure logic in src/lib — segment planning, dedup
 * canonicalisation, chunk assembly, rate limiting, QR expiry, chat import.
 *
 * Deliberately NOT built on vite.config.ts. The app config pulls in
 * node-polyfills and the React plugin so the browser bundle can host GramJS;
 * none of that belongs in a node-side unit run, and inheriting it would make
 * these tests slow and coupled to the bundler setup. The modules under test are
 * written to import nothing that needs a browser — that constraint is the whole
 * reason they are separable — so plain esbuild transpilation is enough.
 *
 * Anything that needs a real browser (upload, download, Telegram, the DOM) is
 * a Playwright test instead; see tests/.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Playwright's specs also end in .spec.ts and must not be collected here.
    exclude: ['node_modules/**', 'dist/**', 'tests/**', 'tests_scratch/**'],
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'test-results/vitest-junit.xml' },
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts'],
      exclude: ['src/lib/**/*.test.ts'],
      reportsDirectory: 'coverage',
    },
  },
});
