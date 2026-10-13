import {
  AI_ADAPTERS,
  DIRECTOR_ENV_VARS,
  SCRIPT_ENV_VARS,
  findAdapter,
  providerBaseUrl,
  providerKey,
  readEnvValue,
  resolveScriptConfig,
} from '../providers'
import { nowIso } from '../lib/time'
import { pickDefaultModel } from './catalog'

import type { AiRole } from '../lib/constants'
import type { Env } from '../env'
import type { ResolvedCandidate } from './types'

/** Per-owner, per-role preference: preferred provider/model, fallbacks, policy. */
export interface AiSettingsRow {
  owner_id: string
  role: AiRole
  provider: string | null
  model: string | null
  fallback_json: string
  allow_paid: number
  updated_at: string
}

export interface FallbackEntry {
  provider: string
  model: string | null
}

export function parseFallbacks(json: string): FallbackEntry[] {
  try {
    const parsed = JSON.parse(json) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((entry) => {
        const record = entry as { provider?: unknown; model?: unknown }
        return {
          provider: typeof record.provider === 'string' ? record.provider : '',
          model: typeof record.model === 'string' ? record.model : null,
        }
      })
      .filter((entry) => entry.provider.trim().length > 0)
  } catch {
    return []
  }
}

export async function loadRoleSettings(db: D1Database, ownerId: string, role: AiRole): Promise<AiSettingsRow | null> {
  const row = await db
    .prepare('SELECT * FROM ai_settings WHERE owner_id = ? AND role = ?')
    .bind(ownerId, role)
    .first<AiSettingsRow>()
  return row ?? null
}

export async function saveRoleSettings(
  db: D1Database,
  ownerId: string,
  role: AiRole,
  patch: { provider?: string | null; model?: string | null; fallbacks?: FallbackEntry[]; allowPaid?: boolean },
): Promise<AiSettingsRow> {
  const existing = await loadRoleSettings(db, ownerId, role)
  const provider = patch.provider !== undefined ? patch.provider : (existing?.provider ?? null)
  const model = patch.model !== undefined ? patch.model : (existing?.model ?? null)
  const fallbackJson =
    patch.fallbacks !== undefined ? JSON.stringify(patch.fallbacks) : (existing?.fallback_json ?? '[]')
  const allowPaid = patch.allowPaid !== undefined ? (patch.allowPaid ? 1 : 0) : (existing?.allow_paid ?? 0)
  const now = nowIso()

  await db
    .prepare(
      `INSERT INTO ai_settings (owner_id, role, provider, model, fallback_json, allow_paid, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner_id, role) DO UPDATE SET
         provider = excluded.provider,
         model = excluded.model,
         fallback_json = excluded.fallback_json,
         allow_paid = excluded.allow_paid,
         updated_at = excluded.updated_at`,
    )
    .bind(ownerId, role, provider, model, fallbackJson, allowPaid, now)
    .run()

  return {
    owner_id: ownerId,
    role,
    provider,
    model,
    fallback_json: fallbackJson,
    allow_paid: allowPaid,
    updated_at: now,
  }
}

export interface CandidateResolution {
  candidates: ResolvedCandidate[]
  missing: string[]
  detail: string
}

function isProviderKeyed(env: Env, adapterId: string): boolean {
  const adapter = findAdapter(adapterId)
  if (!adapter) return false
  if (providerKey(env, adapter) === null) return false
  if (adapter.needsBaseUrl && !providerBaseUrl(env, adapter)) return false
  return true
}

/**
 * The ordered candidate list for a role: the owner's preference first, then the
 * configured fallback order, then any other provider this deployment can reach.
 * A model is filled from discovery when it was not named.
 */
export async function resolveCandidates(
  db: D1Database,
  env: Env,
  ownerId: string,
  role: AiRole,
): Promise<CandidateResolution> {
  const settings = await loadRoleSettings(db, ownerId, role)
  const raw: Array<{ provider: string; model: string; source: ResolvedCandidate['source']; extra: string[] }> = []
  const seen = new Set<string>()
  const push = (provider: string, model: string, source: ResolvedCandidate['source'], extra: string[] = []) => {
    const id = provider.trim().toLowerCase()
    if (!id) return
    const key = `${id}::${model.trim()}`
    if (seen.has(key)) return
    seen.add(key)
    raw.push({ provider: id, model: model.trim(), source, extra })
  }

  if (settings?.provider) {
    push(settings.provider, settings.model ?? '', 'preferred')
    for (const fallback of parseFallbacks(settings.fallback_json)) {
      push(fallback.provider, fallback.model ?? '', 'fallback')
    }
  }

  // Environment role default: explicit configuration by the owner.
  if (role === 'script') {
    const selected = readEnvValue(env, 'SCRIPT_PROVIDER')
    if (selected) {
      push(selected, readEnvValue(env, 'SCRIPT_MODEL') ?? '', raw.length > 0 ? 'fallback' : 'preferred', [
        'SCRIPT_API_KEY',
      ])
    }
  } else {
    const selected = readEnvValue(env, 'DIRECTOR_PROVIDER')
    if (selected) {
      push(selected, readEnvValue(env, 'DIRECTOR_MODEL') ?? '', raw.length > 0 ? 'fallback' : 'preferred')
    }
  }

  // Nothing configured: offer every provider this deployment actually has a key for.
  if (raw.length === 0) {
    for (const adapter of AI_ADAPTERS) {
      if (isProviderKeyed(env, adapter.id)) push(adapter.id, adapter.defaultModel, 'default')
    }
  }

  const candidates: ResolvedCandidate[] = []
  const configuredWithoutModel: string[] = []
  for (const entry of raw) {
    const adapter = findAdapter(entry.provider)
    let model = entry.model || adapter?.defaultModel || ''
    if (!model) model = (await pickDefaultModel(db, entry.provider)) ?? ''
    if (!model) {
      configuredWithoutModel.push(adapter?.label ?? entry.provider)
      continue
    }
    candidates.push({ provider: entry.provider, model, source: entry.source, extraKeyEnvVars: entry.extra })
  }

  if (candidates.length === 0) {
    const missing = role === 'script' ? [...SCRIPT_ENV_VARS] : [...DIRECTOR_ENV_VARS]
    const detail =
      configuredWithoutModel.length > 0
        ? `${configuredWithoutModel.join(', ')} is configured, but no model is selected or discovered yet. Open Settings → AI providers, discover models, and choose one.`
        : role === 'script'
          ? resolveScriptConfig(env).detail
          : 'No Director AI provider is configured. Set DIRECTOR_PROVIDER and its API key, or choose one in Settings → AI providers.'
    return { candidates: [], missing, detail }
  }

  return { candidates, missing: [], detail: `${candidates.length} candidate model(s) available for ${role}.` }
}

