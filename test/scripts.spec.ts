import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AUTHOR, OTHER, PROVIDER_ENV, call, createEpisode, createProject, json, resetDatabase } from './helpers'

/**
 * These specs exercise the real script pipeline. The provider is the only thing
 * that is stubbed: outbound `fetch` is replaced, so the studio's own code
 * (configuration resolution, prompting, parsing, persistence, authorization)
 * runs for real against a real D1.
 */

interface ScriptSummaryShape {
  id: string
  version: number
  status: string
  provider: string
  model: string
  parseState: string
  parseDetail: string | null
  sceneCount: number
  characterCount: number
  inputTokens: number | null
  outputTokens: number | null
  createdAt: string
}

interface ScriptVersionShape extends ScriptSummaryShape {
  instructions: string
  rawText: string
  structured: { title?: string; scenes?: unknown[] } | null
}

interface CapabilityShape {
  id: string
  state: string
  detail: string
  implemented: boolean
  model?: string | null
  models?: string[]
  verifiedAt?: string | null
}

const SCRIPT_BODY = {
  title: 'The Rooftop',
  logline: 'A reunion that has been postponed for a year finally happens.',
  scenes: [
    {
      heading: 'SCENE 1 — Rooftop, dusk',
      description: 'Rain runs down the railing; the city glows below.',
      narration: 'She had waited a whole year for this roof.',
      dialogue: [{ speaker: 'Mina', line: 'You came.' }],
      imagePrompt: 'Mina, black hair, red coat, rooftop at dusk, rain, cinematic',
    },
    {
      heading: 'SCENE 2 — Street below',
      description: 'Neon reflections in the wet road.',
      narration: 'Below them the city simply continued.',
      dialogue: [],
      imagePrompt: 'Rainy neon street at night, wide shot, no characters',
    },
  ],
  continuityNotes: 'The pendant is still missing.',
}

type FetchReply = { status: number; body: unknown }
type Handler = (url: string, init: RequestInit) => FetchReply

const calls: string[] = []

/** Replaces the global fetch with a stub that answers provider endpoints. */
function installFetch(handler: Handler): void {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push(url)
    const reply = handler(url, init ?? {})
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    )
  })
}

function chatCompletion(content: string, model = 'gpt-6-luna'): FetchReply {
  return {
    status: 200,
    body: {
      model,
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 800 },
    },
  }
}

function chatOnly(content: string, status = 200): Handler {
  return (url) =>
    url.endsWith('/chat/completions')
      ? status === 200
        ? chatCompletion(content)
        : { status, body: { error: { message: content } } }
      : { status: 404, body: { error: { message: `unexpected call to ${url}` } } }
}

function modelsOnly(models: string[], status = 200): Handler {
  return (url) =>
    url.includes('/models')
      ? status === 200
        ? { status, body: { data: models.map((id) => ({ id, object: 'model' })) } }
        : { status, body: { error: { message: 'Invalid API key' } } }
      : { status: 404, body: { error: { message: `unexpected call to ${url}` } } }
}

