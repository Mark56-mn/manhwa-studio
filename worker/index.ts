import { createFreebuffAuth } from '@freebuff/auth'

import { createApp } from './app'

import type { Env } from './env'

type WrappedFetch = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>

// One auth instance and one wrapped handler per isolate: auth caches OIDC
// discovery and signing keys, and the Hono app is stateless.
let cachedFetch: WrappedFetch | undefined

function isLoopback(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin)
    return protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
  } catch {
    return false
  }
}

function setup(env: Env): WrappedFetch {
  if (cachedFetch) return cachedFetch

  const auth = createFreebuffAuth({
    clientId: env.FREEBUFF_CLIENT_ID,
    issuer: env.FREEBUFF_ISSUER,
    // Canonical origin from configuration — never derived from the request.
    baseUrl: env.APP_ORIGIN,
    // Only honoured for loopback origins; false on any deployed origin.
    allowInsecureLocalhost: isLoopback(env.APP_ORIGIN),
  })

  const app = createApp({ getUser: (request) => auth.getUser(request) })

  // wrap() runs before the app, so /auth/freebuff/* is served and every other
  // request arrives with a refreshed session when available.
  cachedFetch = auth.wrap((request, runtimeEnv: Env, ctx: ExecutionContext) =>
    app.fetch(request, runtimeEnv, ctx),
  )
  return cachedFetch
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return setup(env)(request, env, ctx)
  },
}
