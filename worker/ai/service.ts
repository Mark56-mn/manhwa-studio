import { HttpError } from '../lib/errors'
import { newId } from '../lib/ids'
import { nowIso } from '../lib/time'
import { AI_ROLES } from '../lib/constants'
import { AI_ADAPTERS, providerBaseUrl, providerKey, resolveProviderConfig } from '../providers'
import { isProviderError } from '../providers/types'
import { cachedModels, refreshCatalog, setModelCost } from './catalog'
import { AiRoutingError, describeCandidates } from './router'
import { loadRoleSettings } from './settings'
import { recentRouteEvents, setVerifiedCapabilities } from './state'

import type { DiscoveredModel, ProviderCapabilities } from '../providers/types'
import type { AiRole } from '../lib/constants'
import type { Env } from '../env'

/** Maps a router failure onto an honest HTTP error the studio can report. */
export function routingHttpError(error: unknown, fallbackProvider: string): HttpError {
  if (error instanceof AiRoutingError) {
    return new HttpError(error.status, error.message, error.code, {
      attempts: error.attempts,
      missingEnvVars: error.missingEnvVars.length > 0 ? error.missingEnvVars : undefined,
    })
  }
  if (isProviderError(error)) {
    const status = error.code === 'provider_timeout' ? 504 : error.code === 'provider_not_configured' ? 503 : 502
    return new HttpError(status, error.message, error.code, { provider: fallbackProvider })
  }
  return new HttpError(
    502,
    `The provider call failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    'provider_http_error',
    { provider: fallbackProvider },
  )
}

export interface ProviderCheckRecord {
  capability: string
  provider: string
  model: string | null
  status: 'ok' | 'failed'
  detail: string
  latencyMs: number
  models: string[]
  checkedBy: string | null
}

export async function recordProviderCheck(db: D1Database, record: ProviderCheckRecord): Promise<void> {
  await db
    .prepare(
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
      record.capability,
      record.provider,
      record.model,
      record.status,
      record.detail,
      record.latencyMs,
      JSON.stringify(record.models),
      record.checkedBy,
      nowIso(),
    )
    .run()
}

export interface ProviderTestResult {
  provider: string
  providerLabel: string
  model: string
  ok: boolean
  detail: string
  code: string | null
  latencyMs: number
  requestId: string | null
  models: string[]
  checkedAt: string
}

/**
 * A real, low-token request that proves the credential and the model work.
 * Nothing is marked "online" because a key exists: this call must succeed.
 */
export async function testProvider(
  db: D1Database,
  env: Env,
  providerId: string,
  model: string | null,
  checkedBy: string | null,
): Promise<ProviderTestResult> {
  const resolved = resolveProviderConfig(env, providerId, model)
  const label = resolved.adapter?.label ?? providerId
  const started = Date.now()

  if (!resolved.adapter || !resolved.config) {
    const result: ProviderTestResult = {
      provider: providerId,
      providerLabel: label,
      model: model ?? '',
      ok: false,
      detail: resolved.detail,
      code: 'provider_not_configured',
      latencyMs: Date.now() - started,
      requestId: null,
      models: [],
      checkedAt: nowIso(),
    }
    await recordProviderCheck(db, {
      capability: 'provider',
      provider: providerId,
      model: model ?? null,
      status: 'failed',
      detail: result.detail,
      latencyMs: result.latencyMs,
      models: [],
      checkedBy,
    })
    return result
  }

  const config = resolved.config
  const signal = AbortSignal.timeout(30_000)
  try {
    const completion = await resolved.adapter.chat(config, {
      model: config.model,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      maxOutputTokens: 16,
      temperature: 0,
      signal,
    })
    const models = await resolved.adapter.listModels(config, signal).catch((): DiscoveredModel[] => [])
    const result: ProviderTestResult = {
      provider: providerId,
      providerLabel: label,
      model: completion.model || config.model,
      ok: true,
      detail: `Real low-token call to ${label} succeeded for model ${completion.model || config.model}.`,
      code: null,
      latencyMs: Date.now() - started,
      requestId: completion.requestId,
      models: models.map((entry) => entry.id),
      checkedAt: nowIso(),
    }
    await recordProviderCheck(db, {
      capability: 'provider',
      provider: providerId,
      model: config.model,
      status: 'ok',
      detail: result.detail,
      latencyMs: result.latencyMs,
      models: result.models,
      checkedBy,
    })
    return result
  } catch (error) {
    const code = isProviderError(error) ? error.code : 'provider_http_error'
    const detail = isProviderError(error)
      ? error.message
      : error instanceof Error
        ? error.message
        : 'The provider test failed for an unknown reason.'
    const result: ProviderTestResult = {
      provider: providerId,
      providerLabel: label,
      model: config.model,
      ok: false,
      detail,
      code,
      latencyMs: Date.now() - started,
      requestId: null,
      models: [],
      checkedAt: nowIso(),
    }
    await recordProviderCheck(db, {
      capability: 'provider',
      provider: providerId,
      model: config.model,
      status: 'failed',
      detail,
      latencyMs: result.latencyMs,
      models: [],
      checkedBy,
    })
    return result
  }
}


export interface CapabilityProbeResult {
  provider: string
  model: string
  structuredOutput: boolean
  streaming: boolean
  tools: boolean
  detail: string
  checks: Array<{ name: string; ok: boolean; detail: string }>
}

/**
 * Probes a model with real, minimal requests and records only what actually
 * worked. Tool calling in particular is never claimed without this probe.
 */
export async function probeCapabilities(
  db: D1Database,
  env: Env,
  providerId: string,
  model: string,
): Promise<CapabilityProbeResult> {
  const resolved = resolveProviderConfig(env, providerId, model)
  if (!resolved.adapter || !resolved.config) {
    throw new HttpError(400, resolved.detail, 'provider_not_configured')
  }
  const adapter = resolved.adapter
  const config = resolved.config
  const checks: CapabilityProbeResult['checks'] = []
  let structuredOutput = false
  let streaming = false
  let tools = false

  if (adapter.capabilities.structuredOutput !== 'none') {
    try {
      const result = await adapter.chat(config, {
        model: config.model,
        messages: [{ role: 'user', content: 'Return a JSON object with a single key "ok" set to true.' }],
        maxOutputTokens: 64,
        temperature: 0,
        responseFormat: { type: 'json_object' },
        signal: AbortSignal.timeout(30_000),
      })
      const text = result.text.trim().replace(/^```[a-zA-Z]*\s*|\s*```$/g, '')
      JSON.parse(text)
      structuredOutput = true
      checks.push({ name: 'structured_output', ok: true, detail: 'A real JSON-mode request returned parseable JSON.' })
    } catch (error) {
      checks.push({
        name: 'structured_output',
        ok: false,
        detail: error instanceof Error ? error.message : 'failed',
      })
    }
  } else {
    checks.push({ name: 'structured_output', ok: false, detail: 'declared unsupported by the provider' })
  }

  if (adapter.capabilities.streaming) {
    try {
      const chunks = adapter.chatStream(config, {
        model: config.model,
        messages: [{ role: 'user', content: 'Count from 1 to 3.' }],
        maxOutputTokens: 32,
        temperature: 0,
        stream: true,
        signal: AbortSignal.timeout(30_000),
      })
      let received = 0
      for await (const chunk of chunks) {
        if (chunk.delta.length > 0) received += 1
        if (received >= 1 || chunk.done) break
      }
      streaming = received >= 1
      checks.push({
        name: 'streaming',
        ok: streaming,
        detail: streaming ? 'Received streamed deltas from a real call.' : 'The stream produced no deltas.',
      })
    } catch (error) {
      checks.push({ name: 'streaming', ok: false, detail: error instanceof Error ? error.message : 'failed' })
    }
  } else {
    checks.push({ name: 'streaming', ok: false, detail: 'declared unsupported by the provider' })
  }

  if (adapter.capabilities.tools) {
    try {
      const result = await adapter.chat(config, {
        model: config.model,
        messages: [{ role: 'user', content: 'Call the tool to report the current time.' }],
        maxOutputTokens: 128,
        temperature: 0,
        tools: [
          {
            name: 'report_time',
            description: 'Report the current time.',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        ],
        toolChoice: 'auto',
        signal: AbortSignal.timeout(30_000),
      })
      tools = result.toolCalls.length > 0
      checks.push({
        name: 'tools',
        ok: tools,
        detail: tools ? 'The model returned a tool call for a real request.' : 'The model did not return a tool call.',
      })
    } catch (error) {
      checks.push({ name: 'tools', ok: false, detail: error instanceof Error ? error.message : 'failed' })
    }
  } else {
    checks.push({ name: 'tools', ok: false, detail: 'declared unsupported by the provider' })
  }

  await setVerifiedCapabilities(db, providerId, config.model, { structuredOutput, streaming, tools })
  return {
    provider: providerId,
    model: config.model,
    structuredOutput,
    streaming,
    tools,
    detail: `Probed ${adapter.label} · ${config.model}: structured=${structuredOutput}, streaming=${streaming}, tools=${tools}.`,
    checks,
  }
}


type IntegrationStateName = 'connected_verified' | 'configured_unverified' | 'failed' | 'not_configured'

export interface ProviderModelInfo {
  id: string
  free: string
  contextLength: number | null
}

export interface ProviderStatus {
  id: string
  label: string
  docsUrl: string
  implemented: true
  baseUrl: string | null
  keyEnvVars: string[]
  baseUrlEnvVars: string[]
  configured: boolean
  state: IntegrationStateName
  detail: string
  capabilities: ProviderCapabilities
  defaultModel: string
  models: ProviderModelInfo[]
  lastTestAt: string | null
  lastTest: { status: string; detail: string; latencyMs: number | null; model: string | null } | null
}

interface ProviderCheckRowLike {
  status: 'ok' | 'failed'
  detail: string
  latency_ms: number | null
  model: string | null
  checked_at: string
}

/** Per-provider configuration and connection-test status for the Settings UI. */
export async function providerStatuses(db: D1Database, env: Env): Promise<ProviderStatus[]> {
  const statuses: ProviderStatus[] = []
  for (const adapter of AI_ADAPTERS) {
    const key = providerKey(env, adapter)
    const baseUrl = providerBaseUrl(env, adapter)
    const configured = key !== null && (!adapter.needsBaseUrl || baseUrl !== null)
    const check = await db
      .prepare("SELECT * FROM provider_checks WHERE capability = 'provider' AND provider = ?")
      .bind(adapter.id)
      .first<ProviderCheckRowLike>()
    const models = await cachedModels(db, adapter.id)

    let state: IntegrationStateName = 'not_configured'
    let detail = `Not configured. Set ${adapter.keyEnvVars.join(' or ')}${
      adapter.needsBaseUrl && adapter.baseUrlEnvVars.length > 0 ? ` and ${adapter.baseUrlEnvVars.join(' or ')}` : ''
    } as deployment secrets.`
    if (check) {
      state = check.status === 'ok' ? 'connected_verified' : 'failed'
      detail = check.detail
    } else if (configured) {
      state = 'configured_unverified'
      detail = `Configured with ${baseUrl ?? 'the default endpoint'}. Not verified yet — run Test connection to make a real low-token request.`
    }

    statuses.push({
      id: adapter.id,
      label: adapter.label,
      docsUrl: adapter.docsUrl,
      implemented: true,
      baseUrl,
      keyEnvVars: adapter.keyEnvVars,
      baseUrlEnvVars: adapter.baseUrlEnvVars,
      configured,
      state,
      detail,
      capabilities: adapter.capabilities,
      defaultModel: adapter.defaultModel,
      models: models.map((model) => ({ id: model.model, free: model.free, contextLength: model.contextLength })),
      lastTestAt: check?.checked_at ?? null,
      lastTest: check
        ? { status: check.status, detail: check.detail, latencyMs: check.latency_ms, model: check.model }
        : null,
    })
  }
  return statuses
}

export { refreshCatalog, setModelCost }

export interface RouterStatusRole {
  role: AiRole
  provider: string | null
  model: string | null
  allowPaid: boolean
  candidates: Array<{ provider: string; model: string; source: string }>
  detail: string
  missing: string[]
}

export interface RouterStatus {
  roles: RouterStatusRole[]
  lastActive: { provider: string; model: string | null; task: string; at: string } | null
  recentFailures: Array<{ provider: string; model: string | null; task: string; errorCode: string | null; detail: string; at: string }>
  cooldowns: Array<{ provider: string; model: string; until: string; reason: string | null }>
}


/** The router's own view: candidates, policy, last active model, failures. */
export async function routerStatus(db: D1Database, env: Env, ownerId: string): Promise<RouterStatus> {
  const roles: RouterStatusRole[] = []
  for (const role of AI_ROLES) {
    const settings = await loadRoleSettings(db, ownerId, role)
    const resolution = await describeCandidates(db, env, ownerId, role)
    roles.push({
      role,
      provider: settings?.provider ?? null,
      model: settings?.model ?? null,
      allowPaid: (settings?.allow_paid ?? 0) === 1,
      candidates: resolution.candidates,
      detail: resolution.detail,
      missing: resolution.missing,
    })
  }

  const events = await recentRouteEvents(db, 20)
  const okEvent = events.find((event) => event.outcome === 'ok')
  const recentFailures = events
    .filter((event) => event.outcome === 'failed' || event.outcome === 'blocked')
    .slice(0, 8)
    .map((event) => ({
      provider: event.provider,
      model: event.model,
      task: event.task,
      errorCode: event.error_code,
      detail: event.detail,
      at: event.created_at,
    }))

  const cooling = await db
    .prepare(
      'SELECT provider, model, cooldown_until, last_error_code FROM ai_provider_state WHERE cooldown_until IS NOT NULL AND cooldown_until > ? ORDER BY cooldown_until',
    )
    .bind(nowIso())
    .all<{ provider: string; model: string; cooldown_until: string; last_error_code: string | null }>()

  return {
    roles,
    lastActive: okEvent
      ? { provider: okEvent.provider, model: okEvent.model, task: okEvent.task, at: okEvent.created_at }
      : null,
    recentFailures,
    cooldowns: (cooling.results ?? []).map((row) => ({
      provider: row.provider,
      model: row.model,
      until: row.cooldown_until,
      reason: row.last_error_code,
    })),
  }
}

