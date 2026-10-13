import { Hono } from 'hono'

import { capabilityStatuses } from '../capabilities'
import { newId } from '../lib/ids'
import { nowIso } from '../lib/time'
import { runScriptProviderCheck } from '../providers'

import type { AppBindings } from '../app'

export const integrationRoutes = new Hono<AppBindings>()

integrationRoutes.get('/integrations', async (c) => {
  return c.json({
    // Every state below is derived from the deployment's real configuration and
    // from recorded results of real calls, never from a hard-coded flag.
    capabilities: await capabilityStatuses(c.env.DB, c.env),
    secretsPolicy: {
      detail:
        'Provider keys are stored as deployment secrets (Sites → Secrets or Worker environment bindings) and are never sent to the browser.',
      envVarNamesOnly: true,
    },
    verification: {
      detail:
        'A capability turns "connected_verified" only after POST /api/integrations/:capability/verify makes a real authenticated call to the provider and records the result.',
    },
  })
})

/**
 * Runs a genuine authenticated call against the configured provider and records
 * the outcome. This is what moves a capability between `configured_unverified`,
 * `connected_verified` and `failed`.
 */
integrationRoutes.post('/integrations/:capability/verify', async (c) => {
  const capability = c.req.param('capability')
  if (capability !== 'script') {
    return c.json(
      {
        error: `This build has no adapter for the "${capability}" capability yet, so there is nothing to verify.`,
        code: 'capability_not_implemented',
        implemented: false,
      },
      400,
    )
  }

  const outcome = await runScriptProviderCheck(c.env)
  const ownerId = c.get('user').sub

  await c.env.DB.prepare(
    `INSERT INTO provider_checks
       (id, capability, provider, model, status, detail, latency_ms, models_json, checked_by, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (capability, provider) DO UPDATE SET
       model = excluded.model,
       status = excluded.status,
       detail = excluded.detail,
       latency_ms = excluded.latency_ms,
       models_json = excluded.models_json,
       checked_by = excluded.checked_by,
       checked_at = excluded.checked_at`,
  )
    .bind(
      newId('chk'),
      outcome.capability,
      outcome.provider,
      outcome.model,
      outcome.ok ? 'ok' : 'failed',
      outcome.detail,
      outcome.latencyMs,
      JSON.stringify(outcome.models),
      ownerId,
      nowIso(),
    )
    .run()

  const status = outcome.ok ? 200 : outcome.code === 'provider_not_configured' ? 400 : 502

  return c.json(
    {
      result: outcome,
      capabilities: await capabilityStatuses(c.env.DB, c.env),
    },
    status as 200,
  )
})
