import { anthropicAdapter } from './anthropic'
import { googleAdapter } from './google'
import { createOpenAiCompatibleAdapter } from './openaiCompatible'
import { isProviderError } from './types'

import type { ProviderAdapter, ProviderCapabilities, ProviderConfig } from './types'
import type { Env } from '../env'

/**
 * The provider registry. Adding a provider means adding an adapter here — the
 * router, the workflows and the UI never mention a provider by name.
 *
 * Provider-specific keys only. The legacy `SCRIPT_API_KEY` is honoured solely
 * for the provider explicitly selected by `SCRIPT_PROVIDER` (see
 * resolveScriptConfig), so one shared key can never silently configure every
 * provider.
 */

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1'
export const BASETEN_BASE_URL = 'https://inference.baseten.co/v1'

const OPENAI_COMPATIBLE = (overrides: Partial<ProviderCapabilities>): ProviderCapabilities => ({
  streaming: true,
  structuredOutput: 'json_schema',
  tools: true,
  vision: false,
  ...overrides,
})

export const openRouterAdapter = createOpenAiCompatibleAdapter({
  id: 'openrouter',
  label: 'OpenRouter',
  docsUrl: 'https://openrouter.ai/docs',
  defaultBaseUrl: OPENROUTER_BASE_URL,
  keyEnvVars: ['OPENROUTER_API_KEY'],
  baseUrlEnvVars: ['OPENROUTER_BASE_URL'],
  // No hard-coded model: the live list is read from the provider.
  defaultModel: '',
  suggestedModels: [],
  capabilities: OPENAI_COMPATIBLE({ vision: true }),
  maxTokensField: 'max_completion_tokens',
  attributionHeaders: { 'HTTP-Referer': 'https://manhwa-studio.app', 'X-Title': 'Manhwa Studio' },
  // /models is public on OpenRouter; /key is the authenticated endpoint.
  authCheckPath: '/key',
  streamUsage: true,
})

export const nvidiaAdapter = createOpenAiCompatibleAdapter({
  id: 'nvidia',
  label: 'NVIDIA NIM',
  docsUrl: 'https://docs.api.nvidia.com/nim/reference/llm-apis',
  defaultBaseUrl: NVIDIA_BASE_URL,
  keyEnvVars: ['NVIDIA_API_KEY'],
  baseUrlEnvVars: ['NVIDIA_BASE_URL'],
  defaultModel: '',
  suggestedModels: [],
  // NVIDIA's docs do not confirm a JSON response format, so none is declared.
  capabilities: OPENAI_COMPATIBLE({ structuredOutput: 'none' }),
  maxTokensField: 'max_tokens',
})

export const basetenAdapter = createOpenAiCompatibleAdapter({
  id: 'baseten',
  label: 'Baseten',
  docsUrl: 'https://docs.baseten.co/',
  defaultBaseUrl: BASETEN_BASE_URL,
  keyEnvVars: ['BASETEN_API_KEY'],
  baseUrlEnvVars: ['BASETEN_BASE_URL'],
  defaultModel: '',
  suggestedModels: [],
  capabilities: OPENAI_COMPATIBLE({}),
  maxTokensField: 'max_tokens',
  streamUsage: true,
})

export const openAiAdapter = createOpenAiCompatibleAdapter({
  id: 'openai',
  label: 'OpenAI',
  docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
  defaultBaseUrl: 'https://api.openai.com/v1',
  keyEnvVars: ['OPENAI_API_KEY'],
  baseUrlEnvVars: ['OPENAI_BASE_URL'],
  defaultModel: '',
  suggestedModels: [],
  capabilities: OPENAI_COMPATIBLE({ vision: true }),
  maxTokensField: 'max_completion_tokens',
  streamUsage: true,
})

export const customAdapter = createOpenAiCompatibleAdapter({
  id: 'custom',
  label: 'Custom OpenAI-compatible endpoint',
  docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
  defaultBaseUrl: null,
  keyEnvVars: ['CUSTOM_API_KEY', 'SCRIPT_API_KEY'],
  baseUrlEnvVars: ['CUSTOM_BASE_URL', 'SCRIPT_BASE_URL'],
  defaultModel: '',
  suggestedModels: [],
  capabilities: OPENAI_COMPATIBLE({}),
  maxTokensField: 'max_tokens',
})

