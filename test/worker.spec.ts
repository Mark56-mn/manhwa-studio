import { SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'

import { resetDatabase } from './helpers'

// These tests go through the real Worker entrypoint, including the
// `@freebuff/auth` wrapper and the Hono app — no injected identity.
const ORIGIN = 'http://localhost:8787'

beforeEach(resetDatabase)

describe('worker wiring', () => {
  it('reports database readiness from a real query (public, no session)', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/health`)
    const body = (await response.json()) as {
      status: string
      checks: { database: { state: string; latencyMs?: number }; auth: { state: string }; assets: { state: string } }
      migrations: { applied: boolean }
    }

    expect(body.checks.database.state).toBe('connected_verified')
    expect(body.migrations.applied).toBe(true)
    expect(body.checks.auth.state).toBe('configured_unverified')
    // The test runtime has no static-asset binding, so readiness is degraded
    // here; assets are checked over HTTP against wrangler dev and the
    // deployed preview instead.
    expect(body.checks.assets.state).toBe('not_configured')
    expect(body.status).toBe('degraded')
    expect(response.status).toBe(503)
  })

  it('returns 401 for every private API route when signed out', async () => {
    for (const path of ['/api/me', '/api/projects', '/api/overview', '/api/integrations', '/api/activity']) {
      const response = await SELF.fetch(`${ORIGIN}${path}`)
      expect(response.status, path).toBe(401)
      expect(response.headers.get('cache-control'), path).toBe('private, no-store')
    }
  })

  it('answers the session endpoint with a null user when signed out', async () => {
    const response = await SELF.fetch(`${ORIGIN}/auth/freebuff/session`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { user: unknown }
    expect(body.user).toBeNull()
  })

  it('redirects sign-in to the configured issuer with this origin as the callback', async () => {
    const response = await SELF.fetch(`${ORIGIN}/auth/freebuff/signin?returnTo=%2Fprojects`, { redirect: 'manual' })
    expect([302, 303, 307]).toContain(response.status)
    const location = response.headers.get('location')
    expect(location).toBeTruthy()
    const url = new URL(location!)
    expect(url.origin).toBe('https://freebuff.com')
    expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/freebuff/callback`)
    expect(url.searchParams.get('client_id')).toBe('test-client-id')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')?.length ?? 0).toBeGreaterThan(8)
  })

  it('rejects a cross-origin mutation without touching the database', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ title: 'CSRF' }),
    })
    expect(response.status).toBe(403)
    const list = await SELF.fetch(`${ORIGIN}/api/projects`)
    expect(list.status).toBe(401)
  })

  it('refuses to sign out without a same-origin request', async () => {
    const response = await SELF.fetch(`${ORIGIN}/auth/freebuff/signout`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
      redirect: 'manual',
    })
    expect(response.status).toBe(403)
  })
})
