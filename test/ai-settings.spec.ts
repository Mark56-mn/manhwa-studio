import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AUTHOR, call, json, resetDatabase } from './helpers'

/**
 * Settings and connection-test specs. Provider HTTP is stubbed, so the real
 * routes, validation, database writes and honest state derivation all run.
 */

const calls: string[] = []

type Reply = { status: number; body?: unknown }

function installFetch(handler: (url: string) => Reply): void {
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push(url)
    const reply = handler(url)
    return Promise.resolve(
      new Response(JSON.stringify(reply.body ?? {}), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    )
  })
}

function openRouterOk(): Reply {
  return {
    status: 200,
    body: {
      id: 'gen-1',
      model: 'openrouter/model-a',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    },
  }
}

function modelsOk(): Reply {
  return {
    status: 200,
    body: {
      data: [
        { id: 'openrouter/free-a', pricing: { prompt: '0', completion: '0' } },
        { id: 'openrouter/paid-b', pricing: { prompt: '0.001', completion: '0.002' } },
      ],
    },
  }
}

const ENV = { OPENROUTER_API_KEY: 'super-secret-openrouter-key' }

interface ProviderShape {
  id: string
  configured: boolean
  state: string
  models: Array<{ id: string; free: string }>
  lastTestAt: string | null
  keyEnvVars: string[]
}

beforeEach(() => {
  calls.length = 0
  return resetDatabase()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AI provider settings and tests', () => {
  it('reports every provider as not configured without a key, and never "online"', async () => {
    const response = await call(AUTHOR, '/api/ai/providers')
    expect(response.status).toBe(200)
    const body = await json<{ providers: ProviderShape[] }>(response)
    const ids = body.providers.map((provider) => provider.id)
    expect(ids).toEqual(expect.arrayContaining(['openrouter', 'nvidia', 'google', 'baseten']))
    for (const provider of body.providers) {
      expect(provider.state).toBe('not_configured')
      expect(provider.configured).toBe(false)
    }
  })

  it('marks a keyed provider configured_unverified until a real test succeeds', async () => {
    const configured = await json<{ providers: ProviderShape[] }>(await call(AUTHOR, '/api/ai/providers', {}, ENV))
    const openrouter = configured.providers.find((provider) => provider.id === 'openrouter')
    expect(openrouter?.configured).toBe(true)
    expect(openrouter?.state).toBe('configured_unverified')

    installFetch((url) => (url.endsWith('/chat/completions') ? openRouterOk() : modelsOk()))
    const test = await call(AUTHOR, '/api/ai/providers/openrouter/test', { method: 'POST', body: '{}' }, ENV)
    expect(test.status).toBe(200)
    const result = await json<{ result: { ok: boolean; models: string[]; requestId: string | null } }>(test)
    expect(result.result.ok).toBe(true)
    expect(result.result.models).toContain('openrouter/free-a')
    expect(result.result.requestId).toBe('gen-1')

    const after = await json<{ providers: ProviderShape[] }>(await call(AUTHOR, '/api/ai/providers', {}, ENV))
    const verified = after.providers.find((provider) => provider.id === 'openrouter')
    expect(verified?.state).toBe('connected_verified')
    expect(verified?.lastTestAt).toBeTruthy()
  })

  it('records a rejected key as failed and never leaks the key value', async () => {
    installFetch(() => ({ status: 401, body: { error: { message: 'Invalid API key' } } }))
    const test = await call(AUTHOR, '/api/ai/providers/openrouter/test', { method: 'POST', body: '{}' }, ENV)
    expect(test.status).toBe(502)
    const raw = await test.text()
    expect(raw).not.toContain('super-secret-openrouter-key')
    const body = JSON.parse(raw) as { result: { ok: boolean; code: string } }
    expect(body.result.ok).toBe(false)
    expect(body.result.code).toBe('provider_unauthorized')

    const after = await json<{ providers: ProviderShape[] }>(await call(AUTHOR, '/api/ai/providers', {}, ENV))
    expect(after.providers.find((provider) => provider.id === 'openrouter')?.state).toBe('failed')
  })

  it('discovers models from the provider and caches them with a cost policy', async () => {
    installFetch(() => modelsOk())
    const response = await call(AUTHOR, '/api/ai/providers/openrouter/models', { method: 'POST', body: '{}' }, ENV)
    expect(response.status).toBe(200)
    const body = await json<{ models: Array<{ id: string; free: string }> }>(response)
    expect(body.models.map((model) => model.id)).toEqual(['openrouter/free-a', 'openrouter/paid-b'])
    expect(body.models.find((model) => model.id === 'openrouter/free-a')?.free).toBe('free')
    expect(body.models.find((model) => model.id === 'openrouter/paid-b')?.free).toBe('paid')

    const providers = await json<{ providers: ProviderShape[] }>(await call(AUTHOR, '/api/ai/providers', {}, ENV))
    const openrouter = providers.providers.find((provider) => provider.id === 'openrouter')
    expect(openrouter?.models.map((model) => model.id)).toContain('openrouter/free-a')
  })

  it('stores Director AI and Script AI provider/model choices independently', async () => {
    const director = await call(AUTHOR, '/api/ai/settings', {
      method: 'PUT',
      body: JSON.stringify({ role: 'director', provider: 'openrouter', model: 'openrouter/director-model' }),
    })
    expect(director.status).toBe(200)
    const script = await call(AUTHOR, '/api/ai/settings', {
      method: 'PUT',
      body: JSON.stringify({
        role: 'script',
        provider: 'google',
        model: 'gemini-manual-id',
        fallbacks: [{ provider: 'openrouter', model: 'openrouter/fallback' }],
      }),
    })
    expect(script.status).toBe(200)

    const settings = await json<{
      roles: Array<{ role: string; provider: string | null; model: string | null; fallbacks: unknown[] }>
    }>(await call(AUTHOR, '/api/ai/settings'))
    const directorRole = settings.roles.find((role) => role.role === 'director')
    const scriptRole = settings.roles.find((role) => role.role === 'script')
    expect(directorRole?.provider).toBe('openrouter')
    expect(directorRole?.model).toBe('openrouter/director-model')
    // A manually entered model id is accepted even when discovery has not run.
    expect(scriptRole?.provider).toBe('google')
    expect(scriptRole?.model).toBe('gemini-manual-id')
    expect(scriptRole?.fallbacks).toHaveLength(1)
  })

  it('rejects an unknown role', async () => {
    const response = await call(AUTHOR, '/api/ai/settings', {
      method: 'PUT',
      body: JSON.stringify({ role: 'marketing' }),
    })
    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({ code: 'bad_request' })
  })

  it('probes capabilities with real requests and records only what worked', async () => {
    installFetch((url) => {
      if (url.endsWith('/chat/completions')) return openRouterOk()
      if (url.includes('/models')) return modelsOk()
      return { status: 404, body: {} }
    })
    const response = await call(
      AUTHOR,
      '/api/ai/providers/openrouter/probe',
      { method: 'POST', body: JSON.stringify({ model: 'openrouter/model-a' }) },
      ENV,
    )
    expect(response.status).toBe(200)
    const body = await json<{ result: { structuredOutput: boolean; streaming: boolean; tools: boolean } }>(response)
    // The stubbed non-streaming JSON answer has no tool call and no stream, so
    // those capabilities stay false rather than being claimed.
    expect(body.result.streaming).toBe(false)
    expect(body.result.tools).toBe(false)
  })
})

