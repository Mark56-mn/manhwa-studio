import { EPISODE_STATUSES, PROJECT_STATUSES } from './lib/constants'
import { serializeProviderCheck } from './lib/rows'
import { verifyR2Binding } from './lib/assetService'
import { SCRIPT_ENV_VARS, describeAdapters, readEnvValue, resolveScriptConfig } from './providers'

import type { ProviderCheckRow } from './lib/rows'
import type { Env } from './env'

export type IntegrationState =
  | 'connected_verified'
  | 'configured_unverified'
  | 'unavailable'
  | 'not_configured'
  | 'failed'

export interface CapabilityProvider {
  id: string
  label: string
  docsUrl: string
  keyEnvVars: string[]
  defaultModel: string
  needsBaseUrl: boolean
  selected: boolean
}

export interface CapabilityStatus {
  id: string
  label: string
  phase: 'B' | 'C' | 'D'
  state: IntegrationState
  detail: string
  /** Environment variable NAMES the adapter reads. Values are never returned. */
  requiredEnvVars: string[]
  /** Which of those names are currently set on this deployment. */
  presentEnvVars: string[]
  /** True only when this build actually contains an adapter for the capability. */
  implemented: boolean
  providers?: CapabilityProvider[]
  model?: string | null
  models?: string[]
  verifiedAt?: string | null
}

interface CapabilityDefinition {
  id: string
  label: string
  phase: 'B' | 'C' | 'D'
  envVars: string[]
  planned: string
  implemented: boolean
}

/** Aliases a provider key may arrive under, without ever being echoed back. */
const SCRIPT_KEY_ALIASES = [
  'SCRIPT_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
]

const CAPABILITIES: CapabilityDefinition[] = [
  {
    id: 'script',
    label: 'Script AI',
    phase: 'B',
    envVars: [...SCRIPT_ENV_VARS],
    planned: 'LLM script generation',
    implemented: true,
  },
  {
    id: 'image',
    label: 'Image AI',
    phase: 'B',
    envVars: ['IMAGE_PROVIDER', 'IMAGE_API_KEY', 'IMAGE_MODEL'],
    planned: 'Scene and character art generation',
    implemented: false,
  },
  {
    id: 'voice',
    label: 'Voice AI',
    phase: 'B',
    envVars: ['VOICE_PROVIDER', 'VOICE_API_KEY', 'VOICE_VOICE_ID'],
    planned: 'Narration and dialogue audio',
    implemented: false,
  },
  {
    id: 'video',
    label: 'Video renderer',
    phase: 'C',
    envVars: ['RENDER_WORKER_URL', 'RENDER_WORKER_TOKEN'],
    planned: 'FFmpeg assembly of scenes, narration and captions',
    implemented: false,
  },
  {
    id: 'youtube',
    label: 'YouTube publishing',
    phase: 'D',
    envVars: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN'],
    planned: 'Private/unlisted uploads, public only with owner approval',
    implemented: false,
  },
]

function presentNames(env: Env, names: string[]): string[] {
  return names.filter((name) => readEnvValue(env, name) !== null)
}

async function lastCheck(db: D1Database, capability: string, provider: string): Promise<ProviderCheckRow | null> {
  const row = await db
    .prepare('SELECT * FROM provider_checks WHERE capability = ? AND provider = ?')
    .bind(capability, provider)
    .first<ProviderCheckRow>()
  return row ?? null
}

async function lastR2Check(db: D1Database): Promise<ProviderCheckRow | null> {
  const row = await db
    .prepare('SELECT * FROM provider_checks WHERE capability = ? AND provider = ?')
    .bind('media-storage', 'r2')
    .first<ProviderCheckRow>()
  return row ?? null
}

function providersFor(selected: string | null): CapabilityProvider[] {
  return describeAdapters().map((adapter) => ({ ...adapter, selected: adapter.id === selected }))
}

/**
 * Performs a real write/read/delete cycle on the R2 bucket to verify it is
 * accessible. Records the result in provider_checks.
 */
export async function verifyAndRecordR2(db: D1Database, env: Env, checkedBy: string): Promise<void> {
  const outcome = await verifyR2Binding(env)
  await db.prepare(
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
      `chk_${crypto.randomUUID()}`,
      outcome.capability,
      outcome.provider,
      null,
      outcome.ok ? 'ok' : 'failed',
      outcome.detail,
      outcome.latencyMs,
      '[]',
      checkedBy,
      new Date().toISOString(),
    )
    .run()
}

/**
 * The Script AI capability is the only one with a real adapter in this build,
 * so it is the only one whose state can reach `connected_verified` — and only
 * after a genuine authenticated call was recorded in `provider_checks`.
 */
