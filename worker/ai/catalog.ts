import { ProviderError } from '../providers/types'
import { findAdapter, resolveProviderConfig } from '../providers'
import { nowIso } from '../lib/time'

import type { DiscoveredModel, ModelCostPolicy, ProviderCapabilities } from '../providers/types'
import type { Env } from '../env'

/**
 * The discovered pool of provider/model combinations. Models come from each
 * provider's own endpoint; cost is only 'free' when the provider's metadata
 * says zero cost, otherwise it stays unknown until the owner verifies it.
 */

export interface CatalogModel {
  provider: string
  model: string
  label: string | null
  contextLength: number | null
  free: ModelCostPolicy
  capabilities: Partial<ProviderCapabilities>
  discoveredAt: string
}

interface CatalogRow {
  provider: string
  model: string
  label: string | null
  context_length: number | null
  free: ModelCostPolicy
  capabilities_json: string
  discovered_at: string
}

function serialize(row: CatalogRow): CatalogModel {
  let capabilities: Partial<ProviderCapabilities> = {}
  try {
    const parsed = JSON.parse(row.capabilities_json) as unknown
    if (typeof parsed === 'object' && parsed !== null) capabilities = parsed as Partial<ProviderCapabilities>
  } catch {
    capabilities = {}
  }
  return {
    provider: row.provider,
    model: row.model,
    label: row.label,
    contextLength: row.context_length,
    free: row.free,
    capabilities,
    discoveredAt: row.discovered_at,
  }
}

const UPSERT = `INSERT INTO ai_model_catalog
   (provider, model, label, context_length, free, capabilities_json, source, discovered_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT (provider, model) DO UPDATE SET
   label = excluded.label,
   context_length = excluded.context_length,
   free = excluded.free,
   capabilities_json = excluded.capabilities_json,
   source = excluded.source,
   discovered_at = excluded.discovered_at`

/** Reads the provider's live model list and records it. */
export async function refreshCatalog(
  db: D1Database,
  env: Env,
  providerId: string,
  signal?: AbortSignal,
): Promise<DiscoveredModel[]> {
  const adapter = findAdapter(providerId)
  if (!adapter) throw new ProviderError('provider_unknown', `"${providerId}" is not a known provider.`)
  const resolved = resolveProviderConfig(env, providerId, adapter.defaultModel)
  if (!resolved.configured || !resolved.config) {
    throw new ProviderError('provider_not_configured', resolved.detail)
  }

  const models = await adapter.listModels(resolved.config, signal)
  const now = nowIso()
  const statements = models.map((model) =>
    db
      .prepare(UPSERT)
      .bind(
        providerId,
        model.id,
        model.label ?? null,
        model.contextLength ?? null,
        model.free,
        JSON.stringify(model.capabilities ?? {}),
        'discovery',
        now,
      ),
  )
  if (statements.length > 0) await db.batch(statements)
  return models
}

export async function cachedModels(db: D1Database, providerId: string): Promise<CatalogModel[]> {
  const result = await db
    .prepare('SELECT * FROM ai_model_catalog WHERE provider = ? ORDER BY model')
    .bind(providerId)
    .all<CatalogRow>()
  return (result.results ?? []).map(serialize)
}

export async function cachedModel(db: D1Database, providerId: string, model: string): Promise<CatalogModel | null> {
  const row = await db
    .prepare('SELECT * FROM ai_model_catalog WHERE provider = ? AND model = ?')
    .bind(providerId, model)
    .first<CatalogRow>()
  return row ? serialize(row) : null
}

/** The cost policy the router uses. Never assumes free. */
export async function resolveCost(db: D1Database, providerId: string, model: string): Promise<ModelCostPolicy> {
  const row = await cachedModel(db, providerId, model)
  return row?.free ?? 'unknown'
}

/** The owner explicitly marks a model free or paid (their own verification). */
export async function setModelCost(
  db: D1Database,
  providerId: string,
  model: string,
  free: ModelCostPolicy,
): Promise<void> {
  const existing = await cachedModel(db, providerId, model)
  await db
    .prepare(UPSERT)
    .bind(
      providerId,
      model,
      existing?.label ?? null,
      existing?.contextLength ?? null,
      free,
      JSON.stringify(existing?.capabilities ?? {}),
      'owner',
      nowIso(),
    )
    .run()
}

/** A sensible default model for a provider: a free one when available. */
export async function pickDefaultModel(db: D1Database, providerId: string): Promise<string | null> {
  const models = await cachedModels(db, providerId)
  const free = models.find((model) => model.free === 'free')
  return free?.model ?? models[0]?.model ?? null
}
