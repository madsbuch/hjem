import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:1435',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'phone', use: { ...devices['Pixel 5'], browserName: 'chromium', viewport: { width: 390, height: 844 } } },
    { name: 'tablet', use: { browserName: 'chromium', viewport: { width: 1024, height: 1000 }, hasTouch: true } },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 1435',
    url: 'http://127.0.0.1:1435',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
