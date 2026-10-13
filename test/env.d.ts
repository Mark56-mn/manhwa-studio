/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from '@cloudflare/vitest-pool-workers'

import type { Env as WorkerEnv } from '../worker/env'

// Bindings visible inside tests: the Worker's own env plus the migrations the
// setup file applies to the test database.
interface TestBindings extends WorkerEnv {
  TEST_MIGRATIONS: D1Migration[]
  LIVE_OPENROUTER_API_KEY?: string
  LIVE_NVIDIA_API_KEY?: string
  LIVE_GEMINI_API_KEY?: string
  LIVE_BASETEN_API_KEY?: string
}

declare global {
  namespace Cloudflare {
    interface Env extends TestBindings {}
  }
}
