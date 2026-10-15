import { Hono } from 'hono'

import { HttpError } from '../lib/errors'
import { serializeAsset } from '../lib/rows'
import { downloadAsset, getAsset, listAssets, listAssetsByEpisode, uploadAsset, deleteAsset } from '../lib/assetService'

import type { AppBindings } from '../app'
import type { AssetType } from '../lib/rows'
import type { Context } from 'hono'

export const assetRoutes = new Hono<AppBindings>()

const ASSET_TYPES: AssetType[] = ['image', 'audio', 'video', 'script', 'other']

function validateAssetType(type: string): AssetType {
  if (!ASSET_TYPES.includes(type as AssetType)) {
    throw new HttpError(400, 'invalid_asset_type', `Invalid asset type: ${type}. Valid types: ${ASSET_TYPES.join(', ')}`)
  }
  return type as AssetType
}

/**
 * Lists assets for a project.
 */
async function listProjectAssets(c: Context<AppBindings>, projectId: string): Promise<Response> {
  const user = c.get('user')
  const db = c.env.DB

  // Verify project ownership
  const project = await db.prepare('SELECT owner_id FROM projects WHERE id = ?').bind(projectId).first()
  if (!project) {
    return c.json({ error: 'Project not found', code: 'not_found' }, 404)
  }
  if (project.owner_id !== user.sub) {
    return c.json({ error: 'Not authorized', code: 'forbidden' }, 403)
  }

  const assets = await listAssets(db, projectId)
  return c.json({
    projectId,
    assets: assets.map(serializeAsset),
  })
}

/**
 * Lists assets for an episode.
 */
async function listEpisodeAssets(c: Context<AppBindings>, episodeId: string): Promise<Response> {
  const user = c.get('user')
  const db = c.env.DB

  // Verify episode ownership through project
  const episode = await db
    .prepare('SELECT p.owner_id FROM episodes e JOIN projects p ON e.project_id = p.id WHERE e.id = ?')
    .bind(episodeId)
    .first()
  if (!episode) {
    return c.json({ error: 'Episode not found', code: 'not_found' }, 404)
  }
  if (episode.owner_id !== user.sub) {
    return c.json({ error: 'Not authorized', code: 'forbidden' }, 403)
  }

  const assets = await listAssetsByEpisode(db, episodeId)
  return c.json({
    episodeId,
    assets: assets.map(serializeAsset),
  })
}

/**
 * Gets metadata for a single asset.
 */
async function getSingleAsset(c: Context<AppBindings>, assetId: string): Promise<Response> {
  const user = c.get('user')
  const db = c.env.DB

  const asset = await getAsset(db, assetId)
  if (!asset) {
    return c.json({ error: 'Asset not found', code: 'not_found' }, 404)
  }

  // Verify ownership
  const project = await db.prepare('SELECT owner_id FROM projects WHERE id = ?').bind(asset.project_id).first()
  if (!project || project.owner_id !== user.sub) {
    return c.json({ error: 'Not authorized', code: 'forbidden' }, 403)
  }

  return c.json({ asset: serializeAsset(asset) })
}

/**
 * Uploads a new asset.
 */
async function uploadNewAsset(c: Context<AppBindings>): Promise<Response> {
  const user = c.get('user')
  const db = c.env.DB
  const env = c.env

  // Parse request body
  const contentType = c.req.header('Content-Type') ?? 'application/octet-stream'
  const body = await c.req.arrayBuffer()

  if (body.byteLength === 0) {
    return c.json({ error: 'Empty body', code: 'invalid_request' }, 400)
  }

  // Parse query parameters - these may be undefined
  const projectId = c.req.query('projectId') ?? ''
  const episodeId = c.req.query('episodeId')
  const typeParam = c.req.query('type')

  if (!projectId) {
    return c.json({ error: 'projectId is required', code: 'invalid_request' }, 400)
  }

  const type = typeParam ? validateAssetType(typeParam) : 'other'

  // Verify project ownership
  const project = await db.prepare('SELECT owner_id FROM projects WHERE id = ?').bind(projectId).first()
  if (!project) {
    return c.json({ error: 'Project not found', code: 'not_found' }, 404)
  }
  if (project.owner_id !== user.sub) {
    return c.json({ error: 'Not authorized', code: 'forbidden' }, 403)
  }

  // Verify episode exists and belongs to project
  let episodeIdValue: string | null = null
  if (episodeId) {
    const ep = await db
      .prepare('SELECT id FROM episodes WHERE id = ? AND project_id = ?')
      .bind(episodeId, projectId)
      .first<{ id: string }>()
    if (ep) {
      episodeIdValue = ep.id
    } else {
      return c.json({ error: 'Episode not found', code: 'not_found' }, 404)
    }
  }

  // Upload to R2 and record in D1
  try {
    const result = await uploadAsset(env, {
      projectId,
      episodeId: episodeIdValue,
      type,
      contentType,
      body,
      metadata: {
        uploadedBy: user.sub,
        source: 'api-upload',
      },
    })

    const asset = await getAsset(db, result.id)
    if (!asset) {
      return c.json({ error: 'Asset record not found after upload', code: 'internal_error' }, 500)
    }

    return c.json({ asset: serializeAsset(asset) }, 201)
  } catch (error) {
    if (error instanceof Error && error.message.includes('FILES is not available')) {
      return c.json(
        { error: 'Object storage is not configured', code: 'storage_not_configured' },
        503,
      )
    }
    throw error
  }
}

