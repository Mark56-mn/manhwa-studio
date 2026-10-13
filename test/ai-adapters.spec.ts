import { afterEach, describe, expect, it, vi } from 'vitest'

import { basetenAdapter, googleAdapter, nvidiaAdapter, openRouterAdapter } from '../worker/providers'
import { ProviderError, isProviderError } from '../worker/providers/types'

import type { ProviderAdapter, ProviderConfig } from '../worker/providers/types'

/**
 * Mocked-HTTP unit tests for the OpenAI-compatible adapters. These are NOT live
 * provider tests: outbound `fetch` is replaced, so the adapter's own translation,
 * normalization and error mapping run for real while no network call is made.
 */

interface Recorded {
  url: string
  init: RequestInit
}

const calls: Recorded[] = []

type Reply = { status: number; body?: unknown; text?: string; headers?: Record<string, string>; stream?: string }

function installFetch(reply: Reply | ((url: string, init: RequestInit) => Reply)): void {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const request = init ?? {}
    calls.push({ url, init: request })
    const resolved = typeof reply === 'function' ? reply(url, request) : reply
    if (resolved.stream !== undefined) {
      return Promise.resolve(
        new Response(resolved.stream, {
          status: resolved.status,
          headers: { 'content-type': 'text/event-stream', ...(resolved.headers ?? {}) },
        }),
      )
    }
    if (resolved.text !== undefined) {
      return Promise.resolve(new Response(resolved.text, { status: resolved.status, headers: resolved.headers ?? {} }))
    }
    return Promise.resolve(
      new Response(JSON.stringify(resolved.body ?? {}), {
        status: resolved.status,
        headers: { 'content-type': 'application/json', ...(resolved.headers ?? {}) },
      }),
    )
  })
}

function configFor(adapter: ProviderAdapter, model = 'test-model'): ProviderConfig {
  return { provider: adapter.id, apiKey: 'unit-test-key', model, baseUrl: null }
}

function openAiBody(text: string): Record<string, unknown> {
  return {
    id: 'gen-unit-test',
    model: 'test-model',
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
  }
}

async function expectProviderError(promise: Promise<unknown>, code: string): Promise<ProviderError> {
  try {
    await promise
  } catch (error) {
    expect(isProviderError(error)).toBe(true)
    expect((error as ProviderError).code).toBe(code)
    return error as ProviderError
  }
  throw new Error(`expected a ProviderError with code ${code}`)
}

afterEach(() => {
  calls.length = 0
  vi.unstubAllGlobals()
})

const providers: Array<{ adapter: ProviderAdapter; base: string }> = [
  { adapter: openRouterAdapter, base: 'https://openrouter.ai/api/v1' },
  { adapter: nvidiaAdapter, base: 'https://integrate.api.nvidia.com/v1' },
  { adapter: basetenAdapter, base: 'https://inference.baseten.co/v1' },
]

