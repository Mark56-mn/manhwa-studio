import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AUTHOR, OTHER, call, createEpisode, createProject, json, resetDatabase } from './helpers'

/**
 * Object-storage specs. These run against the real R2 binding provided to
 * workerd by the test pool, so bytes genuinely round-trip through the bucket
 * and the `assets` table genuinely holds only metadata.
 */

interface AssetShape {
  id: string
  projectId: string
  episodeId: string | null
  kind: string
  name: string
  contentType: string
  byteSize: number
  checksum: string | null
  status: string
  metadata: Record<string, unknown>
  contentPath: string
}

interface UploadOptions {
  kind?: string
  name?: string
  type?: string
  bytes?: Uint8Array
  episodeId?: string
  metadata?: Record<string, unknown>
  contentType?: string
}

async function upload(
  user = AUTHOR,
  projectId: string,
  options: UploadOptions = {},
): Promise<Response> {
  const {
    kind = 'image',
    name = 'art.png',
    type = 'image/png',
    bytes = new Uint8Array([1, 2, 3, 4]),
    episodeId,
    metadata,
    contentType,
  } = options
  const form = new FormData()
  form.set('kind', kind)
  form.set('name', name)
  form.set('file', new File([bytes], name, { type }))
  if (episodeId) form.set('episodeId', episodeId)
  if (metadata) form.set('metadata', JSON.stringify(metadata))
  if (contentType) form.set('contentType', contentType)
  return call(user, `/api/projects/${projectId}/assets`, { method: 'POST', body: form })
}

beforeEach(() => resetDatabase())
afterEach(() => vi.unstubAllGlobals())

