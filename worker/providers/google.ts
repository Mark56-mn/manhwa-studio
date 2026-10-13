import { ProviderError, providerErrorMessage, providerFetch, toProviderError } from './types'

import type { ProviderAdapter } from './types'

const TIMEOUT_MS = 120_000
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

/** The API key travels in a header, never in the URL (URLs get logged). */
function headers(apiKey: string): Record<string, string> {
  return { 'x-goog-api-key': apiKey, accept: 'application/json' }
}

/** Google Gemini (Generative Language API). Plain fetch — no SDK. */
export const googleAdapter: ProviderAdapter = {
  id: 'google',
  label: 'Google (Gemini)',
  docsUrl: 'https://ai.google.dev/api/generate-content',
  keyEnvVars: ['SCRIPT_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  needsBaseUrl: false,
  defaultModel: 'gemini-3.8-flash',
  suggestedModels: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.1-pro-preview'],

  async checkAuth(config, signal) {
    const response = await providerFetch(
      `${BASE_URL}/models?pageSize=1`,
      { method: 'GET', headers: headers(config.apiKey), signal },
      TIMEOUT_MS,
    )
    if (!response.ok) throw toProviderError(response, await providerErrorMessage(response))
  },

  async listModels(config, signal) {
    const response = await providerFetch(
      `${BASE_URL}/models?pageSize=200`,
      { method: 'GET', headers: headers(config.apiKey), signal },
      TIMEOUT_MS,
    )
    if (!response.ok) throw toProviderError(response, await providerErrorMessage(response))
    const body = (await response.json().catch(() => null)) as {
      models?: Array<{ name?: unknown; supportedGenerationMethods?: unknown }>
    } | null
    const ids = (body?.models ?? [])
      .filter((model) => {
        const methods = model?.supportedGenerationMethods
        return !Array.isArray(methods) || methods.includes('generateContent')
      })
      .map((model) => (typeof model.name === 'string' ? model.name.replace(/^models\//, '') : null))
      .filter((id): id is string => id !== null)
    if (ids.length === 0) {
      throw new ProviderError('provider_bad_response', 'The provider returned an empty model list.')
    }
    return ids.sort()
  },

  async generate(config, request) {
    const response = await providerFetch(
      `${BASE_URL}/models/${encodeURIComponent(config.model)}:generateContent`,
      {
        method: 'POST',
        headers: { ...headers(config.apiKey), 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.system }] },
          contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
          generationConfig: {
            maxOutputTokens: request.maxOutputTokens,
            temperature: request.temperature,
          },
        }),
        signal: request.signal,
      },
      TIMEOUT_MS,
    )
    if (!response.ok) throw toProviderError(response, await providerErrorMessage(response))

    const body = (await response.json().catch(() => null)) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> }; finishReason?: unknown }>
      usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown }
      modelVersion?: unknown
    } | null

    const candidate = body?.candidates?.[0]
    const text = (candidate?.content?.parts ?? [])
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('')

    if (text.trim().length === 0) {
      throw new ProviderError(
        'provider_bad_response',
        'The provider returned no text. Nothing was saved, so this episode still has no script from this attempt.',
      )
    }
    return {
      text,
      model: typeof body?.modelVersion === 'string' ? body.modelVersion : config.model,
      usage: {
        inputTokens:
          typeof body?.usageMetadata?.promptTokenCount === 'number' ? body.usageMetadata.promptTokenCount : null,
        outputTokens:
          typeof body?.usageMetadata?.candidatesTokenCount === 'number'
            ? body.usageMetadata.candidatesTokenCount
            : null,
      },
      finishReason: typeof candidate?.finishReason === 'string' ? candidate.finishReason : null,
    }
  },
}
