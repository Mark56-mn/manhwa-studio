/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from '@cloudflare/vitest-pool-workers'

import type { Env as WorkerEnv } from '../worker/env'

// Bindings visible inside tests: the Worker's own env plus the migrations the
// setup file applies to the test database.
interface TestBindings extends WorkerEnv {
  TEST_MIGRATIONS: D1Migration[]
}

declare global {
  namespace Cloudflare {
    interface Env extends TestBindings {}
  }
}
