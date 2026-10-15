/**
 * Image provider registry.
 */

import { customImageAdapter, openAIImageAdapter } from './openaiImage'
import { stabilityAdapter } from './stabilityImage'
import type { ImageProviderAdapter, ImageProviderConfig } from './imageTypes'
import { readEnvValue } from './index'

import type { Env } from '../env'

/**
 * The image provider registry. Adding a provider means adding an adapter here.
 */
export const IMAGE_ADAPTERS: ImageProviderAdapter[] = [
  openAIImageAdapter,
  stabilityAdapter,
  customImageAdapter,
]

/** Variables the image capability reports when nothing at all is set. */
export const IMAGE_ENV_VARS = ['IMAGE_PROVIDER', 'IMAGE_API_KEY', 'IMAGE_MODEL'] as const

export function findImageAdapter(id: string | null | undefined): ImageProviderAdapter | null {
  if (!id) return null
  return IMAGE_ADAPTERS.find((adapter) => adapter.id === id.trim().toLowerCase()) ?? null
}

export function describeImageAdapters(): Array<{ id: string; label: string; docsUrl: string; keyEnvVars: string[]; defaultModel: string; needsBaseUrl: boolean }> {
  return IMAGE_ADAPTERS.map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    docsUrl: adapter.docsUrl,
    keyEnvVars: adapter.keyEnvVars,
    defaultModel: adapter.defaultModel,
    needsBaseUrl: adapter.needsBaseUrl,
  }))
}

export interface ImageConfigResolution {
  configured: boolean
  config: ImageProviderConfig | null
  adapter: ImageProviderAdapter | null
  missing: string[]
  detail: string
}

/** Resolves the configured image provider, or explains exactly what is missing. */
export function resolveImageConfig(env: Env): ImageConfigResolution {
  const selected = readEnvValue(env, 'IMAGE_PROVIDER')
  if (!selected) {
    return {
      configured: false,
      config: null,
      adapter: null,
      missing: [...IMAGE_ENV_VARS],
      detail:
        'No image provider is selected. Choose one in Settings -> Integrations and set IMAGE_PROVIDER plus its key as deployment secrets.',
    }
  }

  const adapter = findImageAdapter(selected)
  if (!adapter) {
    return {
      configured: false,
      config: null,
      adapter: null,
      missing: [],
      detail: `Unknown image provider "${selected}". Supported providers: ${IMAGE_ADAPTERS.map((entry) => entry.id).join(', ')}.`,
    }
  }

  const missing: string[] = []
  let apiKey: string | null = null
  for (const name of adapter.keyEnvVars) {
    const value = readEnvValue(env, name)
    if (value) {
      apiKey = value
      break
    }
  }
  if (!apiKey) missing.push(adapter.keyEnvVars.join(' or '))

  const baseUrl = readEnvValue(env, 'IMAGE_BASE_URL')
  if (adapter.needsBaseUrl && !baseUrl) missing.push('IMAGE_BASE_URL')

  const model = readEnvValue(env, 'IMAGE_MODEL') ?? adapter.defaultModel
  if (!model) missing.push('IMAGE_MODEL')

  if (missing.length > 0 || !apiKey || !model) {
    return {
      configured: false,
      config: null,
      adapter,
      missing,
      detail: `${adapter.label} is selected but cannot be used yet. Still to set: ${missing.join(', ')}.`,
    }
  }

  return {
    configured: true,
    adapter,
    missing: [],
    detail: `${adapter.label} - model ${model}`,
    config: { provider: adapter.id, apiKey: apiKey!, model, baseUrl },
  }
}

export interface ImageProviderCheckOutcome {
  capability: string
  provider: string
  providerLabel: string
  model: string | null
  ok: boolean
  detail: string
  latencyMs: number
  models: string[]
  code: string | null
}

function isListed(model: string, models: string[]): boolean {
  const target = model.trim().toLowerCase()
  return models.some((entry) => entry.trim().toLowerCase() === target)
}

/**
 * Performs a genuine authenticated call to the configured image provider.
 */
export async function runImageProviderCheck(env: Env): Promise<ImageProviderCheckOutcome> {
  const started = Date.now()
  const resolved = resolveImageConfig(env)
  const provider = resolved.adapter?.id ?? readEnvValue(env, 'IMAGE_PROVIDER') ?? 'none'
  const providerLabel = resolved.adapter?.label ?? 'Unknown provider'
  const model = resolved.config?.model ?? readEnvValue(env, 'IMAGE_MODEL') ?? null

  if (!resolved.adapter || !resolved.config) {
    return {
      capability: 'image',
      provider,
      providerLabel,
      model,
      ok: false,
      detail: resolved.detail,
      latencyMs: Date.now() - started,
      models: [],
      code: 'provider_not_configured',
    }
  }

  const signal = AbortSignal.timeout(30_000)
  try {
    await resolved.adapter.checkAuth(resolved.config, signal)
  } catch (error) {
    return {
      capability: 'image',
      provider,
      providerLabel,
      model,
      ok: false,
      detail: error instanceof Error ? error.message : 'The provider check failed for an unknown reason.',
      latencyMs: Date.now() - started,
      models: [],
      code: 'provider_http_error',
    }
  }

  // Try to list models
  const models = await resolved.adapter.listModels(resolved.config, signal).catch((): string[] => [])

  const latencyMs = Date.now() - started
  if (model && models.length > 0 && !isListed(model, models) && resolved.adapter.id !== 'custom') {
    return {
      capability: 'image',
      provider,
      providerLabel,
      model,
      ok: false,
      detail: `The credential works, but the configured model "${model}" is not among the ${models.length} models it can use. Update IMAGE_MODEL.`,
      latencyMs,
      models,
      code: 'model_not_available',
    }
  }

  return {
    capability: 'image',
    provider,
    providerLabel,
    model,
    ok: true,
    detail: `Authenticated call to ${resolved.adapter.label} succeeded for model ${model}${models.length > 0 ? ` (${models.length} models available to this credential)` : ''}.`,
    latencyMs,
    models,
    code: null,
  }
}