async function scriptStatus(db: D1Database, env: Env): Promise<CapabilityStatus> {
  const selected = readEnvValue(env, 'SCRIPT_PROVIDER')
  const resolved = resolveScriptConfig(env)
  const base = {
    id: 'script',
    label: 'Script AI',
    phase: 'B' as const,
    implemented: true,
    providers: providersFor(selected?.toLowerCase() ?? null),
  }

  if (!resolved.adapter) {
    if (selected) {
      return {
        ...base,
        state: 'failed',
        detail: resolved.detail,
        requiredEnvVars: [...SCRIPT_ENV_VARS],
        presentEnvVars: presentNames(env, [...SCRIPT_ENV_VARS, 'SCRIPT_BASE_URL', ...SCRIPT_KEY_ALIASES]),
      }
    }
    return {
      ...base,
      state: 'not_configured',
      detail:
        'No script provider is connected. Choose one of the supported providers and set SCRIPT_PROVIDER, its API key and SCRIPT_MODEL as deployment secrets.',
      requiredEnvVars: [...SCRIPT_ENV_VARS],
      presentEnvVars: presentNames(env, [...SCRIPT_ENV_VARS, 'SCRIPT_BASE_URL', ...SCRIPT_KEY_ALIASES]),
    }
  }

  const required = resolved.missing.length > 0 ? resolved.missing.flatMap((entry) => entry.split(' or ')) : []
  const presentEnvVars = presentNames(env, [...SCRIPT_ENV_VARS, 'SCRIPT_BASE_URL', ...SCRIPT_KEY_ALIASES])

  if (!resolved.configured || !resolved.config) {
    return {
      ...base,
      state: 'not_configured',
      detail: resolved.detail,
      requiredEnvVars: required.length > 0 ? required : resolved.adapter.keyEnvVars,
      presentEnvVars,
      model: readEnvValue(env, 'SCRIPT_MODEL') ?? resolved.adapter.defaultModel,
    }
  }

  const check = await lastCheck(db, 'script', resolved.adapter.id)
  if (check) {
    const serialized = serializeProviderCheck(check)
    return {
      ...base,
      state: check.status === 'ok' ? 'connected_verified' : 'failed',
      detail: serialized.detail,
      requiredEnvVars: resolved.adapter.keyEnvVars,
      presentEnvVars,
      model: serialized.model,
      models: serialized.models,
      verifiedAt: serialized.checkedAt,
    }
  }

  return {
    ...base,
    state: 'configured_unverified',
    detail: `${resolved.detail} — not verified yet. No successful call to this provider has been made from this deployment.`,
    requiredEnvVars: resolved.adapter.keyEnvVars,
    presentEnvVars,
    model: resolved.config.model,
    models: [],
    verifiedAt: null,
  }
}

function plannedStatus(definition: CapabilityDefinition, env: Env): CapabilityStatus {
  const present = presentNames(env, definition.envVars)
  if (present.length === 0) {
    return {
      id: definition.id,
      label: definition.label,
      phase: definition.phase,
      state: 'not_configured',
      detail: `${definition.planned} is not configured, and this build has no adapter for it yet.`,
      requiredEnvVars: definition.envVars,
      presentEnvVars: [],
      implemented: false,
    }
  }
  return {
    id: definition.id,
    label: definition.label,
    phase: definition.phase,
    state: 'unavailable',
    detail:
      'Variables are set on this deployment, but this build has no adapter for this capability yet, so nothing is using them.',
    requiredEnvVars: definition.envVars,
    presentEnvVars: present,
    implemented: false,
  }
}

async function r2Status(db: D1Database, env: Env): Promise<CapabilityStatus> {
  const bucket = (env as unknown as { FILES?: { get?: unknown; put?: unknown } }).FILES
  const attached = Boolean(bucket) && typeof bucket?.put === 'function'

  if (!attached) {
    return {
      id: 'media-storage',
      label: 'Media storage (R2)',
      phase: 'B',
      state: 'not_configured',
      detail:
        'No object-storage bucket is attached to this deployment yet. Generated images, audio and video need one (TASK-003).',
      requiredEnvVars: [],
      presentEnvVars: [],
      implemented: true,
    }
  }

  const check = await lastR2Check(db)
  if (check) {
    const serialized = serializeProviderCheck(check)
    return {
      id: 'media-storage',
      label: 'Media storage (R2)',
      phase: 'B',
      state: check.status === 'ok' ? 'connected_verified' : 'failed',
      detail: serialized.detail,
      requiredEnvVars: [],
      presentEnvVars: [],
      implemented: true,
      verifiedAt: serialized.checkedAt,
    }
  }

  return {
    id: 'media-storage',
    label: 'Media storage (R2)',
    phase: 'B',
    state: 'configured_unverified',
    detail:
      'An object-storage bucket is attached to this deployment. A real read/write cycle has not been performed yet.',
    requiredEnvVars: [],
    presentEnvVars: [],
    implemented: true,
    verifiedAt: null,
  }
}

export function mediaStorageStatus(env: Env): CapabilityStatus {
  const bucket = (env as unknown as { FILES?: { get?: unknown; put?: unknown } }).FILES
  const attached = Boolean(bucket) && typeof bucket?.put === 'function'
  if (!attached) {
    return {
      id: 'media-storage',
      label: 'Media storage (R2)',
      phase: 'B',
      state: 'not_configured',
      detail:
        'No object-storage bucket is attached to this deployment yet. Generated images, audio and video need one (TASK-003).',
      requiredEnvVars: [],
      presentEnvVars: [],
      implemented: false,
    }
  }
  return {
    id: 'media-storage',
    label: 'Media storage (R2)',
    phase: 'B',
    state: 'configured_unverified',
    detail:
      'An object-storage bucket is attached to this deployment. Read and write are exercised by the first real asset in TASK-003.',
    requiredEnvVars: [],
    presentEnvVars: [],
    implemented: false,
  }
}

/**
 * Honest integration reporting, derived from real configuration and from the
 * results of real calls that were recorded in `provider_checks`.
 */
export async function capabilityStatuses(db: D1Database, env: Env): Promise<CapabilityStatus[]> {
  const statuses: CapabilityStatus[] = []
  for (const definition of CAPABILITIES) {
    if (definition.id === 'script') {
      statuses.push(await scriptStatus(db, env))
      continue
    }
    statuses.push(plannedStatus(definition, env))
  }
  statuses.push(await r2Status(db, env))
  return statuses
}

export const CATALOG = { PROJECT_STATUSES, EPISODE_STATUSES }
