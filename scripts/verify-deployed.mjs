// Verifies a deployed origin (preview or production) over real HTTPS.
//
//   node scripts/verify-deployed.mjs https://<site>.freebuff.page
//
// Unlike scripts/verify-local.mjs this never starts a server, and it refuses to
// touch the database when the schema is already current: the bootstrap endpoint
// is idempotent and reports which migrations it applied.
const BASE = (process.argv[2] ?? process.env.DEPLOYED_BASE ?? '').replace(/\/+$/, '')

if (!BASE) {
  console.error('Usage: node scripts/verify-deployed.mjs https://<origin>')
  process.exit(2)
}

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

const get = (path, init) => fetch(`${BASE}${path}`, init)

async function main() {
  console.log(`verifying ${BASE}`)

  console.log('== public shell ==')
  const root = await get('/')
  equal('GET / status', 200, root.status)
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

  console.log('== schema state ==')
  const healthBefore = await get('/api/health')
  const before = await healthBefore.json()
  console.log(
    `  info  status=${before.status} db=${before.checks.database.state} migrations=${JSON.stringify(before.migrations)}`,
  )

  if (before.checks.database.state !== 'connected_verified') {
    console.log('  info  applying pending migrations through POST /api/bootstrap')
    const boot = await get('/api/bootstrap', { method: 'POST', headers: { Origin: BASE } })
    equal('POST /api/bootstrap status', 200, boot.status)
    const body = await boot.json()
    console.log(`  info  bootstrap status=${body.status} applied=${JSON.stringify(body.applied)}`)
    check('bootstrap applied or confirmed the Phase B migration', 
      (body.applied ?? []).includes('0002_phase_b_scripts.sql') || body.status === 'already_initialized',
      body.status)
  } else {
    console.log('  info  schema already current; no bootstrap call made')
  }

  console.log('== readiness ==')
  const health = await get('/api/health')
  equal('GET /api/health status', 200, health.status)
  const report = await health.json()
  equal('status', 'ready', report.status)
  equal('database state', 'connected_verified', report.checks.database.state)
  equal('assets state', 'connected_verified', report.checks.assets.state)
  equal('migrations applied', true, report.migrations.applied)
  check(
    'Phase B migration recorded',
    (report.migrations.recorded ?? []).includes('0002_phase_b_scripts.sql'),
    JSON.stringify(report.migrations.recorded),
  )
  check(
    'script capability is honest about configuration',
    ['not_configured', 'configured_unverified', 'connected_verified', 'failed'].includes(
      (report.capabilities ?? []).find((entry) => entry.id === 'script')?.state,
    ),
    (report.capabilities ?? []).find((entry) => entry.id === 'script')?.state,
  )

  console.log('== private routes are closed without a session ==')
  for (const path of ['/api/me', '/api/projects', '/api/overview', '/api/integrations', '/api/activity']) {
    const response = await get(path)
    equal(`GET ${path} status`, 401, response.status)
    equal(`GET ${path} cache-control`, 'private, no-store', response.headers.get('cache-control') ?? '')
  }

  console.log('== Phase B routes are closed too ==')
  for (const path of ['/api/episodes/ep_unknown/scripts', '/api/scripts/scr_unknown']) {
    equal(`GET ${path} without session`, 401, (await get(path)).status)
  }
  // Only state-changing requests are CSRF-checked; a foreign Origin on a GET is
  // simply unauthenticated (checked above).
  const mutations = [
    '/api/episodes/ep_unknown/scripts',
    '/api/scripts/scr_unknown/approve',
    '/api/integrations/script/verify',
  ]
  for (const path of mutations) {
    const foreign = await get(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'https://evil.example' },
      body: '{}',
    })
    equal(`POST ${path} foreign Origin`, 403, foreign.status)
    const anon = await get(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: BASE },
      body: '{}',
    })
    equal(`POST ${path} without session`, 401, anon.status)
  }

  console.log('== auth configuration on this origin ==')
  const session = await get('/auth/freebuff/session')
  equal('GET /auth/freebuff/session status', 200, session.status)
  equal('session user is null', true, (await session.json()).user === null)

  const signin = await get('/auth/freebuff/signin?returnTo=%2Fprojects', { redirect: 'manual' })
  check('signin redirects', [302, 303, 307].includes(signin.status), String(signin.status))
  const url = new URL(signin.headers.get('location') ?? 'https://invalid.example')
  equal('signin issuer', 'https://freebuff.com', url.origin)
  equal('signin callback is this deployment origin', `${BASE}/auth/freebuff/callback`, url.searchParams.get('redirect_uri') ?? '')
  check('signin client id present', (url.searchParams.get('client_id') ?? '').length > 0)
  equal('signin uses PKCE S256', 'S256', url.searchParams.get('code_challenge_method') ?? '')

  const badCallback = await get('/auth/freebuff/callback', { redirect: 'manual' })
  check('callback without params is rejected', badCallback.status >= 400, String(badCallback.status))

  console.log('')
  console.log(`passed=${pass} failed=${fail}`)
  if (fail > 0) process.exitCode = 1
}

await main()
