import { newId } from './ids'
import { nowIso } from './time'

import type { Env } from '../env'
import type { AssetRow, AssetType, AssetStatus } from './rows'

export interface UploadAssetParams {
  projectId: string
  episodeId: string | null
  type: AssetType
  contentType: string
  body: ArrayBuffer
  metadata?: Record<string, unknown>
}

export interface UploadResult {
  id: string
  storageKey: string
  checksum: string
  contentLength: number
  createdAt: string
}

/**
 * Computes SHA-256 hex digest of the given body.
 */
async function sha256(body: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', body)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Generates a unique storage key for an asset.
 * Format: projects/{projectId}/assets/{type}/{id}.{extension or hash}
 * For simplicity we use the asset id as the filename.
 */
function generateStorageKey(projectId: string, type: AssetType, assetId: string): string {
  const extensions: Record<AssetType, string> = {
    image: 'png',
    audio: 'mp3',
    video: 'mp4',
    script: 'json',
    other: 'bin',
  }
  const ext = extensions[type] ?? 'bin'
  return `projects/${projectId}/assets/${type}/${assetId}.${ext}`
}

/**
 * Uploads an asset to R2 and records it in D1.
 * Returns the upload result; throws on failure.
 */
export async function uploadAsset(
  env: Env,
  params: UploadAssetParams,
): Promise<UploadResult> {
  const bucket = env.FILES
  if (!bucket || typeof bucket.put !== 'function') {
    throw new Error('R2 bucket binding FILES is not available')
  }

  const assetId = newId('ast')
  const storageKey = generateStorageKey(params.projectId, params.type, assetId)
  const checksum = await sha256(params.body)
  const contentLength = params.body.byteLength
  const createdAt = nowIso()

  // Upload to R2
  await bucket.put(storageKey, new Uint8Array(params.body), {
    httpMetadata: {
      contentType: params.contentType,
    },
    customMetadata: {
      projectId: params.projectId,
      episodeId: params.episodeId ?? '',
      type: params.type,
      assetId,
      createdAt,
    },
  })

  // Record in D1
  await env.DB.prepare(
    `INSERT INTO assets
       (id, project_id, episode_id, type, storage_key, content_type, content_length, checksum, metadata_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      assetId,
      params.projectId,
      params.episodeId,
      params.type,
      storageKey,
      params.contentType,
      contentLength,
      checksum,
      JSON.stringify(params.metadata ?? {}),
      'uploaded' as AssetStatus,
      createdAt,
    )
    .run()

  return {
    id: assetId,
    storageKey,
    checksum,
    contentLength,
    createdAt,
  }
}

/**
 * Downloads an asset from R2 by storage key.
 * Returns the body and metadata; throws on failure.
 */
export async function downloadAsset(
  env: Env,
  storageKey: string,
): Promise<{ body: ArrayBuffer; contentType: string; contentLength: number; checksum: string }> {
  const bucket = env.FILES
  if (!bucket || typeof bucket.get !== 'function') {
    throw new Error('R2 bucket binding FILES is not available')
  }

  const obj = await bucket.get(storageKey)
  if (!obj) {
    throw new Error(`Object not found: ${storageKey}`)
  }

  const body = await obj.arrayBuffer()
  const contentType = obj.httpMetadata?.contentType ?? 'application/octet-stream'
  const contentLength = obj.size

  const checksum = (obj as { checksums?: { sha256?: string } }).checksums?.sha256 ?? ''
  return { body, contentType, contentLength, checksum }
}

/**
 * Gets asset metadata from D1 by id.
 */
export async function getAsset(db: D1Database, id: string): Promise<AssetRow | null> {
  const row = await db.prepare('SELECT * FROM assets WHERE id = ?').bind(id).first<AssetRow>()
  return row ?? null
}

/**
 * Lists assets for a project from D1.
 */
export async function listAssets(db: D1Database, projectId: string): Promise<AssetRow[]> {
  const result = await db
    .prepare('SELECT * FROM assets WHERE project_id = ? ORDER BY created_at DESC')
    .bind(projectId)
    .all<AssetRow>()
  return result.results ?? []
}

/**
 * Lists assets for an episode from D1.
 */
export async function listAssetsByEpisode(db: D1Database, episodeId: string): Promise<AssetRow[]> {
  const result = await db
    .prepare('SELECT * FROM assets WHERE episode_id = ? ORDER BY created_at DESC')
    .bind(episodeId)
    .all<AssetRow>()
  return result.results ?? []
}

/**
 * Deletes an asset from R2 and D1.
 * Returns true if deleted, false if not found.
 */
export async function deleteAsset(env: Env, id: string): Promise<boolean> {
  const bucket = env.FILES
  if (!bucket || typeof bucket.delete !== 'function') {
    throw new Error('R2 bucket binding FILES is not available')
  }

  // Get the asset row first to find the storage key
  const row = await getAsset(env.DB, id)
  if (!row) {
    return false
  }

  // Delete from R2
  try {
    await bucket.delete(row.storage_key)
  } catch {
    // Continue to delete from D1 even if R2 delete fails
  }

  // Delete from D1
  await env.DB.prepare('DELETE FROM assets WHERE id = ?').bind(id).run()

  return true
}

/**
 * Verifies the R2 bucket is accessible by performing a test write/read/delete cycle.
 * Returns the result of the verification.
 */
export async function verifyR2Binding(env: Env): Promise<{
  ok: boolean
  detail: string
  latencyMs: number
  capability: string
  provider: string
}> {
  const bucket = env.FILES
  if (!bucket || typeof bucket.put !== 'function' || typeof bucket.get !== 'function') {
    return {
      ok: false,
      detail: 'R2 bucket binding FILES is not available on this deployment.',
      latencyMs: 0,
      capability: 'media-storage',
      provider: 'r2',
    }
  }

  const started = Date.now()
  const testKey = `test/${crypto.randomUUID()}.txt`
  const testContent = new TextEncoder().encode('R2 verification test')
  const testBuffer = testContent.buffer

  try {
    // Write
    await bucket.put(testKey, new Uint8Array(testBuffer), {
      httpMetadata: { contentType: 'text/plain' },
    })

    // Read
    const obj = await bucket.get(testKey)
    if (!obj) {
      return {
        ok: false,
        detail: 'Write succeeded but read returned no object.',
        latencyMs: Date.now() - started,
        capability: 'media-storage',
        provider: 'r2',
      }
    }

    const body = await obj.arrayBuffer()
    if (new TextDecoder().decode(body) !== 'R2 verification test') {
      return {
        ok: false,
        detail: 'Read content does not match written content.',
        latencyMs: Date.now() - started,
        capability: 'media-storage',
        provider: 'r2',
      }
    }

    // Delete
    await bucket.delete(testKey)

    return {
      ok: true,
      detail: 'R2 bucket is accessible: write, read and delete all succeeded.',
      latencyMs: Date.now() - started,
      capability: 'media-storage',
      provider: 'r2',
    }
  } catch (error) {
    return {
      ok: false,
      detail: `R2 operation failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      latencyMs: Date.now() - started,
      capability: 'media-storage',
      provider: 'r2',
    }
  }
}
