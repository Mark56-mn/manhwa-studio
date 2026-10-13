import { anthropicAdapter } from './anthropic'
import { googleAdapter } from './google'
import { createOpenAiCompatibleAdapter } from './openaiCompatible'
import { isProviderError } from './types'

import type { ProviderAdapter, ProviderConfig } from './types'
import type { Env } from '../env'

/**
 * The provider registry. Adding a provider means adding an adapter here — the
 * routes, prompts and UI never mention a provider by name.
 */

export const openAiAdapter = createOpenAiCompatibleAdapter({
  id: 'openai',
  label: 'OpenAI',
  docsUrl: 'https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create/',
  defaultBaseUrl: 'https://api.openai.com/v1',
  keyEnvVars: ['SCRIPT_API_KEY', 'OPENAI_API_KEY'],
  defaultModel: 'gpt-6.1-sol',
  suggestedModels: ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra'],
})

export const openRouterAdapter = createOpenAiCompatibleAdapter({
  id: 'openrouter',
  label: 'OpenRouter',
  docsUrl: 'https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion',
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  keyEnvVars: ['SCRIPT_API_KEY', 'OPENROUTER_API_KEY'],
  defaultModel: 'openrouter/free',
  suggestedModels: ['openrouter/free'],
  // /models is public on OpenRouter; the key endpoint is the authenticated one.
  authCheckPath: '/key',
})

export const customAdapter = createOpenAiCompatibleAdapter({
  id: 'custom',
  label: 'Custom OpenAI-compatible endpoint',
  docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
  defaultBaseUrl: null,
  keyEnvVars: ['SCRIPT_API_KEY'],
  defaultModel: '',
  suggestedModels: [],
})

export const SCRIPT_ADAPTERS: ProviderAdapter[] = [
  openAiAdapter,
  openRouterAdapter,
  anthropicAdapter,
  googleAdapter,
  customAdapter,
]

/** Variables the script capability reports when nothing at all is set. */
export const SCRIPT_ENV_VARS = ['SCRIPT_PROVIDER', 'SCRIPT_API_KEY', 'SCRIPT_MODEL'] as const

export function readEnvValue(env: Env, name: string): string | null {
  const value = (env as unknown as Record<string, unknown>)[name]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export function findAdapter(id: string | null | undefined): ProviderAdapter | null {
  if (!id) return null
  return SCRIPT_ADAPTERS.find((adapter) => adapter.id === id.trim().toLowerCase()) ?? null
}

export function describeAdapters(): Array<{ id: string; label: string; docsUrl: string; keyEnvVars: string[]; defaultModel: string; needsBaseUrl: boolean }> {
  return SCRIPT_ADAPTERS.map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    docsUrl: adapter.docsUrl,
    keyEnvVars: adapter.keyEnvVars,
    defaultModel: adapter.defaultModel,
    needsBaseUrl: adapter.needsBaseUrl,
  }))
}

export interface ScriptConfigResolution {
  configured: boolean
  config: ProviderConfig | null
  adapter: ProviderAdapter | null
  missing: string[]
  detail: string
}

/** Resolves the configured script provider, or explains exactly what is missing. */
export function resolveScriptConfig(env: Env): ScriptConfigResolution {
  const selected = readEnvValue(env, 'SCRIPT_PROVIDER')
  if (!selected) {
    return {
      configured: false,
      config: null,
      adapter: null,
      missing: [...SCRIPT_ENV_VARS],
      detail:
        'No script provider is selected. Choose one in Settings → Integrations and set SCRIPT_PROVIDER plus its key as deployment secrets.',
    }
  }

  const adapter = findAdapter(selected)
  if (!adapter) {
    return {
      configured: false,
      config: null,
      adapter: null,
      missing: [],
      detail: `Unknown script provider "${selected}". Supported providers: ${SCRIPT_ADAPTERS.map((entry) => entry.id).join(', ')}.`,
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

  const baseUrl = readEnvValue(env, 'SCRIPT_BASE_URL')
  if (adapter.needsBaseUrl && !baseUrl) missing.push('SCRIPT_BASE_URL')

  const model = readEnvValue(env, 'SCRIPT_MODEL') ?? adapter.defaultModel
  if (!model) missing.push('SCRIPT_MODEL')

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
    detail: `${adapter.label} · model ${model}`,
    config: { provider: adapter.id, apiKey, model, baseUrl },
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
 * Performs a genuine authenticated call to the configured provider.
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
    // The authenticated call is what proves the credential.
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
  const models = await resolved.adapter.listModels(resolved.config, signal).catch((): string[] => [])

  const latencyMs = Date.now() - started
  if (model && models.length > 0 && !isListed(model, models) && resolved.adapter.id !== 'custom') {
    return {
      capability: 'script',
      provider,
      providerLabel,
      model,
      ok: false,
      detail: `The credential works, but the configured model "${model}" is not among the ${models.length} models it can use. Update SCRIPT_MODEL.`,
      latencyMs,
      models,
      code: 'model_not_available',
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
