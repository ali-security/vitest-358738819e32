import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { instances, provider, providers } from '../../settings'

export default defineConfig({
  cacheDir: fileURLToPath(new URL("./node_modules/.vite", import.meta.url)),
  test: {
    testTimeout: process.platform === 'win32' || process.platform === 'darwin' ? 60_000 : undefined,
    browser: {
      enabled: true,
      provider: provider.name === 'playwright'
        ? providers.playwright({ actionTimeout: 500 })
        : provider,
      instances,
    },
    expect: {
      poll: {
        timeout: 500,
      },
    },
  },
})
