import { defineConfig, devices } from '@playwright/test';

/**
 * Dedicated Playwright config for real Service Worker and IndexedDB tests.
 * RULE 2: fullyParallel MUST be false to prevent SW registration deadlocks.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false, // RULE 2
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // Ensure single worker for real storage isolation
  reporter: 'html',
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    video: 'on-first-retry'
  },
  webServer: {
    command: 'npx serve -l 4173 .',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000
  },
  projects: [
    {
      name: 'real-storage',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /.*real-storage\.spec\.ts/
    }
  ]
});