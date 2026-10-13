import { beforeEach, describe, expect, it } from 'vitest'

import { AUTHOR, OTHER, call, createProject, json, resetDatabase } from './helpers'

beforeEach(resetDatabase)

describe('projects API', () => {
  it('requires a signed-in account', async () => {
    const response = await call(null, '/api/projects')
    expect(response.status).toBe(401)
    expect(await json(response)).toMatchObject({ code: 'unauthenticated' })
    expect(response.headers.get('cache-control')).toBe('private, no-store')
  })

  it('creates a project, lists it, and records honest activity', async () => {
    const created = await createProject(AUTHOR, 'Crimson Pact')
    expect(created.id).toMatch(/^prj_/)

    const list = await json<{ projects: Array<{ title: string; episodeCount: number; status: string }>; total: number }>(
      await call(AUTHOR, '/api/projects'),
    )
    expect(list.total).toBe(1)
    expect(list.projects[0]).toMatchObject({ title: 'Crimson Pact', episodeCount: 0, status: 'development' })

    const detail = await json<{ project: { id: string }; activity: Array<{ eventType: string }> }>(
      await call(AUTHOR, `/api/projects/${created.id}`),
    )
    expect(detail.project.id).toBe(created.id)
    expect(detail.activity).toHaveLength(1)
    expect(detail.activity[0]!.eventType).toBe('project.created')
  })

  it('rejects invalid and unknown input instead of writing it', async () => {
    const missingTitle = await call(AUTHOR, '/api/projects', { method: 'POST', body: JSON.stringify({}) })
    expect(missingTitle.status).toBe(400)
    const details = await json<{ details: Array<{ field: string }> }>(missingTitle)
    expect(details.details.map((entry) => entry.field)).toContain('title')

    const unknownField = await call(AUTHOR, '/api/projects', {
      method: 'POST',
      body: JSON.stringify({ title: 'Ok', sneaky: true }),
    })
    expect(unknownField.status).toBe(400)

    const badStatus = await call(AUTHOR, '/api/projects', {
      method: 'POST',
      body: JSON.stringify({ title: 'Ok', status: 'published' }),
    })
    expect(badStatus.status).toBe(400)

    expect((await json<{ total: number }>(await call(AUTHOR, '/api/projects'))).total).toBe(0)
  })

  it('rejects malformed JSON with 400', async () => {
    const response = await call(AUTHOR, '/api/projects', { method: 'POST', body: '{not json' })
    expect(response.status).toBe(400)
  })

  it('persists story-bible edits and reports which fields changed', async () => {
    const project = await createProject(AUTHOR, 'Long Road')
    const patched = await json<{ project: { storyBible: string; logline: string }; changed: string[] }>(
      await call(AUTHOR, `/api/projects/${project.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ storyBible: 'World rules: no magic after dusk.', logline: 'A courier races the dark.' }),
      }),
    )
    expect(patched.changed.sort()).toEqual(['logline', 'storyBible'])
    expect(patched.project.storyBible).toBe('World rules: no magic after dusk.')

    const reread = await json<{ project: { storyBible: string } }>(await call(AUTHOR, `/api/projects/${project.id}`))
    expect(reread.project.storyBible).toBe('World rules: no magic after dusk.')
  })

  it('keeps one owner from reaching another owner’s project', async () => {
    const mine = await createProject(AUTHOR, 'Private Story')

    const otherList = await json<{ projects: unknown[]; total: number }>(await call(OTHER, '/api/projects'))
    expect(otherList.total).toBe(0)
    expect(otherList.projects).toHaveLength(0)

    expect((await call(OTHER, `/api/projects/${mine.id}`)).status).toBe(404)
    expect(
      (await call(OTHER, `/api/projects/${mine.id}`, { method: 'PATCH', body: JSON.stringify({ title: 'Hijacked' }) }))
        .status,
    ).toBe(404)
    expect((await call(OTHER, `/api/projects/${mine.id}`, { method: 'DELETE' })).status).toBe(404)

    // The owner still sees the untouched project.
    const detail = await json<{ project: { title: string } }>(await call(AUTHOR, `/api/projects/${mine.id}`))
    expect(detail.project.title).toBe('Private Story')
  })

  it('rejects state-changing requests from another origin', async () => {
    const response = await call(AUTHOR, '/api/projects', {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
      body: JSON.stringify({ title: 'CSRF' }),
    })
    expect(response.status).toBe(403)
    expect(await json(response)).toMatchObject({ code: 'cross_origin' })
  })

  it('accepts state-changing requests marked same-site without an Origin header', async () => {
    const response = await call(AUTHOR, '/api/projects', {
      method: 'POST',
      headers: { Origin: '', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ title: 'Same site' }),
    })
    expect(response.status).toBe(201)
  })

  it('deletes a project and everything underneath it', async () => {
    const project = await createProject(AUTHOR, 'Disposable')
    await call(AUTHOR, `/api/projects/${project.id}/episodes`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Episode 1' }),
    })
    expect((await call(AUTHOR, `/api/projects/${project.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await call(AUTHOR, `/api/projects/${project.id}`)).status).toBe(404)
    expect((await json<{ total: number }>(await call(AUTHOR, '/api/projects'))).total).toBe(0)
  })

  it('answers unknown API routes with JSON 404', async () => {
    const response = await call(AUTHOR, '/api/nope')
    expect(response.status).toBe(404)
    expect(await json(response)).toMatchObject({ code: 'not_found' })
  })
})

describe('episodes, seasons and characters', () => {
  it('numbers episodes automatically and refuses duplicates', async () => {
    const project = await createProject(AUTHOR, 'Series')

    const first = await json<{ episode: { episodeNumber: number; status: string } }>(
      await call(AUTHOR, `/api/projects/${project.id}/episodes`, {
        method: 'POST',
        body: JSON.stringify({ title: 'The Gate' }),
      }),
    )
    expect(first.episode).toMatchObject({ episodeNumber: 1, status: 'planned' })

    const second = await json<{ episode: { episodeNumber: number } }>(
      await call(AUTHOR, `/api/projects/${project.id}/episodes`, {
        method: 'POST',
        body: JSON.stringify({ title: 'The Vault', episodeNumber: 2 }),
      }),
    )
    expect(second.episode.episodeNumber).toBe(2)

    const clash = await call(AUTHOR, `/api/projects/${project.id}/episodes`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Duplicate', episodeNumber: 2 }),
    })
    expect(clash.status).toBe(409)

    const list = await json<{ episodes: Array<{ episodeNumber: number }> }>(
      await call(AUTHOR, `/api/projects/${project.id}/episodes`),
    )
    expect(list.episodes.map((episode) => episode.episodeNumber)).toEqual([1, 2])
  })

  it('updates episode status through the review stages and rejects unknown statuses', async () => {
    const project = await createProject(AUTHOR, 'Series')
    const created = await json<{ episode: { id: string } }>(
      await call(AUTHOR, `/api/projects/${project.id}/episodes`, {
        method: 'POST',
        body: JSON.stringify({ title: 'Pilot' }),
      }),
    )

    const patched = await json<{ episode: { status: string }; changed: string[] }>(
      await call(AUTHOR, `/api/episodes/${created.episode.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'script_review' }),
      }),
    )
    expect(patched.episode.status).toBe('script_review')
    expect(patched.changed).toEqual(['status'])

    const bad = await call(AUTHOR, `/api/episodes/${created.episode.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'rendered' }),
    })
    expect(bad.status).toBe(400)
  })

  it('hides episodes belonging to another owner', async () => {
    const project = await createProject(AUTHOR, 'Series')
    const created = await json<{ episode: { id: string } }>(
      await call(AUTHOR, `/api/projects/${project.id}/episodes`, {
        method: 'POST',
        body: JSON.stringify({ title: 'Pilot' }),
      }),
    )
    expect((await call(OTHER, `/api/episodes/${created.episode.id}`)).status).toBe(404)
    expect((await call(OTHER, `/api/projects/${project.id}/episodes`)).status).toBe(404)
    expect(
      (await call(OTHER, `/api/episodes/${created.episode.id}`, { method: 'PATCH', body: JSON.stringify({ title: 'x' }) }))
        .status,
    ).toBe(404)
    expect((await call(OTHER, `/api/episodes/${created.episode.id}`, { method: 'DELETE' })).status).toBe(404)
  })

  it('tracks seasons and characters per project', async () => {
    const project = await createProject(AUTHOR, 'Series')

    const season = await json<{ season: { seasonNumber: number } }>(
      await call(AUTHOR, `/api/projects/${project.id}/seasons`, {
        method: 'POST',
        body: JSON.stringify({ title: 'Origin' }),
      }),
    )
    expect(season.season.seasonNumber).toBe(1)
    const seasonClash = await call(AUTHOR, `/api/projects/${project.id}/seasons`, {
      method: 'POST',
      body: JSON.stringify({ seasonNumber: 1 }),
    })
    expect(seasonClash.status).toBe(409)

    const character = await json<{ character: { name: string; role: string } }>(
      await call(AUTHOR, `/api/projects/${project.id}/characters`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Sora', role: 'protagonist', description: 'Courier with a debt.' }),
      }),
    )
    expect(character.character).toMatchObject({ name: 'Sora', role: 'protagonist' })

    const characterClash = await call(AUTHOR, `/api/projects/${project.id}/characters`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Sora' }),
    })
    expect(characterClash.status).toBe(409)

    const detail = await json<{ seasons: unknown[]; characters: unknown[] }>(
      await call(AUTHOR, `/api/projects/${project.id}`),
    )
    expect(detail.seasons).toHaveLength(1)
    expect(detail.characters).toHaveLength(1)
  })

  it('records owner actions in the activity feed for the owner only', async () => {
    const project = await createProject(AUTHOR, 'Series')
    await call(AUTHOR, `/api/projects/${project.id}/episodes`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Pilot' }),
    })

    const feed = await json<{ events: Array<{ eventType: string; summary: string }> }>(
      await call(AUTHOR, '/api/activity'),
    )
    expect(feed.events.map((event) => event.eventType)).toContain('episode.created')
    expect((await json<{ events: unknown[] }>(await call(OTHER, '/api/activity'))).events).toHaveLength(0)
  })
})

describe('integrations reporting', () => {
  it('never claims an unconfigured provider is connected', async () => {
    const body = await json<{
      capabilities: Array<{ id: string; state: string; requiredEnvVars: string[]; presentEnvVars: string[] }>
      secretsPolicy: { envVarNamesOnly: boolean }
    }>(await call(AUTHOR, '/api/integrations'))

    expect(body.capabilities.map((capability) => capability.id)).toEqual([
      'script',
      'image',
      'voice',
      'video',
      'youtube',
      'media-storage',
    ])
    for (const capability of body.capabilities) {
      expect(capability.state).toBe('not_configured')
      expect(capability.presentEnvVars).toHaveLength(0)
    }
    expect(body.secretsPolicy.envVarNamesOnly).toBe(true)
    // No secret values can leak: the payload only ever carries variable names.
    expect(JSON.stringify(body)).not.toMatch(/api[_-]?key["'\s:]+[a-z0-9]{8}/i)
  })
})
