import { defineConfig } from '@playwright/test';

// Separate config because tests/package.spec.ts boots the assembled green package rather than
// the repository build, so it only runs after `npm run package`.
export default defineConfig({
  testDir: './tests',
  testMatch: 'package.spec.ts',
  workers: 1,
  timeout: 120000,
  expect: { timeout: 10000 },
  outputDir: '.test-data/package-playwright',
  reporter: 'list',
  use: {
    channel: process.platform === 'win32' ? 'msedge' : undefined,
    headless: true,
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'off',
  },
});