describe('OpenAI-compatible adapters (mocked HTTP)', () => {
  for (const { adapter, base } of providers) {
    describe(adapter.id, () => {
      it('posts to the provider base URL and normalizes text, model, usage and request id', async () => {
        installFetch({ status: 200, body: openAiBody('Hello from the model') })
        const result = await adapter.chat(configFor(adapter), {
          model: 'test-model',
          messages: [
            { role: 'system', content: 'system' },
            { role: 'user', content: 'hi' },
          ],
          temperature: 0.3,
          maxOutputTokens: 128,
        })

        expect(calls[0]?.url).toBe(`${base}/chat/completions`)
        expect(result.text).toBe('Hello from the model')
        expect(result.model).toBe('test-model')
        expect(result.requestId).toBe('gen-unit-test')
        expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 22, totalTokens: 33 })
        expect(result.finishReason).toBe('stop')

        const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
        expect(body.model).toBe('test-model')
        expect(body.temperature).toBe(0.3)
        expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer unit-test-key')
      })

      it('uses the provider-correct max tokens field', async () => {
        installFetch({ status: 200, body: openAiBody('ok') })
        await adapter.chat(configFor(adapter), {
          model: 'test-model',
          messages: [{ role: 'user', content: 'hi' }],
          maxOutputTokens: 64,
        })
        const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
        if (adapter.id === 'openrouter') {
          expect(body.max_completion_tokens).toBe(64)
          expect(body.max_tokens).toBeUndefined()
        } else {
          expect(body.max_tokens).toBe(64)
        }
      })

      it('maps an invalid key to provider_unauthorized', async () => {
        installFetch({ status: 401, body: { error: { message: 'Invalid API key' } } })
        await expectProviderError(
          adapter.chat(configFor(adapter), { model: 'm', messages: [{ role: 'user', content: 'x' }] }),
          'provider_unauthorized',
        )
      })

      it('maps a missing model to provider_model_not_found', async () => {
        installFetch({ status: 404, body: { error: { message: 'model not found' } } })
        await expectProviderError(
          adapter.chat(configFor(adapter), { model: 'm', messages: [{ role: 'user', content: 'x' }] }),
          'provider_model_not_found',
        )
      })

      it('maps 429 to provider_rate_limited', async () => {
        installFetch({ status: 429, body: { error: { message: 'Too many requests, slow down' } } })
        await expectProviderError(
          adapter.chat(configFor(adapter), { model: 'm', messages: [{ role: 'user', content: 'x' }] }),
          'provider_rate_limited',
        )
      })

      it('maps 402 to provider_quota_exhausted', async () => {
        installFetch({ status: 402, body: { error: { message: 'Insufficient credits' } } })
        await expectProviderError(
          adapter.chat(configFor(adapter), { model: 'm', messages: [{ role: 'user', content: 'x' }] }),
          'provider_quota_exhausted',
        )
      })

      it('maps a 5xx outage to provider_outage', async () => {
        installFetch({ status: 503, body: { error: { message: 'upstream unavailable' } } })
        await expectProviderError(
          adapter.chat(configFor(adapter), { model: 'm', messages: [{ role: 'user', content: 'x' }] }),
          'provider_outage',
        )
      })

      it('maps an aborted request to provider_timeout', async () => {
        vi.stubGlobal('fetch', () => {
          const error = new Error('aborted')
          error.name = 'TimeoutError'
          return Promise.reject(error)
        })
        await expectProviderError(
          adapter.chat(configFor(adapter), { model: 'm', messages: [{ role: 'user', content: 'x' }] }),
          'provider_timeout',
        )
      })

      it('rejects a malformed (empty) response instead of inventing text', async () => {
        installFetch({ status: 200, body: { id: 'x', model: 'm', choices: [{ message: { content: '' } }] } })
        await expectProviderError(
          adapter.chat(configFor(adapter), { model: 'm', messages: [{ role: 'user', content: 'x' }] }),
          'provider_bad_response',
        )
      })

      it('parses an SSE stream into normalized deltas', async () => {
        installFetch({
          status: 200,
          stream:
            `data: ${JSON.stringify({ id: 'gen-1', model: 'test-model', choices: [{ delta: { content: 'Hel' } }] })}\n\n` +
            `data: ${JSON.stringify({ id: 'gen-1', model: 'test-model', choices: [{ delta: { content: 'lo' } }] })}\n\n` +
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
            'data: [DONE]\n\n',
        })
        const chunks = []
        for await (const chunk of adapter.chatStream(configFor(adapter), {
          model: 'test-model',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        })) {
          chunks.push(chunk)
        }
        expect(chunks.map((chunk) => chunk.delta).join('')).toBe('Hello')
        expect(chunks.at(-1)?.done).toBe(true)
      })

      it('marks zero-priced models free and others unknown', async () => {
        installFetch({
          status: 200,
          body: {
            data: [
              { id: 'free-model', pricing: { prompt: '0', completion: '0' } },
              { id: 'paid-model', pricing: { prompt: '0.000001', completion: '0.000002' } },
              { id: 'unknown-model' },
            ],
          },
        })
        const models = await adapter.listModels(configFor(adapter))
        const byId = new Map(models.map((model) => [model.id, model.free]))
        expect(byId.get('free-model')).toBe('free')
        expect(byId.get('paid-model')).toBe('paid')
        expect(byId.get('unknown-model')).toBe('unknown')
      })
    })
  }

  it('OpenRouter checkAuth uses the authenticated /key endpoint', async () => {
    installFetch({ status: 200, body: { data: { label: 'test' } } })
    await openRouterAdapter.checkAuth(configFor(openRouterAdapter))
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/key')
  })
})


const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta'

function geminiBody(text: string): Record<string, unknown> {
  return {
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 9, totalTokenCount: 16 },
    modelVersion: 'test-model-001',
  }
}

