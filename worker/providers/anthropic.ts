import { ProviderError, providerErrorMessage, providerFetch, toProviderError } from './types'

import type { ProviderAdapter } from './types'

const TIMEOUT_MS = 120_000
const API_VERSION = '2023-06-01'
const BASE_URL = 'https://api.anthropic.com/v1'

function headers(apiKey: string): Record<string, string> {
  return {
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
    accept: 'application/json',
  }
}

/** Anthropic Messages API. Plain fetch — no SDK, no Node built-ins. */
export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',
  label: 'Anthropic (Claude)',
  docsUrl: 'https://platform.claude.com/docs/en/api/messages/create',
  keyEnvVars: ['SCRIPT_API_KEY', 'ANTHROPIC_API_KEY'],
  needsBaseUrl: false,
  defaultModel: 'claude-sonnet-5-5',
  suggestedModels: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'],

  async checkAuth(config, signal) {
    const response = await providerFetch(
      `${BASE_URL}/models`,
      { method: 'GET', headers: headers(config.apiKey), signal },
      TIMEOUT_MS,
    )
    if (!response.ok) throw toProviderError(response, await providerErrorMessage(response))
  },

  async listModels(config, signal) {
    const response = await providerFetch(
      `${BASE_URL}/models`,
      { method: 'GET', headers: headers(config.apiKey), signal },
      TIMEOUT_MS,
    )
    if (!response.ok) throw toProviderError(response, await providerErrorMessage(response))
    const body = (await response.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null
    const ids = (body?.data ?? [])
      .map((entry) => (entry && typeof entry.id === 'string' ? entry.id : null))
      .filter((id): id is string => id !== null)
    if (ids.length === 0) {
      throw new ProviderError('provider_bad_response', 'The provider returned an empty model list.')
    }
    return ids.sort()
  },

  async generate(config, request) {
    const response = await providerFetch(
      `${BASE_URL}/messages`,
      {
        method: 'POST',
        headers: { ...headers(config.apiKey), 'content-type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          max_tokens: request.maxOutputTokens,
          temperature: request.temperature,
          // Anthropic takes the system prompt as a top-level field.
          system: request.system,
          messages: [{ role: 'user', content: request.prompt }],
        }),
        signal: request.signal,
      },
      TIMEOUT_MS,
    )
    if (!response.ok) throw toProviderError(response, await providerErrorMessage(response))

    const body = (await response.json().catch(() => null)) as {
      model?: unknown
      content?: Array<{ type?: unknown; text?: unknown }>
      usage?: { input_tokens?: unknown; output_tokens?: unknown }
      stop_reason?: unknown
    } | null

    const text = (body?.content ?? [])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('')

    if (text.trim().length === 0) {
      throw new ProviderError(
        'provider_bad_response',
        'The provider returned no text. Nothing was saved, so this episode still has no script from this attempt.',
      )
    }
    return {
      text,
      model: typeof body?.model === 'string' ? body.model : config.model,
      usage: {
        inputTokens: typeof body?.usage?.input_tokens === 'number' ? body.usage.input_tokens : null,
        outputTokens: typeof body?.usage?.output_tokens === 'number' ? body.usage.output_tokens : null,
      },
      finishReason: typeof body?.stop_reason === 'string' ? body.stop_reason : null,
    }
  },
}
