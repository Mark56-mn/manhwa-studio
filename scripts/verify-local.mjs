// End-to-end HTTP verification of the built Worker.
//
// Starts `wrangler dev` (workerd) against a throwaway local D1, exercises the
// real HTTP surface — shell, assets, readiness, bootstrap, authorization, CSRF
// and the Phase B script/provider routes — then shuts it down.
//
//   node scripts/verify-local.mjs
//
// Exits non-zero on the first failed expectation.
import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'

const PORT = process.env.VERIFY_PORT ?? '8788'
const BASE = `http://127.0.0.1:${PORT}`
/** Must match APP_ORIGIN in wrangler.jsonc; used for the same-origin checks. */
const APP_ORIGIN = 'http://localhost:8787'
const PERSIST = '.wrangler/verify'

let pass = 0
let fail = 0

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${name}${detail ? ` (${detail})` : ''}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ''}`)
  }
}

function equal(name, expected, actual) {
  check(name, expected === actual, `expected ${expected}, got ${actual}`)
}

async function get(path, init) {
  return fetch(`${BASE}${path}`, init)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForServer(timeoutMs = 90_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) })
      return true
    } catch {
      await sleep(400)
    }
  }
  return false
}

async function main() {
  await rm(PERSIST, { recursive: true, force: true })

  const server = spawn(
    'node_modules/.bin/wrangler',
    ['dev', '--port', PORT, '--ip', '127.0.0.1', '--persist-to', PERSIST, '--log-level', 'warn'],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let serverLog = ''
  server.stdout.on('data', (chunk) => (serverLog += chunk.toString()))
  server.stderr.on('data', (chunk) => (serverLog += chunk.toString()))

  const stop = () => {
    try {
      process.kill(-server.pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }

  try {
    if (!(await waitForServer())) {
      console.error('wrangler dev did not become ready. Last output:\n' + serverLog.slice(-3000))
      process.exitCode = 1
      return
    }

    console.log('== public shell ==')
    const root = await get('/')
    equal('GET / status', 200, root.status)
    equal('GET / content-type', 'text/html; charset=utf-8', root.headers.get('content-type') ?? '')
    const rootHtml = await root.text()
    check('served the studio shell', rootHtml.includes('<div id="root">'))
    equal('GET /projects (SPA fallback) status', 200, (await get('/projects')).status)
    const js = /\/assets\/[^"]+\.js/.exec(rootHtml)?.[0] ?? ''
    const css = /\/assets\/[^"]+\.css/.exec(rootHtml)?.[0] ?? ''
    const jsRes = await get(js)
    equal('JS asset status', 200, jsRes.status)
    check('JS content-type is javascript', (jsRes.headers.get('content-type') ?? '').startsWith('text/javascript'), jsRes.headers.get('content-type') ?? '')
    const cssRes = await get(css)
    equal('CSS asset status', 200, cssRes.status)
    check('CSS content-type is css', (cssRes.headers.get('content-type') ?? '').startsWith('text/css'), cssRes.headers.get('content-type') ?? '')
    equal('favicon status', 200, (await get('/favicon.svg')).status)

    console.log('== empty database is reported honestly ==')
    const before = await get('/api/health')
    equal('GET /api/health status', 503, before.status)
    const beforeBody = await before.json()
    equal('status', 'degraded', beforeBody.status)
    equal('database state', 'failed', beforeBody.checks.database.state)
    equal('required tables missing', 10, (beforeBody.checks.database.missing ?? []).length)
    equal(
      'pending migrations named',
      '0001_init.sql,0002_phase_b_scripts.sql',
      (beforeBody.migrations.pending ?? []).join(','),
    )

    console.log('== bootstrap applies migrations ==')
    const boot = await get('/api/bootstrap', { method: 'POST', headers: { Origin: APP_ORIGIN } })
    equal('POST /api/bootstrap status', 200, boot.status)
    const bootBody = await boot.json()
    equal('bootstrap status', 'initialized', bootBody.status)
    equal('applied migrations', '0001_init.sql,0002_phase_b_scripts.sql', (bootBody.applied ?? []).join(','))

    const after = await get('/api/health')
    equal('GET /api/health status', 200, after.status)
    const afterBody = await after.json()
    equal('status', 'ready', afterBody.status)
    equal('database state', 'connected_verified', afterBody.checks.database.state)
    equal('migrations applied flag', true, afterBody.migrations.applied)
    check(
      'media storage is reported as not attached',
      afterBody.checks.mediaStorage.state === 'not_configured',
      afterBody.checks.mediaStorage.state,
    )

    const again = await get('/api/bootstrap', { method: 'POST', headers: { Origin: APP_ORIGIN } })
    equal('second POST /api/bootstrap status', 200, again.status)
    equal('second bootstrap status', 'already_initialized', (await again.json()).status)

    console.log('== cross-origin mutation refusals ==')
    const csrfBootstrap = await get('/api/bootstrap', {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
    })
    equal('POST /api/bootstrap foreign Origin', 403, csrfBootstrap.status)

    console.log('== private routes are closed without a session ==')
    const privatePaths = [
      '/api/me',
      '/api/projects',
      '/api/overview',
      '/api/integrations',
      '/api/activity',
      '/api/episodes/ep_unknown/scripts',
      '/api/scripts/scr_unknown',
    ]
    for (const path of privatePaths) {
      const response = await get(path)
      equal(`GET ${path} status`, 401, response.status)
      equal(`GET ${path} cache-control`, 'private, no-store', response.headers.get('cache-control') ?? '')
    }

    const postPaths = ['/api/episodes/ep_unknown/scripts', '/api/scripts/scr_unknown/approve']
    for (const path of postPaths) {
      const foreign = await get(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: 'https://evil.example' },
        body: '{}',
      })
      equal(`POST ${path} foreign Origin`, 403, foreign.status)
      const sameOrigin = await get(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: APP_ORIGIN },
        body: '{}',
      })
      equal(`POST ${path} without session`, 401, sameOrigin.status)
    }

    const verifyForeign = await get('/api/integrations/script/verify', {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
    })
    equal('POST /api/integrations/script/verify foreign Origin', 403, verifyForeign.status)
    const verifyAnon = await get('/api/integrations/script/verify', {
      method: 'POST',
      headers: { Origin: APP_ORIGIN },
    })
    equal('POST /api/integrations/script/verify without session', 401, verifyAnon.status)

    console.log('== auth routes ==')
    const session = await get('/auth/freebuff/session')
    equal('GET /auth/freebuff/session status', 200, session.status)
    equal('session user is null', true, (await session.json()).user === null)

    const signin = await get('/auth/freebuff/signin?returnTo=%2Fprojects', { redirect: 'manual' })
    check('signin redirects', [302, 303, 307].includes(signin.status), String(signin.status))
    const location = signin.headers.get('location') ?? ''
    const url = new URL(location)
    check('signin issuer is the configured one', url.origin === 'https://freebuff.com', url.origin)
    check('signin client id present', (url.searchParams.get('client_id') ?? '').length > 0)
    equal('signin callback is this deployment origin', `${APP_ORIGIN}/auth/freebuff/callback`, url.searchParams.get('redirect_uri') ?? '')
    equal('signin uses PKCE S256', 'S256', url.searchParams.get('code_challenge_method') ?? '')
    check('signin carries state', (url.searchParams.get('state') ?? '').length > 8)

    console.log('== callback without parameters is rejected ==')
    const badCallback = await get('/auth/freebuff/callback', { redirect: 'manual' })
    check('callback without params is not a success', badCallback.status >= 400, String(badCallback.status))
  } finally {
    stop()
    await sleep(600)
  }

  console.log('')
  console.log(`passed=${pass} failed=${fail}`)
  if (fail > 0) process.exitCode = 1
}

await main()