describe('asset storage', () => {
  it('stores bytes in the bucket, metadata in D1, and streams the bytes back', async () => {
    const project = await createProject(AUTHOR)
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

    const response = await upload(AUTHOR, project.id, { bytes, metadata: { scene: 3 } })
    expect(response.status).toBe(201)
    const body = await json<{ asset: AssetShape }>(response)
    expect(body.asset.kind).toBe('image')
    expect(body.asset.contentType).toBe('image/png')
    expect(body.asset.byteSize).toBe(bytes.byteLength)
    expect(body.asset.checksum).toHaveLength(64)
    expect(body.asset.status).toBe('stored')
    expect(body.asset.metadata).toEqual({ scene: 3 })

    // The stored key is server-generated and never contains the filename.
    const row = await json<{ asset: AssetShape }>(
      await call(AUTHOR, `/api/assets/${body.asset.id}`),
    )
    expect(row.asset.id).toBe(body.asset.id)

    const content = await call(AUTHOR, body.asset.contentPath)
    expect(content.status).toBe(200)
    expect(content.headers.get('content-type')).toBe('image/png')
    expect(content.headers.get('cache-control')).toBe('private, no-store')
    const readBack = new Uint8Array(await content.arrayBuffer())
    expect([...readBack]).toEqual([...bytes])
  })

  it('lists assets for a project and filters by kind', async () => {
    const project = await createProject(AUTHOR)
    await upload(AUTHOR, project.id, { kind: 'image', name: 'a.png' })
    await upload(AUTHOR, project.id, { kind: 'audio', name: 'b.mp3', type: 'audio/mpeg' })

    const all = await json<{ assets: AssetShape[] }>(await call(AUTHOR, `/api/projects/${project.id}/assets`))
    expect(all.assets).toHaveLength(2)

    const images = await json<{ assets: AssetShape[] }>(
      await call(AUTHOR, `/api/projects/${project.id}/assets?kind=image`),
    )
    expect(images.assets.map((asset) => asset.name)).toEqual(['a.png'])
  })

  it('attaches an asset to an episode and lists it there', async () => {
    const project = await createProject(AUTHOR)
    const episode = await createEpisode(AUTHOR, project.id)

    const created = await json<{ asset: AssetShape }>(
      await upload(AUTHOR, project.id, { episodeId: episode.id, name: 'scene-1.png' }),
    )
    expect(created.asset.episodeId).toBe(episode.id)

    const listed = await json<{ assets: AssetShape[] }>(await call(AUTHOR, `/api/episodes/${episode.id}/assets`))
    expect(listed.assets.map((asset) => asset.id)).toEqual([created.asset.id])
  })

  it('deletes the object and hides the content afterwards', async () => {
    const project = await createProject(AUTHOR)
    const created = await json<{ asset: AssetShape }>(await upload(AUTHOR, project.id))

    const deleted = await call(AUTHOR, `/api/assets/${created.asset.id}`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect((await json<{ asset: AssetShape }>(deleted)).asset.status).toBe('deleted')

    expect((await call(AUTHOR, created.asset.contentPath)).status).toBe(404)
    const list = await json<{ assets: AssetShape[] }>(await call(AUTHOR, `/api/projects/${project.id}/assets`))
    expect(list.assets).toHaveLength(0)
  })
})

describe('asset validation and isolation', () => {
  it('rejects an unknown kind', async () => {
    const project = await createProject(AUTHOR)
    const response = await upload(AUTHOR, project.id, { kind: 'hologram' })
    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({ code: 'bad_request' })
  })

  it('rejects a content type that does not match the kind', async () => {
    const project = await createProject(AUTHOR)
    const response = await upload(AUTHOR, project.id, { kind: 'image', type: 'text/plain' })
    expect(response.status).toBe(415)
    expect(await json(response)).toMatchObject({ code: 'unsupported_media_type' })
  })

  it('rejects a file over the per-kind limit', async () => {
    const project = await createProject(AUTHOR)
    // A caption's limit is 512 KiB; send 600 KiB.
    const oversized = new Uint8Array(600 * 1024)
    const response = await upload(AUTHOR, project.id, {
      kind: 'caption',
      name: 'subs.srt',
      type: 'application/x-subrip',
      bytes: oversized,
    })
    expect(response.status).toBe(413)
    expect(await json(response)).toMatchObject({ code: 'payload_too_large' })
  })

  it('rejects metadata that is not a JSON object', async () => {
    const project = await createProject(AUTHOR)
    const form = new FormData()
    form.set('kind', 'image')
    form.set('file', new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }))
    form.set('metadata', '"just a string"')
    const response = await call(AUTHOR, `/api/projects/${project.id}/assets`, { method: 'POST', body: form })
    expect(response.status).toBe(400)
  })

  it('keeps one owner from reaching another owner’s asset', async () => {
    const project = await createProject(AUTHOR)
    const created = await json<{ asset: AssetShape }>(await upload(AUTHOR, project.id))

    expect((await call(OTHER, `/api/assets/${created.asset.id}`)).status).toBe(404)
    expect((await call(OTHER, created.asset.contentPath)).status).toBe(404)
    expect((await call(OTHER, `/api/assets/${created.asset.id}`, { method: 'DELETE' })).status).toBe(404)
    expect((await call(OTHER, `/api/projects/${project.id}/assets`)).status).toBe(404)
    expect((await upload(OTHER, project.id)).status).toBe(404)
  })

  it('requires a signed-in account and a same-origin request', async () => {
    const project = await createProject(AUTHOR)
    const form = new FormData()
    form.set('kind', 'image')
    form.set('file', new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }))

    expect((await call(null, `/api/projects/${project.id}/assets`, { method: 'POST', body: form })).status).toBe(401)

    const crossOrigin = await call(AUTHOR, `/api/projects/${project.id}/assets`, {
      method: 'POST',
      body: form,
      headers: { Origin: 'https://evil.example' },
    })
    expect(crossOrigin.status).toBe(403)
  })
})

describe('media-storage capability', () => {
  it('performs a real round-trip and only then reports connected_verified', async () => {
    const before = await json<{ capabilities: Array<{ id: string; state: string }> }>(
      await call(AUTHOR, '/api/integrations'),
    )
    const storage = before.capabilities.find((capability) => capability.id === 'media-storage')
    // A bucket is attached in the test runtime, but nothing has verified it yet.
    expect(storage?.state).toBe('configured_unverified')

    const response = await call(AUTHOR, '/api/storage/verify', { method: 'POST' })
    expect(response.status).toBe(200)
    const body = await json<{ result: { ok: boolean; detail: string }; capabilities: Array<{ id: string; state: string }> }>(
      response,
    )
    expect(body.result.ok).toBe(true)
    expect(body.result.detail).toContain('round-trip')

    const after = await json<{ capabilities: Array<{ id: string; state: string; verifiedAt?: string | null }> }>(
      await call(AUTHOR, '/api/integrations'),
    )
    const verified = after.capabilities.find((capability) => capability.id === 'media-storage')
    expect(verified?.state).toBe('connected_verified')
    expect(verified?.verifiedAt).toBeTruthy()
  })
})

