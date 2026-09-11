import { defineConfig, devices } from '@playwright/test';

// Keep feature verification on the project's locked frontend port.
export default defineConfig({
  testDir: './tests/isolated',
  testMatch: 'upload-statistics.spec.ts',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:3000', screenshot: 'only-on-failure', serviceWorkers: 'block' },
  // Tests serve dist through browser routing, so an existing service on 3000
  // is neither contacted nor restarted. Run npm run build before this suite.
});