beforeEach(() => {
  calls.length = 0
  return resetDatabase()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function setup() {
  const project = await createProject(AUTHOR)
  const episode = await createEpisode(AUTHOR, project.id)
  return { project, episode }
}

function generate(user = AUTHOR, episodeId: string, body: Record<string, unknown> = {}, env: Record<string, string> = PROVIDER_ENV) {
  return call(user, `/api/episodes/${episodeId}/scripts`, { method: 'POST', body: JSON.stringify(body) }, env)
}

describe('script generation', () => {
  it('refuses honestly when no provider is configured, naming the missing variables', async () => {
    const { episode } = await setup()
    const response = await generate(AUTHOR, episode.id, {}, {})
    expect(response.status).toBe(503)
    const body = await json<{ code: string; details: { missingEnvVars: string[] } }>(response)
    expect(body.code).toBe('provider_not_configured')
    expect(body.details.missingEnvVars).toContain('SCRIPT_PROVIDER')

    const versions = await json<{ scripts: ScriptSummaryShape[] }>(await call(AUTHOR, `/api/episodes/${episode.id}/scripts`))
    expect(versions.scripts).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('stores a parsed, versioned script and moves the episode to review', async () => {
    const { episode } = await setup()
    installFetch(chatOnly(JSON.stringify(SCRIPT_BODY)))

    const response = await generate(AUTHOR, episode.id, { instructions: 'Keep it quiet.' })
    expect(response.status).toBe(201)
    const body = await json<{
      script: ScriptVersionShape
      scenes: Array<{ index: number; heading: string; dialogue: Array<{ speaker: string }> }>
      providerLabel: string
      episodeStatus: string
    }>(response)

    expect(body.script.version).toBe(1)
    expect(body.script.status).toBe('draft')
    expect(body.script.parseState).toBe('parsed')
    expect(body.script.provider).toBe('openai')
    expect(body.script.model).toBe('gpt-6-luna')
    expect(body.script.instructions).toBe('Keep it quiet.')
    expect(body.script.inputTokens).toBe(120)
    expect(body.scenes.map((scene) => scene.index)).toEqual([1, 2])
    expect(body.scenes[0]?.dialogue[0]?.speaker).toBe('Mina')
    expect(body.episodeStatus).toBe('script_review')

    const detail = await json<{ script: ScriptVersionShape; scenes: unknown[] }>(
      await call(AUTHOR, `/api/scripts/${body.script.id}`),
    )
    expect(detail.scenes).toHaveLength(2)
    expect(detail.script.rawText).toContain('The Rooftop')
  })

  it('stores unparsed output verbatim instead of inventing scenes', async () => {
    const { episode } = await setup()
    installFetch(chatOnly('I am sorry, I cannot do that.'))

    const response = await generate(AUTHOR, episode.id)
    expect(response.status).toBe(201)
    const body = await json<{ script: ScriptVersionShape; scenes: unknown[] }>(response)
    expect(body.script.parseState).toBe('unparsed')
    expect(body.script.structured).toBeNull()
    expect(body.script.rawText).toBe('I am sorry, I cannot do that.')
    expect(body.script.parseDetail).toBeTruthy()
    expect(body.scenes).toHaveLength(0)
  })

  it('reports a provider failure and stores nothing', async () => {
    const { episode } = await setup()
    installFetch(chatOnly('You exceeded your current quota', 429))

    const response = await generate(AUTHOR, episode.id)
    // A quota/rate-limit failure is now reported with its precise code and a
    // 429 status, with the provider's own message preserved.
    expect(response.status).toBe(429)
    const body = await json<{ code: string; error: string }>(response)
    expect(body.code).toBe('provider_quota_exhausted')
    expect(body.error).toContain('quota')

    const versions = await json<{ scripts: ScriptSummaryShape[] }>(await call(AUTHOR, `/api/episodes/${episode.id}/scripts`))
    expect(versions.scripts).toHaveLength(0)
  })

  it('never overwrites an approved script: a new draft is a new version', async () => {
    const { episode } = await setup()
    installFetch(chatOnly(JSON.stringify(SCRIPT_BODY)))

    const first = await json<{ script: ScriptVersionShape }>(await generate(AUTHOR, episode.id))
    const approve = await call(AUTHOR, `/api/scripts/${first.script.id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved', note: 'Good to draw.' }),
    })
    expect(approve.status).toBe(200)
    const approved = await json<{ episodeStatus: string; approval: { decision: string } }>(approve)
    expect(approved.approval.decision).toBe('approved')
    expect(approved.episodeStatus).toBe('script_approved')

    const second = await json<{ script: ScriptVersionShape }>(await generate(AUTHOR, episode.id))
    expect(second.script.version).toBe(2)
    expect(second.script.id).not.toBe(first.script.id)

    // The approved version is untouched, still approved, and still has its text.
    const reloaded = await json<{
      script: ScriptVersionShape
      approvals: Array<{ note: string }>
    }>(await call(AUTHOR, `/api/scripts/${first.script.id}`))
    expect(reloaded.script.status).toBe('approved')
    expect(reloaded.script.rawText).toBe(first.script.rawText)
    expect(reloaded.approvals).toHaveLength(1)
    expect(reloaded.approvals[0]?.note).toBe('Good to draw.')

    const list = await json<{ scripts: ScriptSummaryShape[]; episodeStatus: string }>(
      await call(AUTHOR, `/api/episodes/${episode.id}/scripts`),
    )
    expect(list.scripts.map((entry) => entry.version)).toEqual([2, 1])
    expect(list.episodeStatus).toBe('script_review')
  })

  it('validates review decisions', async () => {
    const { episode } = await setup()
    installFetch(chatOnly(JSON.stringify(SCRIPT_BODY)))
    const created = await json<{ script: ScriptVersionShape }>(await generate(AUTHOR, episode.id))

    const bad = await call(AUTHOR, `/api/scripts/${created.script.id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'ship_it' }),
    })
    expect(bad.status).toBe(400)
    expect(await json(bad)).toMatchObject({ code: 'bad_request' })
  })

  it('keeps one owner from reaching another owner’s script', async () => {
    const { episode } = await setup()
    installFetch(chatOnly(JSON.stringify(SCRIPT_BODY)))
    const created = await json<{ script: ScriptVersionShape }>(await generate(AUTHOR, episode.id))

    expect((await call(OTHER, `/api/scripts/${created.script.id}`)).status).toBe(404)
    expect(
      (
        await call(OTHER, `/api/scripts/${created.script.id}/approve`, {
          method: 'POST',
          body: JSON.stringify({ decision: 'approved' }),
        })
      ).status,
    ).toBe(404)
    expect((await call(OTHER, `/api/episodes/${episode.id}/scripts`)).status).toBe(404)
  })

  it('requires a signed-in account and a same-origin request', async () => {
    const { episode } = await setup()
    expect((await call(null, `/api/episodes/${episode.id}/scripts`, { method: 'POST', body: '{}' })).status).toBe(401)

    const crossOrigin = await call(
      AUTHOR,
      `/api/episodes/${episode.id}/scripts`,
      { method: 'POST', body: '{}', headers: { Origin: 'https://evil.example' } },
      PROVIDER_ENV,
    )
    expect(crossOrigin.status).toBe(403)
  })
})

describe('provider verification', () => {
  it('flips the capability to connected_verified only after a real call', async () => {
    installFetch(modelsOnly(['gpt-6-luna', 'gpt-6.1-sol']))

    const response = await call(AUTHOR, '/api/integrations/script/verify', { method: 'POST' }, PROVIDER_ENV)
    expect(response.status).toBe(200)
    const body = await json<{ result: { ok: boolean; models: string[] } }>(response)
    expect(body.result.ok).toBe(true)
    expect(body.result.models).toEqual(['gpt-6-luna', 'gpt-6.1-sol'])
    expect(calls.length).toBeGreaterThan(0)

    const integrations = await json<{ capabilities: CapabilityShape[] }>(
      await call(AUTHOR, '/api/integrations', {}, PROVIDER_ENV),
    )
    const script = integrations.capabilities.find((capability) => capability.id === 'script')
    expect(script?.state).toBe('connected_verified')
    expect(script?.verifiedAt).toBeTruthy()
    expect(script?.models).toEqual(['gpt-6-luna', 'gpt-6.1-sol'])
  })

  it('records a failed call as failed rather than pretending it worked', async () => {
    installFetch(modelsOnly([], 401))

    const response = await call(AUTHOR, '/api/integrations/script/verify', { method: 'POST' }, PROVIDER_ENV)
    expect(response.status).toBe(502)
    const body = await json<{ result: { ok: boolean; code: string } }>(response)
    expect(body.result.ok).toBe(false)
    expect(body.result.code).toBe('provider_unauthorized')

    const integrations = await json<{ capabilities: CapabilityShape[] }>(
      await call(AUTHOR, '/api/integrations', {}, PROVIDER_ENV),
    )
    expect(integrations.capabilities.find((capability) => capability.id === 'script')?.state).toBe('failed')
  })

  it('reports configured_unverified before any real call was made', async () => {
    const integrations = await json<{ capabilities: CapabilityShape[] }>(
      await call(AUTHOR, '/api/integrations', {}, PROVIDER_ENV),
    )
    const script = integrations.capabilities.find((capability) => capability.id === 'script')
    expect(script?.state).toBe('configured_unverified')
    expect(script?.models).toEqual([])
  })

  it('refuses to verify a capability this build has no adapter for', async () => {
    const response = await call(AUTHOR, '/api/integrations/image/verify', { method: 'POST' })
    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({ code: 'capability_not_implemented', implemented: false })
  })
})