describe('Google Gemini adapter (mocked HTTP)', () => {
  it('uses generateContent with x-goog-api-key and normalizes the response', async () => {
    installFetch({ status: 200, body: geminiBody('Gemini says hello') })
    const result = await googleAdapter.chat(configFor(googleAdapter, 'gemini-test'), {
      model: 'gemini-test',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
      temperature: 0.5,
      maxOutputTokens: 100,
    })

    expect(calls[0]?.url).toBe(`${GEMINI_BASE}/models/gemini-test:generateContent`)
    expect(new Headers(calls[0]?.init.headers).get('x-goog-api-key')).toBe('unit-test-key')
    expect(result.text).toBe('Gemini says hello')
    expect(result.model).toBe('test-model-001')
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 9, totalTokens: 16 })

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'be brief' }] })
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }])
    const config = body.generationConfig as Record<string, unknown>
    expect(config.maxOutputTokens).toBe(100)
    expect(config.temperature).toBe(0.5)
  })

  it('translates structured output to responseMimeType + responseSchema', async () => {
    installFetch({ status: 200, body: geminiBody('{"ok":true}') })
    await googleAdapter.chat(configFor(googleAdapter, 'gemini-test'), {
      model: 'gemini-test',
      messages: [{ role: 'user', content: 'json please' }],
      responseFormat: {
        name: 'result',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      },
    })
    const body = JSON.parse(String(calls[0]?.init.body)) as { generationConfig: Record<string, unknown> }
    expect(body.generationConfig.responseMimeType).toBe('application/json')
    expect(body.generationConfig.responseSchema).toMatchObject({ type: 'object' })
  })

  it('maps a 400 invalid-argument (bad key) to provider_invalid_request', async () => {
    installFetch({ status: 400, body: { error: { code: 400, message: 'API key not valid', status: 'INVALID_ARGUMENT' } } })
    await expectProviderError(
      googleAdapter.chat(configFor(googleAdapter, 'm'), { model: 'm', messages: [{ role: 'user', content: 'x' }] }),
      'provider_invalid_request',
    )
  })

  it('maps a missing model to provider_model_not_found', async () => {
    installFetch({ status: 404, body: { error: { code: 404, message: 'models/unknown is not found' } } })
    await expectProviderError(
      googleAdapter.chat(configFor(googleAdapter, 'unknown'), {
        model: 'unknown',
        messages: [{ role: 'user', content: 'x' }],
      }),
      'provider_model_not_found',
    )
  })

  it('maps 429 to provider_rate_limited', async () => {
    installFetch({ status: 429, body: { error: { code: 429, message: 'Resource has been exhausted' } } })
    await expectProviderError(
      googleAdapter.chat(configFor(googleAdapter, 'm'), { model: 'm', messages: [{ role: 'user', content: 'x' }] }),
      'provider_rate_limited',
    )
  })

  it('maps a 5xx outage to provider_outage', async () => {
    installFetch({ status: 503, body: { error: { code: 503, message: 'The model is overloaded' } } })
    await expectProviderError(
      googleAdapter.chat(configFor(googleAdapter, 'm'), { model: 'm', messages: [{ role: 'user', content: 'x' }] }),
      'provider_outage',
    )
  })

  it('maps an aborted request to provider_timeout', async () => {
    vi.stubGlobal('fetch', () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      return Promise.reject(error)
    })
    await expectProviderError(
      googleAdapter.chat(configFor(googleAdapter, 'm'), { model: 'm', messages: [{ role: 'user', content: 'x' }] }),
      'provider_timeout',
    )
  })

  it('rejects a malformed response with no candidates', async () => {
    installFetch({ status: 200, body: { candidates: [] } })
    await expectProviderError(
      googleAdapter.chat(configFor(googleAdapter, 'm'), { model: 'm', messages: [{ role: 'user', content: 'x' }] }),
      'provider_bad_response',
    )
  })

  it('parses a streamGenerateContent SSE stream', async () => {
    installFetch({
      status: 200,
      stream:
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hel' }] } }] })}\n\n` +
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'lo' }] }, finishReason: 'STOP' }] })}\n\n`,
    })
    const chunks = []
    for await (const chunk of googleAdapter.chatStream(configFor(googleAdapter, 'gemini-test'), {
      model: 'gemini-test',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })) {
      chunks.push(chunk)
    }
    expect(chunks.map((chunk) => chunk.delta).join('')).toBe('Hello')
    expect(chunks.at(-1)?.done).toBe(true)
    expect(calls[0]?.url).toContain(':streamGenerateContent?alt=sse')
  })

  it('lists only models that support generateContent', async () => {
    installFetch({
      status: 200,
      body: {
        models: [
          { name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/embedding-a', supportedGenerationMethods: ['embedContent'] },
        ],
      },
    })
    const models = await googleAdapter.listModels(configFor(googleAdapter))
    expect(models.map((model) => model.id)).toEqual(['gemini-a'])
    expect(models[0]?.free).toBe('unknown')
  })
})

