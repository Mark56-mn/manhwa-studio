import { Hono } from 'hono'

import { capabilityStatuses } from '../capabilities'
import { findEpisode, findProject } from '../db'
import { ASSET_KINDS } from '../lib/constants'
import { HttpError, badRequest, notFound } from '../lib/errors'
import { serializeAsset } from '../lib/rows'
import {
  MAX_ASSET_BYTES,
  deleteAsset,
  findAsset,
  listAssets,
  putAsset,
  readAssetObject,
  verifyStorage,
} from '../storage/service'

import type { AssetKind } from '../lib/constants'
import type { AppBindings } from '../app'

export const assetRoutes = new Hono<AppBindings>()

/** Multipart adds a boundary and headers; allow a little slack over the limit. */
const MAX_MULTIPART_BYTES = MAX_ASSET_BYTES + 1024 * 1024

function asKind(value: unknown): AssetKind {
  if (typeof value === 'string' && (ASSET_KINDS as readonly string[]).includes(value)) return value as AssetKind
  throw badRequest(`kind must be one of: ${ASSET_KINDS.join(', ')}`)
}

function optionalText(value: unknown, max = 4000): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed.slice(0, max) : null
}

function parseMetadata(value: unknown): Record<string, unknown> {
  const text = optionalText(value)
  if (!text) return {}
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through to the error below
  }
  throw badRequest('metadata must be a JSON object')
}

/** Uploads one file into the project's object-storage prefix. */
assetRoutes.post('/projects/:projectId/assets', async (c) => {
  const ownerId = c.get('user').sub
  const project = await findProject(c.env.DB, c.req.param('projectId'), ownerId)
  if (!project) throw notFound('Project not found')

  const declaredLength = Number.parseInt(c.req.header('content-length') ?? '', 10)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MULTIPART_BYTES) {
    throw new HttpError(413, `The upload is larger than the ${MAX_ASSET_BYTES} byte limit.`, 'payload_too_large')
  }

  const form = await c.req.formData().catch(() => null)
  if (!form) throw badRequest('Upload must be sent as multipart/form-data')

  const file = form.get('file')
  if (!(file instanceof File)) throw badRequest('An uploaded "file" part is required')

  const kind = asKind(form.get('kind') ?? 'other')
  const episodeId = optionalText(form.get('episodeId'), 80)
  if (episodeId) {
    const episode = await findEpisode(c.env.DB, episodeId, ownerId)
    if (!episode || episode.project_id !== project.id) throw notFound('Episode not found in this project')
  }

  const name = optionalText(form.get('name'), 200) ?? file.name ?? 'untitled'
  const contentType = optionalText(form.get('contentType'), 120) ?? (file.type || 'application/octet-stream')
  const bytes = await file.arrayBuffer()

  const row = await putAsset(c.env.DB, c.env, {
    projectId: project.id,
    ownerId,
    episodeId,
    kind,
    name,
    contentType,
    bytes,
    provider: optionalText(form.get('provider'), 64),
    model: optionalText(form.get('model'), 200),
    metadata: parseMetadata(form.get('metadata')),
  })

  return c.json({ asset: serializeAsset(row) }, 201)
})

/** Every asset for a project (optionally filtered by kind). */
assetRoutes.get('/projects/:projectId/assets', async (c) => {
  const ownerId = c.get('user').sub
  const project = await findProject(c.env.DB, c.req.param('projectId'), ownerId)
  if (!project) throw notFound('Project not found')

  const kindParam = c.req.query('kind')
  const kind = kindParam ? asKind(kindParam) : undefined
  const rows = await listAssets(c.env.DB, ownerId, { projectId: project.id, ...(kind ? { kind } : {}) })
  return c.json({ projectId: project.id, assets: rows.map(serializeAsset) })
})

/** Every asset attached to an episode. */
assetRoutes.get('/episodes/:episodeId/assets', async (c) => {
  const ownerId = c.get('user').sub
  const episode = await findEpisode(c.env.DB, c.req.param('episodeId'), ownerId)
  if (!episode) throw notFound('Episode not found')

  const rows = await listAssets(c.env.DB, ownerId, { episodeId: episode.id })
  return c.json({ episodeId: episode.id, assets: rows.map(serializeAsset) })
})

/** One asset's metadata. */
assetRoutes.get('/assets/:assetId', async (c) => {
  const ownerId = c.get('user').sub
  const row = await findAsset(c.env.DB, c.req.param('assetId'), ownerId)
  if (!row || row.status === 'deleted') throw notFound('Asset not found')
  return c.json({ asset: serializeAsset(row) })
})

/** The stored bytes, streamed straight from the bucket. */
assetRoutes.get('/assets/:assetId/content', async (c) => {
  const ownerId = c.get('user').sub
  const row = await findAsset(c.env.DB, c.req.param('assetId'), ownerId)
  if (!row || row.status === 'deleted') throw notFound('Asset not found')

  const { object, detail } = await readAssetObject(c.env, row)
  if (!object) {
    throw new HttpError(503, detail ?? 'The stored object is unavailable.', 'storage_unavailable')
  }

  const safeName = row.name.replace(/["\r\n]/g, '')
  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType ?? row.content_type,
      'content-length': String(object.size),
      'content-disposition': `inline; filename="${safeName}"`,
      'cache-control': 'private, no-store',
      etag: object.httpEtag,
    },
  })
})

/** Deletes the object and marks the row deleted. The history is kept. */
assetRoutes.delete('/assets/:assetId', async (c) => {
  const ownerId = c.get('user').sub
  const row = await findAsset(c.env.DB, c.req.param('assetId'), ownerId)
  if (!row) throw notFound('Asset not found')

  const deleted = await deleteAsset(c.env.DB, c.env, row, ownerId)
  return c.json({ asset: serializeAsset(deleted) })
})

/** A real storage round-trip; the only path to `connected_verified`. */
assetRoutes.post('/storage/verify', async (c) => {
  const outcome = await verifyStorage(c.env.DB, c.env)
  const status = outcome.ok ? 200 : outcome.code === 'storage_not_configured' ? 503 : 502
  return c.json({ result: outcome, capabilities: await capabilityStatuses(c.env.DB, c.env) }, status as 200)
})

