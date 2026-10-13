import { isSameOriginRequest } from '@freebuff/auth'
import { Hono } from 'hono'

import { ensureUser } from './db'
import { HttpError } from './lib/errors'
import { newId } from './lib/ids'
import { accountRoutes } from './routes/account'
import { aiRoutes } from './routes/ai'
import { directorRoutes } from './routes/director'
import { activityRoutes } from './routes/activity'
import { characterRoutes } from './routes/characters'
import { episodeRoutes } from './routes/episodes'
import { bootstrapRoutes } from './routes/bootstrap'
import { healthRoutes } from './routes/health'
import { integrationRoutes } from './routes/integrations'
import { overviewRoutes } from './routes/overview'
import { projectRoutes } from './routes/projects'
import { scriptRoutes } from './routes/scripts'
import { seasonRoutes } from './routes/seasons'

import type { FreebuffUser } from '@freebuff/auth'

import type { Env } from './env'

export interface AppBindings {
  Bindings: Env
  Variables: { user: FreebuffUser }
}

export interface AppDeps {
  /**
   * Resolves the signed-in account for a request. In production this is
   * `@freebuff/auth`'s verification; tests inject a fixed identity so
   * authorization rules can be exercised without a live Freebuff session.
   */
  getUser(request: Request): Promise<FreebuffUser | null>
}

const PUBLIC_API_PATHS = new Set(['/api/health', '/api/bootstrap'])

export function createApp(deps: AppDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>()

  // 1. State-changing requests must come from this site's own pages.
  app.use('/api/*', async (c, next) => {
    const method = c.req.method
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next()
    if (!isSameOriginRequest(c.req.raw, c.env.APP_ORIGIN)) {
      return c.json({ error: 'Cross-origin request rejected', code: 'cross_origin' }, 403)
    }
    return next()
  })

  // 2. Everything except the readiness endpoint requires a signed-in account.
  app.use('/api/*', async (c, next) => {
    if (PUBLIC_API_PATHS.has(c.req.path)) {
      c.header('Cache-Control', 'no-store')
      return next()
    }
    // Personalized responses are never cached, including the 401.
    c.header('Cache-Control', 'private, no-store')
    const user = await deps.getUser(c.req.raw)
    if (!user) return c.json({ error: 'Sign in required', code: 'unauthenticated' }, 401)
    c.set('user', user)
    try {
      await ensureUser(c.env.DB, user)
    } catch (error) {
      // The realistic cause is a database that has no studio schema yet.
      return c.json(
        {
          error: 'The studio database has no schema yet.',
          code: 'database_not_initialized',
          detail: 'Initialize it once from the studio, or POST /api/bootstrap.',
          cause: error instanceof Error ? error.message : 'unknown error',
        },
        503,
      )
    }
    return next()
  })

  app.route('/api', healthRoutes)
  app.route('/api', bootstrapRoutes)
  app.route('/api', accountRoutes)
  app.route('/api', overviewRoutes)
  app.route('/api', projectRoutes)
  app.route('/api', scriptRoutes)
  app.route('/api', directorRoutes)
  app.route('/api', aiRoutes)
  app.route('/api', episodeRoutes)
  app.route('/api', seasonRoutes)
  app.route('/api', characterRoutes)
  app.route('/api', activityRoutes)
  app.route('/api', integrationRoutes)

  app.notFound(async (c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'No such API route', code: 'not_found', path: c.req.path }, 404)
    }
    // Public pages and the studio shell are served from assets (SPA fallback).
    if (c.env.ASSETS && typeof c.env.ASSETS.fetch === 'function') {
      return c.env.ASSETS.fetch(c.req.raw)
    }
    return c.json({ error: 'Not found', code: 'not_found' }, 404)
  })

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json(
        { error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) },
        error.status as 400,
      )
    }
    const requestId = newId('err')
    // Never log request bodies, cookies or headers.
    console.error(`[${requestId}] ${c.req.method} ${c.req.path} failed:`, error instanceof Error ? error.message : error)
    return c.json({ error: 'Internal error', code: 'internal_error', requestId }, 500)
  })

  return app
}