export const AI_ADAPTERS: ProviderAdapter[] = [
  openRouterAdapter,
  nvidiaAdapter,
  googleAdapter,
  basetenAdapter,
  openAiAdapter,
  anthropicAdapter,
  customAdapter,
]

/** Kept as the historical name used by the script capability. */
export const SCRIPT_ADAPTERS = AI_ADAPTERS

/** Variables the script capability reports when nothing at all is set. */
export const SCRIPT_ENV_VARS = ['SCRIPT_PROVIDER', 'SCRIPT_API_KEY', 'SCRIPT_MODEL'] as const
export const DIRECTOR_ENV_VARS = ['DIRECTOR_PROVIDER', 'DIRECTOR_MODEL'] as const

export function readEnvValue(env: Env, name: string): string | null {
  const value = (env as unknown as Record<string, unknown>)[name]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export function findAdapter(id: string | null | undefined): ProviderAdapter | null {
  if (!id) return null
  return AI_ADAPTERS.find((adapter) => adapter.id === id.trim().toLowerCase()) ?? null
}

export function describeAdapters(): Array<{
  id: string
  label: string
  docsUrl: string
  keyEnvVars: string[]
  baseUrlEnvVars: string[]
  defaultBaseUrl: string | null
  defaultModel: string
  suggestedModels: string[]
  capabilities: ProviderCapabilities
  needsBaseUrl: boolean
}> {
  return AI_ADAPTERS.map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    docsUrl: adapter.docsUrl,
    keyEnvVars: adapter.keyEnvVars,
    baseUrlEnvVars: adapter.baseUrlEnvVars,
    defaultBaseUrl: adapter.defaultBaseUrl,
    defaultModel: adapter.defaultModel,
    suggestedModels: adapter.suggestedModels,
    capabilities: adapter.capabilities,
    needsBaseUrl: adapter.needsBaseUrl,
  }))
}

/** The first configured API key for an adapter, in precedence order. */
export function providerKey(env: Env, adapter: ProviderAdapter, extraKeys: string[] = []): string | null {
  for (const name of [...adapter.keyEnvVars, ...extraKeys]) {
    const value = readEnvValue(env, name)
    if (value) return value
  }
  return null
}

/** The resolved base URL for an adapter: an override wins, else the default. */
export function providerBaseUrl(env: Env, adapter: ProviderAdapter): string | null {
  for (const name of adapter.baseUrlEnvVars) {
    const value = readEnvValue(env, name)
    if (value) return value
  }
  return adapter.defaultBaseUrl
}

export interface ProviderConfigResolution {
  configured: boolean
  adapter: ProviderAdapter | null
  config: ProviderConfig | null
  missing: string[]
  detail: string
}

/**
 * Resolves one named provider from the deployment environment. Used by the
 * router for every candidate it tries.
 */
export function resolveProviderConfig(
  env: Env,
  providerId: string | null | undefined,
  modelOverride?: string | null,
  extraKeyEnvVars: string[] = [],
): ProviderConfigResolution {
  const adapter = findAdapter(providerId)
  if (!adapter) {
    return {
      configured: false,
      adapter: null,
      config: null,
      missing: [],
      detail: providerId
        ? `"${providerId}" is not a provider this build knows. Known providers: ${AI_ADAPTERS.map((entry) => entry.id).join(', ')}.`
        : 'No provider was named.',
    }
  }

  const apiKey = providerKey(env, adapter, extraKeyEnvVars)
  const baseUrl = providerBaseUrl(env, adapter)
  const model = (modelOverride ?? '').trim() || adapter.defaultModel

  const missing: string[] = []
  if (!apiKey) missing.push(adapter.keyEnvVars[0] ?? 'API key')
  if (adapter.needsBaseUrl && !baseUrl) missing.push(...adapter.baseUrlEnvVars)
  if (!model) missing.push(`${adapter.id.toUpperCase()}_MODEL`)

  if (missing.length > 0) {
    const unique = [...new Set(missing)]
    return {
      configured: false,
      adapter,
      config: null,
      missing: unique,
      detail: `${adapter.label} is selected but cannot be used yet. Still to set: ${unique.join(', ')}.`,
    }
  }

  return {
    configured: true,
    adapter,
    missing: [],
    detail: `${adapter.label} · model ${model}`,
    config: { provider: adapter.id, apiKey: apiKey as string, model, baseUrl },
  }
}

