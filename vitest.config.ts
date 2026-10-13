import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

import { sqlText } from './vite.sql-plugin.mts'

// Tests execute inside workerd (the real Workers runtime) against a real D1
// database created from ./migrations by test/setup.ts.
export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations')

  return {
    plugins: [
      sqlText(),
      cloudflareTest({
        main: './worker/index.ts',
        miniflare: {
          compatibilityDate: '2026-08-01',
          d1Databases: ['DB'],
          bindings: {
            FREEBUFF_CLIENT_ID: 'test-client-id',
            FREEBUFF_ISSUER: 'https://freebuff.com/oidc',
            APP_ORIGIN: 'http://localhost:8787',
            APP_VERSION: '0.1.0-test',
            // Live-provider tests run only when these real keys are present.
            // They are read from the developer's environment, never committed.
            LIVE_OPENROUTER_API_KEY: process.env.LIVE_OPENROUTER_API_KEY ?? '',
            LIVE_NVIDIA_API_KEY: process.env.LIVE_NVIDIA_API_KEY ?? '',
            LIVE_GEMINI_API_KEY: process.env.LIVE_GEMINI_API_KEY ?? '',
            LIVE_BASETEN_API_KEY: process.env.LIVE_BASETEN_API_KEY ?? '',
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      include: ['test/**/*.spec.ts'],
      setupFiles: ['./test/setup.ts'],
    },
  }
})
