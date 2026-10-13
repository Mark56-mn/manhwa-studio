import { newId } from '../lib/ids'
import { nowIso } from '../lib/time'

import type { AiRole, AiTask } from '../lib/constants'

/**
 * Provider/model health: a small circuit breaker plus the routing log.
 * An entire provider is never marked offline because one model failed.
 */

/** Capabilities a real probe actually confirmed (booleans, never claims). */
export interface VerifiedCapabilities {
  structuredOutput?: boolean
  streaming?: boolean
  tools?: boolean
  vision?: boolean
}

export interface ProviderStateRow {
  provider: string
  model: string
  status: 'unknown' | 'ok' | 'failed' | 'cooldown'
  capabilities_json: string
  consecutive_failures: number
  cooldown_until: string | null
  last_ok_at: string | null
  last_error_code: string | null
  last_error_detail: string | null
  latency_ms: number | null
  updated_at: string
}

/** How long to pause a model after a failure, by error kind. */
export function cooldownMsFor(code: string | null): number {
  switch (code) {
    case 'provider_quota_exhausted':
      return 3_600_000
    case 'provider_rate_limited':
      return 60_000
    case 'provider_outage':
      return 30_000
    case 'provider_timeout':
      return 15_000
    default:
      return 15_000
  }
}

export async function loadProviderState(
  db: D1Database,
  provider: string,
  model: string,
): Promise<ProviderStateRow | null> {
  const row = await db
    .prepare('SELECT * FROM ai_provider_state WHERE provider = ? AND model = ?')
    .bind(provider, model)
    .first<ProviderStateRow>()
  return row ?? null
}

export function cooldownRemainingMs(state: ProviderStateRow | null, now: number): number {
  if (!state?.cooldown_until) return 0
  const until = Date.parse(state.cooldown_until)
  if (!Number.isFinite(until)) return 0
  return Math.max(until - now, 0)
}

export function verifiedCapabilities(state: ProviderStateRow | null): VerifiedCapabilities {
  if (!state) return {}
  try {
    const parsed = JSON.parse(state.capabilities_json) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as VerifiedCapabilities) : {}
  } catch {
    return {}
  }
}

export async function recordSuccess(
  db: D1Database,
  provider: string,
  model: string,
  latencyMs: number,
): Promise<void> {
  const now = nowIso()
  await db
    .prepare(
      `INSERT INTO ai_provider_state
         (provider, model, status, capabilities_json, consecutive_failures, cooldown_until, last_ok_at, latency_ms, updated_at)
       VALUES (?, ?, 'ok', '{}', 0, NULL, ?, ?, ?)
       ON CONFLICT (provider, model) DO UPDATE SET
         status = 'ok',
         consecutive_failures = 0,
         cooldown_until = NULL,
         last_ok_at = excluded.last_ok_at,
         latency_ms = excluded.latency_ms,
         updated_at = excluded.updated_at`,
    )
    .bind(provider, model, now, latencyMs, now)
    .run()
}

export async function recordFailure(
  db: D1Database,
  provider: string,
  model: string,
  code: string | null,
  detail: string,
  latencyMs: number,
): Promise<void> {
  const now = new Date()
  const cooldownUntil = new Date(now.getTime() + cooldownMsFor(code)).toISOString()
  await db
    .prepare(
      `INSERT INTO ai_provider_state
         (provider, model, status, capabilities_json, consecutive_failures, cooldown_until, last_error_code, last_error_detail, latency_ms, updated_at)
       VALUES (?, ?, 'cooldown', '{}', 1, ?, ?, ?, ?, ?)
       ON CONFLICT (provider, model) DO UPDATE SET
         status = 'cooldown',
         consecutive_failures = ai_provider_state.consecutive_failures + 1,
         cooldown_until = excluded.cooldown_until,
         last_error_code = excluded.last_error_code,
         last_error_detail = excluded.last_error_detail,
         latency_ms = excluded.latency_ms,
         updated_at = excluded.updated_at`,
    )
    .bind(provider, model, cooldownUntil, code, detail.slice(0, 500), latencyMs, now.toISOString())
    .run()
}

/** Records capabilities that a real probe actually confirmed. */
export async function setVerifiedCapabilities(
  db: D1Database,
  provider: string,
  model: string,
  capabilities: VerifiedCapabilities,
): Promise<void> {
  const now = nowIso()
  await db
    .prepare(
      `INSERT INTO ai_provider_state
         (provider, model, status, capabilities_json, consecutive_failures, updated_at)
       VALUES (?, ?, 'ok', ?, 0, ?)
       ON CONFLICT (provider, model) DO UPDATE SET
         capabilities_json = excluded.capabilities_json,
         updated_at = excluded.updated_at`,
    )
    .bind(provider, model, JSON.stringify(capabilities), now)
    .run()
}

export interface RouteEventInput {
  ownerId: string | null
  role: AiRole
  task: AiTask
  taskId?: string | null
  attempt: number
  provider: string
  model: string | null
  outcome: 'ok' | 'failed' | 'skipped' | 'blocked'
  errorCode?: string | null
  latencyMs?: number | null
  detail?: string
}

export async function logRouteEvent(db: D1Database, event: RouteEventInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ai_route_events
         (id, owner_id, role, task, task_id, attempt, provider, model, outcome, error_code, latency_ms, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId('rte'),
      event.ownerId,
      event.role,
      event.task,
      event.taskId ?? null,
      event.attempt,
      event.provider,
      event.model,
      event.outcome,
      event.errorCode ?? null,
      event.latencyMs ?? null,
      (event.detail ?? '').slice(0, 500),
      nowIso(),
    )
    .run()
}

export interface RouteEventRow {
  id: string
  owner_id: string | null
  role: string
  task: string
  task_id: string | null
  attempt: number
  provider: string
  model: string | null
  outcome: 'ok' | 'failed' | 'skipped' | 'blocked'
  error_code: string | null
  latency_ms: number | null
  detail: string
  created_at: string
}

export async function recentRouteEvents(db: D1Database, limit = 20): Promise<RouteEventRow[]> {
  const result = await db
    .prepare('SELECT * FROM ai_route_events ORDER BY created_at DESC LIMIT ?')
    .bind(limit)
    .all<RouteEventRow>()
  return result.results ?? []
}

