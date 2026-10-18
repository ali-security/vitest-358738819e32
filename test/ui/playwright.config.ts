import { defineConfig, devices } from '@playwright/test'

const slow = process.platform === 'darwin' || process.platform === 'win32'

export default defineConfig({
  testDir: './test',
  timeout: slow ? 90_000 : 30_000,
  expect: { timeout: slow ? 15_000 : 5_000 },
  projects: [
    {
      name: 'chromium',
      // increase viewport height so virtual scroller renders all explorer items
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
  ],
  use: {
    trace: process.env.CI ? 'on-first-retry' : 'on',
  },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
})
