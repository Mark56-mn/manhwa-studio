import { env } from 'cloudflare:test'

import { createApp } from '../worker/app'

import type { FreebuffUser } from '@freebuff/auth'
import type { Env } from '../worker/env'

export const ORIGIN = 'http://localhost:8787'

export const AUTHOR: FreebuffUser = {
  sub: 'freebuff-user-author',
  name: 'Author',
  email: 'author@example.com',
}

export const OTHER: FreebuffUser = { sub: 'freebuff-user-other', name: 'Other' }

const assetsStub = {
  fetch: async () =>
    new Response('<!doctype html><html><body><div id="root"></div></body></html>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
}

export function testEnv(overrides: Partial<Env> = {}): Env {
  return { ...(env as unknown as Env), ASSETS: assetsStub, ...overrides }
}

/** Calls the app with a fixed signed-in identity, like the real wrapper does. */
export async function call(
  user: FreebuffUser | null,
  path: string,
  init: RequestInit = {},
  envOverrides: Partial<Env> = {},
): Promise<Response> {
  const app = createApp({ getUser: async () => user })
  const headers = new Headers(init.headers)
  const method = (init.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD' && !headers.has('Origin')) {
    headers.set('Origin', ORIGIN)
  }
  // A multipart body must keep its own content type (the runtime adds the boundary).
  if (init.body && !headers.has('content-type') && !(init.body instanceof FormData)) {
    headers.set('content-type', 'application/json')
  }
  return app.request(path, { ...init, method, headers }, testEnv(envOverrides))
}

/** The test pool shares one D1 database between tests, so each test resets it. */
export async function resetDatabase(): Promise<void> {
  const db = (env as unknown as Env).DB
  await db.batch([
    db.prepare('DELETE FROM script_approvals'),
    db.prepare('DELETE FROM scenes'),
    db.prepare('DELETE FROM script_versions'),
    db.prepare('DELETE FROM director_plans'),
    db.prepare('DELETE FROM assets'),
    db.prepare('DELETE FROM provider_checks'),
    db.prepare('DELETE FROM ai_route_events'),
    db.prepare('DELETE FROM ai_provider_state'),
    db.prepare('DELETE FROM ai_model_catalog'),
    db.prepare('DELETE FROM ai_settings'),
    db.prepare('DELETE FROM activity_events'),
    db.prepare('DELETE FROM characters'),
    db.prepare('DELETE FROM episodes'),
    db.prepare('DELETE FROM seasons'),
    db.prepare('DELETE FROM projects'),
    db.prepare('DELETE FROM users'),
  ])
}

export async function json<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T
}

/** Provider configuration used by the script specs: a fake key plus a model. */
export const PROVIDER_ENV: Record<string, string> = {
  SCRIPT_PROVIDER: 'openai',
  SCRIPT_API_KEY: 'test-key-not-a-real-secret',
  SCRIPT_MODEL: 'gpt-6-luna',
}

export async function createEpisode(
  user: FreebuffUser,
  projectId: string,
  title = 'Episode One',
): Promise<{ id: string; episodeNumber: number }> {
  const response = await call(user, `/api/projects/${projectId}/episodes`, {
    method: 'POST',
    body: JSON.stringify({ title }),
  })
  if (response.status !== 201) throw new Error(`createEpisode failed: ${response.status} ${await response.text()}`)
  const body = await json<{ episode: { id: string; episodeNumber: number } }>(response)
  return body.episode
}

export async function createProject(user: FreebuffUser, title = 'Test Story'): Promise<{ id: string; title: string }> {
  const response = await call(user, '/api/projects', {
    method: 'POST',
    body: JSON.stringify({ title }),
  })
  if (response.status !== 201) throw new Error(`createProject failed: ${response.status} ${await response.text()}`)
  const body = await json<{ project: { id: string; title: string } }>(response)
  return body.project
}
