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

export function testEnv(): Env {
  return { ...(env as unknown as Env), ASSETS: assetsStub }
}

/** Calls the app with a fixed signed-in identity, like the real wrapper does. */
export async function call(
  user: FreebuffUser | null,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const app = createApp({ getUser: async () => user })
  const headers = new Headers(init.headers)
  const method = (init.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD' && !headers.has('Origin')) {
    headers.set('Origin', ORIGIN)
  }
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return app.request(path, { ...init, method, headers }, testEnv())
}

/** The test pool shares one D1 database between tests, so each test resets it. */
export async function resetDatabase(): Promise<void> {
  const db = (env as unknown as Env).DB
  await db.batch([
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

export async function createProject(user: FreebuffUser, title = 'Test Story'): Promise<{ id: string; title: string }> {
  const response = await call(user, '/api/projects', {
    method: 'POST',
    body: JSON.stringify({ title }),
  })
  if (response.status !== 201) throw new Error(`createProject failed: ${response.status} ${await response.text()}`)
  const body = await json<{ project: { id: string; title: string } }>(response)
  return body.project
}
