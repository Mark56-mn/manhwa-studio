import { Hono } from 'hono'

import { AI_ROLES } from '../lib/constants'
import { badRequest } from '../lib/errors'
import { Input, readJson } from '../lib/input'
import { describeAdapters } from '../providers'
import { refreshCatalog, setModelCost } from '../ai/catalog'
import { probeCapabilities, providerStatuses, routerStatus, testProvider } from '../ai/service'
import { loadRoleSettings, saveRoleSettings } from '../ai/settings'

import type { FallbackEntry } from '../ai/settings'
import type { ModelCostPolicy } from '../providers/types'
import type { AiRole } from '../lib/constants'
import type { AppBindings } from '../app'

export const aiRoutes = new Hono<AppBindings>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseFallbacks(value: unknown): FallbackEntry[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw badRequest('fallbacks must be an array of { provider, model }')
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.provider !== 'string' || entry.provider.trim().length === 0) {
      throw badRequest('each fallback needs a provider')
    }
    return {
      provider: entry.provider.trim(),
      model: typeof entry.model === 'string' && entry.model.trim().length > 0 ? entry.model.trim() : null,
    }
  })
}

/** Provider catalog: configuration state, models, last real test. */
aiRoutes.get('/ai/providers', async (c) => {
  return c.json({
    providers: await providerStatuses(c.env.DB, c.env),
    adapters: describeAdapters(),
    secretsPolicy: {
      detail:
        'Provider keys are deployment secrets (environment variables). They are never sent to the browser, never logged, and never stored in the database.',
      envVarNamesOnly: true,
    },
    costPolicy: {
      detail:
        'Free-only by default. A model is eligible for automatic failover only when it is verified zero-cost, unless paid use is explicitly authorised for the role.',
    },
  })
})

/** A real, low-token request that proves the credential and model work. */
aiRoutes.post('/ai/providers/:provider/test', async (c) => {
  const provider = c.req.param('provider')
  const input = new Input(await readJson(c.req.raw))
  input.rejectUnknown(['model'])
  const model = input.optionalString('model', 200) ?? null
  input.assertClean()

  const result = await testProvider(c.env.DB, c.env, provider, model, c.get('user').sub)
  return c.json({ result, providers: await providerStatuses(c.env.DB, c.env) }, result.ok ? 200 : 502)
})

/** Reads the provider's own model list and caches it. */
aiRoutes.post('/ai/providers/:provider/models', async (c) => {
  const provider = c.req.param('provider')
  try {
    const models = await refreshCatalog(c.env.DB, c.env, provider, AbortSignal.timeout(30_000))
    return c.json({
      provider,
      models: models.map((entry) => ({
        id: entry.id,
        label: entry.label ?? null,
        contextLength: entry.contextLength,
        free: entry.free,
      })),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Model discovery failed.'
    return c.json({ provider, error: message, code: 'model_discovery_failed' }, 502)
  }
})

/** Probes structured output, streaming and tools with real requests. */
aiRoutes.post('/ai/providers/:provider/probe', async (c) => {
  const provider = c.req.param('provider')
  const input = new Input(await readJson(c.req.raw))
  input.rejectUnknown(['model'])
  const model = input.optionalString('model', 200)
  input.assertClean()
  if (!model) throw badRequest('model is required for a capability probe')

  const result = await probeCapabilities(c.env.DB, c.env, provider, model)
  return c.json({ result })
})

/** The owner's verified cost marking for a model. */
aiRoutes.post('/ai/models/cost', async (c) => {
  const input = new Input(await readJson(c.req.raw))
  input.rejectUnknown(['provider', 'model', 'free'])
  const provider = input.string('provider', 64)
  const model = input.string('model', 200)
  const free = input.enum('free', ['free', 'paid', 'unknown'] as const)
  input.assertClean()

  await setModelCost(c.env.DB, provider, model, (free ?? 'unknown') as ModelCostPolicy)
  return c.json({ provider, model, free: free ?? 'unknown' })
})

/** Director AI and Script AI defaults, independently configurable. */
aiRoutes.get('/ai/settings', async (c) => {
  const ownerId = c.get('user').sub
  const roles = await Promise.all(
    AI_ROLES.map(async (role) => {
      const settings = await loadRoleSettings(c.env.DB, ownerId, role)
      return {
        role,
        provider: settings?.provider ?? null,
        model: settings?.model ?? null,
        allowPaid: (settings?.allow_paid ?? 0) === 1,
        fallbacks: settings ? (JSON.parse(settings.fallback_json) as unknown) : [],
        updatedAt: settings?.updated_at ?? null,
      }
    }),
  )
  return c.json({ roles, providers: await providerStatuses(c.env.DB, c.env) })
})

aiRoutes.put('/ai/settings', async (c) => {
  const ownerId = c.get('user').sub
  const body = await readJson(c.req.raw)
  if (!isRecord(body)) throw badRequest('Request body must be a JSON object')
  const role = body.role
  if (typeof role !== 'string' || !AI_ROLES.includes(role as AiRole)) {
    throw badRequest(`role must be one of: ${AI_ROLES.join(', ')}`)
  }
  const provider = body.provider === null ? null : typeof body.provider === 'string' ? body.provider.trim() : undefined
  const model = body.model === null ? null : typeof body.model === 'string' ? body.model.trim() : undefined
  const fallbacks = parseFallbacks(body.fallbacks)
  const allowPaid = typeof body.allowPaid === 'boolean' ? body.allowPaid : undefined

  const saved = await saveRoleSettings(c.env.DB, ownerId, role as AiRole, {
    ...(provider !== undefined ? { provider: provider === '' ? null : provider } : {}),
    ...(model !== undefined ? { model: model === '' ? null : model } : {}),
    fallbacks,
    ...(allowPaid !== undefined ? { allowPaid } : {}),
  })

  return c.json({
    role: saved.role,
    provider: saved.provider,
    model: saved.model,
    allowPaid: saved.allow_paid === 1,
    fallbacks: JSON.parse(saved.fallback_json) as unknown,
    updatedAt: saved.updated_at,
  })
})

/** The router's own view: candidates, policy, last active model, failures. */
aiRoutes.get('/ai/router', async (c) => {
  return c.json(await routerStatus(c.env.DB, c.env, c.get('user').sub))
})