/**
 * Downloads an asset.
 */
async function downloadSingleAsset(c: Context<AppBindings>, assetId: string): Promise<Response> {
  const user = c.get('user')
  const db = c.env.DB
  const env = c.env

  const asset = await getAsset(db, assetId)
  if (!asset) {
    return c.json({ error: 'Asset not found', code: 'not_found' }, 404)
  }

  // Verify ownership
  const project = await db.prepare('SELECT owner_id FROM projects WHERE id = ?').bind(asset.project_id).first()
  if (!project || project.owner_id !== user.sub) {
    return c.json({ error: 'Not authorized', code: 'forbidden' }, 403)
  }

  try {
    const { body, contentType, contentLength } = await downloadAsset(env, asset.storage_key)
    return c.newResponse(body, 200, {
      'Content-Type': contentType,
      'Content-Length': contentLength.toString(),
      'Cache-Control': 'private, no-store',
    })
  } catch (error) {
    if (error instanceof Error && error.message.includes('not found')) {
      return c.json({ error: 'Asset file not found in storage', code: 'storage_not_found' }, 404)
    }
    if (error instanceof Error && error.message.includes('FILES is not available')) {
      return c.json(
        { error: 'Object storage is not configured', code: 'storage_not_configured' },
        503,
      )
    }
    throw error
  }
}

/**
 * Deletes an asset.
 */
async function deleteSingleAsset(c: Context<AppBindings>, assetId: string): Promise<Response> {
  const user = c.get('user')
  const db = c.env.DB
  const env = c.env

  const asset = await getAsset(db, assetId)
  if (!asset) {
    return c.json({ error: 'Asset not found', code: 'not_found' }, 404)
  }

  // Verify ownership
  const project = await db.prepare('SELECT owner_id FROM projects WHERE id = ?').bind(asset.project_id).first()
  if (!project || project.owner_id !== user.sub) {
    return c.json({ error: 'Not authorized', code: 'forbidden' }, 403)
  }

  try {
    const deleted = await deleteAsset(env, assetId)
    if (!deleted) {
      return c.json({ error: 'Asset not found', code: 'not_found' }, 404)
    }
    return c.json({ deleted: true, assetId })
  } catch (error) {
    if (error instanceof Error && error.message.includes('FILES is not available')) {
      return c.json(
        { error: 'Object storage is not configured', code: 'storage_not_configured' },
        503,
      )
    }
    throw error
  }
}

// Route definitions
assetRoutes.get('/assets', async (c: Context<AppBindings>) => {
  const projectId = c.req.query('projectId')
  const episodeId = c.req.query('episodeId')

  if (projectId) {
    return listProjectAssets(c, projectId)
  }
  if (episodeId) {
    return listEpisodeAssets(c, episodeId)
  }
  return c.json(
    { error: 'Either projectId or episodeId query parameter is required', code: 'invalid_request' },
    400,
  )
})

assetRoutes.get('/assets/:id', (c: Context<AppBindings>) => {
  const id = c.req.param('id')
  if (!id) return c.json({ error: 'Asset ID is required', code: 'invalid_request' }, 400)
  return getSingleAsset(c, id)
})
assetRoutes.get('/assets/:id/download', (c: Context<AppBindings>) => {
  const id = c.req.param('id')
  if (!id) return c.json({ error: 'Asset ID is required', code: 'invalid_request' }, 400)
  return downloadSingleAsset(c, id)
})

assetRoutes.post('/assets/upload', (c: Context<AppBindings>) => uploadNewAsset(c))

assetRoutes.delete('/assets/:id', (c: Context<AppBindings>) => {
  const id = c.req.param('id')
  if (!id) return c.json({ error: 'Asset ID is required', code: 'invalid_request' }, 400)
  return deleteSingleAsset(c, id)
})
