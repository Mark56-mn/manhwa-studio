import { ProviderError, providerErrorMessage, providerFetch, toProviderError } from './types'

import type { GenerationResult, ProviderAdapter, ProviderConfig } from './types'

/** Every provider request is bounded; a hung call must never hang the studio. */
const TIMEOUT_MS = 120_000

export interface OpenAiCompatibleOptions {
  id: string
  label: string
  docsUrl: string
  /** `null` means this adapter cannot work without SCRIPT_BASE_URL. */
  defaultBaseUrl: string | null
  keyEnvVars: string[]
  defaultModel: string
  suggestedModels: string[]
  extraHeaders?: Record<string, string>
  /** Path used by the authenticated check when /models is not authenticated. */
  authCheckPath?: string
}

function baseUrlFor(config: ProviderConfig, fallback: string | null): string {
  const raw = (config.baseUrl ?? fallback ?? '').trim().replace(/\/+$/, '')
  if (!raw) {
    throw new ProviderError(
      'provider_not_configured',
      'This provider needs an OpenAI-compatible base URL (set SCRIPT_BASE_URL).',
    )
  }
  return raw
}

function authHeaders(config: ProviderConfig, extra?: Record<string, string>): Record<string, string> {
  return {
    authorization: `Bearer ${config.apiKey}`,
    accept: 'application/json',
    ...extra,
  }
}

/** Chat-completion text can be a string or an array of typed parts. */
function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'object' && part !== null && 'text' in part) {
          const value = (part as { text?: unknown }).text
          return typeof value === 'string' ? value : ''
        }
        return ''
      })
      .join('')
  }
  return ''
}

/**
 * Builds an adapter for any provider that speaks the OpenAI chat-completions
 * shape. OpenAI, OpenRouter and self-hosted compatible endpoints all do.
 */
export function createOpenAiCompatibleAdapter(options: OpenAiCompatibleOptions): ProviderAdapter {
  return {
    id: options.id,
    label: options.label,
    docsUrl: options.docsUrl,
    keyEnvVars: options.keyEnvVars,
    needsBaseUrl: options.defaultBaseUrl === null,
    defaultModel: options.defaultModel,
    suggestedModels: options.suggestedModels,

    async checkAuth(config, signal) {
      const base = baseUrlFor(config, options.defaultBaseUrl)
      const response = await providerFetch(
        `${base}${options.authCheckPath ?? '/models'}`,
        { method: 'GET', headers: authHeaders(config, options.extraHeaders), signal },
        TIMEOUT_MS,
      )
      if (!response.ok) throw toProviderError(response, await providerErrorMessage(response))
    },

    async listModels(config, signal) {
      const base = baseUrlFor(config, options.defaultBaseUrl)
      const response = await providerFetch(
        `${base}/models`,
        { method: 'GET', headers: authHeaders(config, options.extraHeaders), signal },
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

    async generate(config, request): Promise<GenerationResult> {
      const base = baseUrlFor(config, options.defaultBaseUrl)
      const response = await providerFetch(
        `${base}/chat/completions`,
        {
          method: 'POST',
          headers: { ...authHeaders(config, options.extraHeaders), 'content-type': 'application/json' },
          body: JSON.stringify({
            model: config.model,
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.prompt },
            ],
            // `max_tokens` is deprecated; the current field name is used here.
            max_completion_tokens: request.maxOutputTokens,
            temperature: request.temperature,
          }),
          signal: request.signal,
        },
        TIMEOUT_MS,
      )
      if (!response.ok) throw toProviderError(response, await providerErrorMessage(response))

      const body = (await response.json().catch(() => null)) as {
        model?: unknown
        choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
      } | null

      const text = textFromContent(body?.choices?.[0]?.message?.content)
      if (text.trim().length === 0) {
        throw new ProviderError(
          'provider_bad_response',
          'The provider returned no text. Nothing was saved, so this episode still has no script from this attempt.',
        )
      }
      const finishReason = body?.choices?.[0]?.finish_reason
      return {
        text,
        model: typeof body?.model === 'string' ? body.model : config.model,
        usage: {
          inputTokens: typeof body?.usage?.prompt_tokens === 'number' ? body.usage.prompt_tokens : null,
          outputTokens: typeof body?.usage?.completion_tokens === 'number' ? body.usage.completion_tokens : null,
        },
        finishReason: typeof finishReason === 'string' ? finishReason : null,
      }
    },
  }
}
