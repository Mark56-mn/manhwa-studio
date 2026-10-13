import { SELF, env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MIGRATIONS, MIGRATIONS_TABLE, splitStatements } from '../worker/migrations'
import { AUTHOR, call, json } from './helpers'

const ORIGIN = 'http://localhost:8787'
const TABLES = ['activity_events', 'characters', 'episodes', 'seasons', 'projects', 'users', 'd1_migrations']

async function dropTables(tables: string[] = TABLES): Promise<void> {
  const db = (env as unknown as { DB: D1Database }).DB
  await db.batch(tables.map((table) => db.prepare(`DROP TABLE IF EXISTS ${table}`)))
}

/**
 * Restores the shared test database for the other spec files by re-running the
 * (idempotent) schema statements, even when bootstrap deliberately refused.
 */
afterEach(async () => {
  const db = (env as unknown as { DB: D1Database }).DB
  await db.batch([
    ...splitStatements(MIGRATIONS_TABLE).map((statement) => db.prepare(statement)),
    ...MIGRATIONS.flatMap((migration) => splitStatements(migration.sql)).map((statement) => db.prepare(statement)),
    ...MIGRATIONS.map((migration) =>
      db
        .prepare('INSERT OR IGNORE INTO d1_migrations (name, applied_at) VALUES (?, ?)')
        .bind(migration.name, new Date().toISOString()),
    ),
  ])
})

describe('database initialization', () => {
  beforeEach(() => dropTables())

  it('reports an empty database honestly instead of pretending to be ready', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/health`)
    expect(response.status).toBe(503)
    const body = (await response.json()) as {
      status: string
      checks: { database: { state: string; detail: string; missing?: string[] } }
      migrations: { applied: boolean; pending: string[] }
    }
    expect(body.status).toBe('degraded')
    expect(body.checks.database.state).toBe('failed')
    expect(body.checks.database.detail).toContain('no studio schema yet')
    expect(body.checks.database.missing).toHaveLength(6)
    expect(body.migrations.applied).toBe(false)
    expect(body.migrations.pending).toEqual(['0001_init.sql'])
  })

  it('creates the schema once, then reports the database as verified', async () => {
    const first = await SELF.fetch(`${ORIGIN}/api/bootstrap`, { method: 'POST', headers: { Origin: ORIGIN } })
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as { status: string; applied: string[]; detail: string }
    expect(firstBody.status).toBe('initialized')
    expect(firstBody.applied).toEqual(['0001_init.sql'])

    const health = (await (await SELF.fetch(`${ORIGIN}/api/health`)).json()) as {
      checks: { database: { state: string } }
      migrations: { applied: boolean; recorded: string[] }
    }
    expect(health.checks.database.state).toBe('connected_verified')
    expect(health.migrations.applied).toBe(true)
    expect(health.migrations.recorded).toEqual(['0001_init.sql'])

    const again = await SELF.fetch(`${ORIGIN}/api/bootstrap`, { method: 'POST', headers: { Origin: ORIGIN } })
    expect(again.status).toBe(200)
    expect((await again.json()) as { status: string }).toMatchObject({ status: 'already_initialized' })
  })

  it('refuses to touch a partially present schema', async () => {
    // Start from a complete schema, then remove one table.
    await SELF.fetch(`${ORIGIN}/api/bootstrap`, { method: 'POST', headers: { Origin: ORIGIN } })
    await dropTables(['activity_events'])
    const response = await SELF.fetch(`${ORIGIN}/api/bootstrap`, { method: 'POST', headers: { Origin: ORIGIN } })
    expect(response.status).toBe(409)
    const body = (await response.json()) as { status: string; missing: string[] }
    expect(body.status).toBe('refused')
    expect(body.missing).toEqual(['activity_events'])
  })

  it('requires a same-origin request to initialize', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/bootstrap`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
    })
    expect(response.status).toBe(403)
    const health = (await (await SELF.fetch(`${ORIGIN}/api/health`)).json()) as {
      checks: { database: { state: string } }
    }
    expect(health.checks.database.state).toBe('failed')
  })
})

describe('authenticated API without a schema', () => {
  beforeEach(() => dropTables())

  it('answers 503 with a clear code instead of an internal error', async () => {
    const response = await call(AUTHOR, '/api/projects')
    expect(response.status).toBe(503)
    expect(await json(response)).toMatchObject({ code: 'database_not_initialized' })
  })
})
