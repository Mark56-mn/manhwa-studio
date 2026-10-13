import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AiRoutingError, runAiTask } from '../worker/ai/router'
import { saveRoleSettings } from '../worker/ai/settings'
import { ensureUser } from '../worker/db'
import { AUTHOR, call, createEpisode, createProject, json, resetDatabase, testEnv } from './helpers'

import type { Env } from '../worker/env'

/**
 * Router failover tests. The providers are stubbed at the HTTP boundary, so the
 * router's own selection, failover, policy, retry and cooldown logic runs for
 * real. No live provider is contacted.
 */

interface Recorded {
  url: string
  body: Record<string, unknown> | null
}

const calls: Recorded[] = []

type Reply = { status: number; body?: unknown }

function installFetch(handler: (url: string, body: Record<string, unknown> | null) => Reply): void {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    let body: Record<string, unknown> | null = null
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>
      } catch {
        body = null
      }
    }
    calls.push({ url, body })
    const reply = handler(url, body)
    return Promise.resolve(
      new Response(JSON.stringify(reply.body ?? {}), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    )
  })
}

function openAiReply(text: string, model: string): Reply {
  return {
    status: 200,
    body: {
      id: 'gen-1',
      model,
      choices: [{ message: { content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    },
  }
}

const PLAN_JSON = JSON.stringify({
  title: 'Episode',
  objective: 'Advance the arc',
  beats: [{ index: 1, summary: 'The reunion', sceneIntent: 'Rooftop', characters: ['Mina'], emotionalBeat: 'relief' }],
  sceneCount: 1,
  imageNotes: 'rain',
  voiceNotes: 'quiet',
  continuityWatch: ['pendant missing'],
})

const PROVIDERS_ENV = {
  OPENROUTER_API_KEY: 'openrouter-test-key',
  NVIDIA_API_KEY: 'nvidia-test-key',
}

beforeEach(() => {
  calls.length = 0
  return resetDatabase()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function configureRole(
  role: 'director' | 'script',
  provider: string,
  model: string,
  fallbacks: Array<{ provider: string; model: string }> = [],
  allowPaid = false,
): Promise<void> {
  const response = await call(AUTHOR, '/api/ai/settings', {
    method: 'PUT',
    body: JSON.stringify({ role, provider, model, fallbacks, allowPaid }),
  })
  expect(response.status).toBe(200)
}

describe('AI task router over HTTP', () => {
  it('fails over from the preferred provider to a different compatible model', async () => {
    const project = await createProject(AUTHOR)
    const episode = await createEpisode(AUTHOR, project.id)
    await configureRole('director', 'openrouter', 'openrouter/model-a', [
      { provider: 'nvidia', model: 'nvidia/model-b' },
    ])

    // The owner verifies the fallback model is zero-cost, so failover is allowed
    // without authorising paid use.
    const cost = await call(AUTHOR, '/api/ai/models/cost', {
      method: 'POST',
      body: JSON.stringify({ provider: 'nvidia', model: 'nvidia/model-b', free: 'free' }),
    })
    expect(cost.status).toBe(200)

    installFetch((url) => {
      if (url.includes('openrouter.ai')) return { status: 503, body: { error: { message: 'provider overloaded' } } }
      if (url.includes('integrate.api.nvidia.com')) return openAiReply(PLAN_JSON, 'nvidia/model-b')
      return { status: 404, body: { error: { message: `unexpected ${url}` } } }
    })

    const response = await call(
      AUTHOR,
      `/api/episodes/${episode.id}/director/plan`,
      { method: 'POST', body: '{}' },
      PROVIDERS_ENV,
    )
    expect(response.status).toBe(201)
    const body = await json<{ plan: { provider: string; model: string; parseState: string }; failovers: number }>(
      response,
    )
    expect(body.plan.provider).toBe('nvidia')
    expect(body.plan.model).toBe('nvidia/model-b')
    expect(body.plan.parseState).toBe('parsed')
    expect(body.failovers).toBe(1)

    // The failover really invoked a different provider/model.
    const hosts = calls.map((entry) => new URL(entry.url).host)
    expect(hosts).toContain('openrouter.ai')
    expect(hosts).toContain('integrate.api.nvidia.com')
    expect(calls.find((entry) => entry.url.includes('nvidia'))?.body?.model).toBe('nvidia/model-b')
  })

  it('never fails over to a paid model unless paid use is authorised', async () => {
    const project = await createProject(AUTHOR)
    const episode = await createEpisode(AUTHOR, project.id)
    await configureRole('director', 'openrouter', 'openrouter/model-a', [
      { provider: 'nvidia', model: 'nvidia/expensive-model' },
    ])

    // The owner marks the fallback model as paid (verified, not assumed).
    const cost = await call(AUTHOR, '/api/ai/models/cost', {
      method: 'POST',
      body: JSON.stringify({ provider: 'nvidia', model: 'nvidia/expensive-model', free: 'paid' }),
    })
    expect(cost.status).toBe(200)

    installFetch((url) => {
      if (url.includes('openrouter.ai')) return { status: 503, body: { error: { message: 'down' } } }
      if (url.includes('integrate.api.nvidia.com')) return openAiReply(PLAN_JSON, 'nvidia/expensive-model')
      return { status: 404, body: {} }
    })

    const blocked = await call(
      AUTHOR,
      `/api/episodes/${episode.id}/director/plan`,
      { method: 'POST', body: '{}' },
      PROVIDERS_ENV,
    )
    expect(blocked.status).toBe(502)
    // The paid provider was never actually called.
    expect(calls.some((entry) => entry.url.includes('integrate.api.nvidia.com'))).toBe(false)

    const router = await json<{ recentFailures: Array<{ errorCode: string }> }>(
      await call(AUTHOR, '/api/ai/router', {}, PROVIDERS_ENV),
    )
    expect(router.recentFailures.some((failure) => failure.errorCode === 'paid_not_authorised')).toBe(true)

    // Explicit authorisation lets the same fallback run.
    await configureRole(
      'director',
      'openrouter',
      'openrouter/model-a',
      [{ provider: 'nvidia', model: 'nvidia/expensive-model' }],
      true,
    )
    const allowed = await call(
      AUTHOR,
      `/api/episodes/${episode.id}/director/plan`,
      { method: 'POST', body: '{}' },
      PROVIDERS_ENV,
    )
    expect(allowed.status).toBe(201)
    expect((await json<{ plan: { provider: string } }>(allowed)).plan.provider).toBe('nvidia')
  })

  it('stops with a clear error when no provider is configured at all', async () => {
    const project = await createProject(AUTHOR)
    const episode = await createEpisode(AUTHOR, project.id)

    const response = await call(AUTHOR, `/api/episodes/${episode.id}/director/plan`, { method: 'POST', body: '{}' }, {})
    expect(response.status).toBe(503)
    const body = await json<{ code: string; details: { missingEnvVars: string[] } }>(response)
    expect(body.code).toBe('provider_not_configured')
    expect(body.details.missingEnvVars).toContain('DIRECTOR_PROVIDER')
    expect(calls).toHaveLength(0)
  })

  it('records the exact provider/model that completed a task', async () => {
    const project = await createProject(AUTHOR)
    const episode = await createEpisode(AUTHOR, project.id)
    await configureRole('script', 'openrouter', 'openrouter/model-a')

    installFetch((url) =>
      url.includes('openrouter.ai')
        ? openAiReply(
            JSON.stringify({ title: 'T', logline: 'L', scenes: [{ heading: 'S1', narration: 'n' }] }),
            'openrouter/model-a',
          )
        : { status: 404, body: {} },
    )

    const response = await call(
      AUTHOR,
      `/api/episodes/${episode.id}/scripts`,
      { method: 'POST', body: '{}' },
      PROVIDERS_ENV,
    )
    expect(response.status).toBe(201)
    const body = await json<{ script: { provider: string; model: string } }>(response)
    expect(body.script.provider).toBe('openrouter')
    expect(body.script.model).toBe('openrouter/model-a')

    const router = await json<{ lastActive: { provider: string; model: string | null } | null }>(
      await call(AUTHOR, '/api/ai/router', {}, PROVIDERS_ENV),
    )
    expect(router.lastActive?.provider).toBe('openrouter')
  })
})


async function configure(role: 'director' | 'script', patch: Parameters<typeof saveRoleSettings>[3]): Promise<void> {
  const db = (env as unknown as Env).DB
  await ensureUser(db, AUTHOR)
  await saveRoleSettings(db, AUTHOR.sub, role, patch)
}

function routerEnv(extra: Partial<Env> = {}): Env {
  return testEnv({ OPENROUTER_API_KEY: 'openrouter-key', NVIDIA_API_KEY: 'nvidia-key', ...extra })
}

function scriptParams(requirements?: Partial<{ structured: boolean; tools: boolean; streaming: boolean; minContext: number | null }>) {
  return {
    role: 'script' as const,
    task: 'script' as const,
    ownerId: AUTHOR.sub,
    requirements: { structured: false, tools: false, streaming: false, minContext: null, ...requirements },
    messages: [{ role: 'user' as const, content: 'hi' }],
    validate: () => ({ ok: true, detail: 'ok' }),
  }
}

describe('AI task router internals (mocked HTTP)', () => {
  it('retries a transient outage once on the same model, then fails over', async () => {
    const db = (env as unknown as Env).DB
    await configure('script', {
      provider: 'openrouter',
      model: 'openrouter/model-a',
      fallbacks: [{ provider: 'nvidia', model: 'nvidia/model-b' }],
      allowPaid: true,
    })

    installFetch((url) => {
      if (url.includes('openrouter.ai')) return { status: 503, body: { error: { message: 'down' } } }
      if (url.includes('integrate.api.nvidia.com')) return openAiReply('recovered', 'nvidia/model-b')
      return { status: 404, body: {} }
    })

    const result = await runAiTask(routerEnv(), db, scriptParams())
    expect(result.provider).toBe('nvidia')
    expect(result.failovers).toBe(1)
    // Bounded retry: the transient failure was retried once before failover.
    expect(calls.filter((entry) => entry.url.includes('openrouter.ai'))).toHaveLength(2)
    expect(calls.filter((entry) => entry.url.includes('nvidia'))).toHaveLength(1)
  })

  it('does not retry a permanent invalid-request error', async () => {
    const db = (env as unknown as Env).DB
    await configure('script', { provider: 'openrouter', model: 'openrouter/model-a' })

    installFetch((url) =>
      url.includes('openrouter.ai')
        ? { status: 400, body: { error: { message: 'invalid request' } } }
        : { status: 404, body: {} },
    )

    await expect(runAiTask(routerEnv(), db, scriptParams())).rejects.toMatchObject({
      code: 'provider_invalid_request',
    })
    expect(calls).toHaveLength(1)
  })

  it('gates tool-calling tasks on a verified capability and never calls the model', async () => {
    const db = (env as unknown as Env).DB
    await configure('script', { provider: 'openrouter', model: 'openrouter/model-a' })
    installFetch(() => ({ status: 200, body: openAiReply('should not be called', 'openrouter/model-a') }))

    try {
      await runAiTask(routerEnv(), db, scriptParams({ tools: true }))
      throw new Error('expected the router to refuse a tools task')
    } catch (error) {
      expect(error).toBeInstanceOf(AiRoutingError)
      const routing = error as AiRoutingError
      expect(routing.attempts[0]?.errorCode).toBe('provider_capability_unsupported')
    }
    expect(calls).toHaveLength(0)
  })

  it('pauses a failed model (cooldown) on the next attempt', async () => {
    const db = (env as unknown as Env).DB
    await configure('script', { provider: 'openrouter', model: 'openrouter/model-a' })
    installFetch((url) =>
      url.includes('openrouter.ai')
        ? { status: 401, body: { error: { message: 'invalid key' } } }
        : { status: 404, body: {} },
    )

    await expect(runAiTask(routerEnv(), db, scriptParams())).rejects.toMatchObject({ code: 'provider_unauthorized' })
    const callsAfterFirst = calls.length

    try {
      await runAiTask(routerEnv(), db, scriptParams())
      throw new Error('expected the router to skip the cooling model')
    } catch (error) {
      const routing = error as AiRoutingError
      expect(routing.attempts[0]?.errorCode).toBe('cooldown')
    }
    // The cooling model was skipped without another HTTP call.
    expect(calls.length).toBe(callsAfterFirst)
  })
})