export interface ScriptConfigResolution {
  configured: boolean
  config: ProviderConfig | null
  adapter: ProviderAdapter | null
  missing: string[]
  detail: string
}

/**
 * Legacy single-provider resolution driven by `SCRIPT_*`. It is the default
 * Script AI candidate when no per-role setting has been saved, and it accepts
 * `SCRIPT_API_KEY` for the explicitly selected provider.
 */
export function resolveScriptConfig(env: Env): ScriptConfigResolution {
  const selected = readEnvValue(env, 'SCRIPT_PROVIDER')
  if (!selected) {
    return {
      configured: false,
      config: null,
      adapter: null,
      missing: [...SCRIPT_ENV_VARS],
      detail:
        'No script provider is selected. Choose one in Settings → AI providers, or set SCRIPT_PROVIDER (openrouter | nvidia | google | baseten | openai | anthropic | custom) and its API key.',
    }
  }

  const adapter = findAdapter(selected)
  if (!adapter) {
    return {
      configured: false,
      config: null,
      adapter: null,
      missing: ['SCRIPT_PROVIDER'],
      detail: `"${selected}" is not a provider this build knows. Use one of: ${AI_ADAPTERS.map((entry) => entry.id).join(', ')}.`,
    }
  }

  const apiKey = providerKey(env, adapter, ['SCRIPT_API_KEY'])
  const baseUrl = providerBaseUrl(env, adapter)
  const model = readEnvValue(env, 'SCRIPT_MODEL') ?? adapter.defaultModel

  const missing: string[] = []
  if (!apiKey) missing.push('SCRIPT_API_KEY', adapter.keyEnvVars[0] ?? 'API key')
  if (adapter.needsBaseUrl && !baseUrl) missing.push(...adapter.baseUrlEnvVars)
  if (!model) missing.push('SCRIPT_MODEL')

  if (missing.length > 0) {
    const unique = [...new Set(missing)]
    return {
      configured: false,
      config: null,
      adapter,
      missing: unique,
      detail: `${adapter.label} is selected but cannot be used yet. Still to set: ${unique.join(', ')}.`,
    }
  }

  return {
    configured: true,
    adapter,
    missing: [],
    detail: `${adapter.label} · model ${model}`,
    config: { provider: adapter.id, apiKey: apiKey as string, model, baseUrl },
  }
}


export interface ProviderCheckOutcome {
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
 * Performs a genuine authenticated call to the configured script provider.
 *
 * This is the only thing in the studio allowed to move a capability to
 * `connected_verified`: there is no hard-coded "connected" flag anywhere.
 */
export async function runScriptProviderCheck(env: Env): Promise<ProviderCheckOutcome> {
  const started = Date.now()
  const resolved = resolveScriptConfig(env)
  const provider = resolved.adapter?.id ?? readEnvValue(env, 'SCRIPT_PROVIDER') ?? 'none'
  const providerLabel = resolved.adapter?.label ?? 'Unknown provider'
  const model = resolved.config?.model ?? readEnvValue(env, 'SCRIPT_MODEL') ?? null

  if (!resolved.adapter || !resolved.config) {
    return {
      capability: 'script',
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
      capability: 'script',
      provider,
      providerLabel,
      model,
      ok: false,
      detail: isProviderError(error) ? error.message : 'The provider check failed for an unknown reason.',
      latencyMs: Date.now() - started,
      models: [],
      code: isProviderError(error) ? error.code : 'provider_http_error',
    }
  }

  // A valid credential can still fail to list models (some endpoints do not
  // implement it); that alone is not a verification failure.
  const discovered = await resolved.adapter.listModels(resolved.config, signal).catch(() => [])
  const models = discovered.map((entry) => entry.id)

  const latencyMs = Date.now() - started
  if (model && models.length > 0 && !isListed(model, models) && resolved.adapter.id !== 'custom') {
    return {
      capability: 'script',
      provider,
      providerLabel,
      model,
      ok: false,
      detail: `The credential works, but the configured model "${model}" is not among the ${models.length} models it can use. Update the model.`,
      latencyMs,
      models,
      code: 'provider_model_not_found',
    }
  }

  return {
    capability: 'script',
    provider,
    providerLabel,
    model,
    ok: true,
    detail: `Authenticated call to ${resolved.adapter.label} succeeded for model ${model}${
      models.length > 0 ? ` (${models.length} models available to this credential)` : ''
    }.`,
    latencyMs,
    models,
    code: null,
  }
}

