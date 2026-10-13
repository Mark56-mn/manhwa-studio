import { Hono } from 'hono'

import { capabilityStatuses } from '../capabilities'
import { REQUIRED_TABLES } from '../lib/constants'
import { inspectSchema } from '../migrations'
import type { IntegrationState } from '../capabilities'
import type { AppBindings } from '../app'

interface CheckResult {
  state: IntegrationState
  detail: string
  latencyMs?: number
  missing?: string[]
}

async function checkDatabase(db: D1Database): Promise<CheckResult> {
  const started = Date.now()
  try {
    const schema = await inspectSchema(db)
    const latencyMs = Date.now() - started
    if (schema.missing.length === 0) {
      return {
        state: 'connected_verified',
        detail: `Queried the project database directly; all ${REQUIRED_TABLES.length} required tables are present.`,
        latencyMs,
      }
    }
    if (schema.missing.length === REQUIRED_TABLES.length) {
      return {
        state: 'failed',
        detail:
          'The database is reachable but has no studio schema yet. Initialize it once (POST /api/bootstrap or the button in the studio), or run: npm run db:migrate:remote.',
        latencyMs,
        missing: schema.missing,
      }
    }
    return {
      state: 'failed',
      detail: `${schema.missing.length} required table(s) are missing. Apply migrations: npm run db:migrate:local (local) or npm run db:migrate:remote (deployed).`,
      latencyMs,
      missing: schema.missing,
    }
  } catch (error) {
    return {
      state: 'failed',
      detail: `Database query failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      latencyMs: Date.now() - started,
    }
  }
}

async function checkAssets(env: AppBindings['Bindings']): Promise<CheckResult> {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') {
    return { state: 'not_configured', detail: 'No static-asset binding is attached to this deployment.' }
  }
  try {
    const response = await env.ASSETS.fetch(new Request(new URL('/index.html', env.APP_ORIGIN)))
    if (!response.ok) {
      return { state: 'failed', detail: `Static asset request for /index.html returned HTTP ${response.status}.` }
    }
    const body = await response.text()
    if (!body.includes('<div id="root">')) {
      return { state: 'failed', detail: 'Served /index.html but it is not the studio shell.' }
    }
    return { state: 'connected_verified', detail: 'Served the built application shell from the asset binding.' }
  } catch (error) {
    return {
      state: 'failed',
      detail: `Could not read static assets: ${error instanceof Error ? error.message : 'unknown error'}`,
    }
  }
}

function checkAuth(env: AppBindings['Bindings']): CheckResult {
  if (!env.FREEBUFF_CLIENT_ID || !env.APP_ORIGIN) {
    return {
      state: 'not_configured',
      detail: 'Sign in with Freebuff needs FREEBUFF_CLIENT_ID and APP_ORIGIN. Sign-in is disabled until they are set.',
    }
  }
  return {
    state: 'configured_unverified',
    detail: `Sign in with Freebuff is configured for ${env.APP_ORIGIN}. Not yet verified by a real sign-in on this deployment.`,
  }
}

export const healthRoutes = new Hono<AppBindings>()

healthRoutes.get('/health', async (c) => {
  const env = c.env
  const [database, assets] = await Promise.all([checkDatabase(env.DB), checkAssets(env)])
  const auth = checkAuth(env)

  const ready = database.state === 'connected_verified' && assets.state === 'connected_verified'
  const capabilities = capabilityStatuses(env)
  let schema = { missing: [] as string[], applied: [] as string[], pending: [] as string[] }
  try {
    schema = await inspectSchema(env.DB)
  } catch {
    // Reported by the database check above.
  }

  return c.json(
    {
      status: ready ? 'ready' : 'degraded',
      version: env.APP_VERSION ?? 'unknown',
      runtime: 'cloudflare-worker',
      time: new Date().toISOString(),
      origin: env.APP_ORIGIN ?? null,
      checks: {
        database,
        assets,
        auth,
        mediaStorage: {
          state: 'not_configured',
          detail: 'No object-storage bucket is attached yet; media artifacts arrive in Phase B.',
        },
      },
      capabilities: capabilities.map((capability) => ({
        id: capability.id,
        label: capability.label,
        state: capability.state,
      })),
      migrations: {
        current: '0001_init.sql',
        applied: database.state === 'connected_verified',
        recorded: schema.applied,
        pending: schema.pending,
        initializeWith: 'POST /api/bootstrap',
      },
    },
    ready ? 200 : 503,
  )
})
