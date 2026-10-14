import { logActivity } from '../db'
import { HttpError } from '../lib/errors'
import { newId } from '../lib/ids'
import { nowIso } from '../lib/time'

import type { AssetKind } from '../lib/constants'
import type { AssetRow } from '../lib/rows'
import type { Env } from '../env'

/**
 * Object storage for real media. Bytes live in R2; the `assets` table holds the
 * metadata and the key. Nothing binary is ever written to D1.
 */

/** A hard ceiling so one request can never exhaust the worker's memory. */
export const MAX_ASSET_BYTES = 25 * 1024 * 1024
const MAX_CAPTION_BYTES = 512 * 1024

const CONTENT_TYPE_ALLOWED: Record<AssetKind, (contentType: string) => boolean> = {
  image: (type) => type.startsWith('image/'),
  audio: (type) => type.startsWith('audio/'),
  video: (type) => type.startsWith('video/'),
  caption: (type) =>
    type.startsWith('text/') || type === 'application/json' || type === 'application/x-subrip',
  other: () => true,
}

export function bucketFor(env: Env): R2Bucket | null {
  const bucket = (env as unknown as { FILES?: R2Bucket }).FILES
  return bucket && typeof bucket.put === 'function' ? bucket : null
}

/** Server-generated key: a user-supplied filename can never escape its prefix. */
export function storageKeyFor(projectId: string, kind: AssetKind, id: string): string {
  return `projects/${projectId}/${kind}/${id}`
}

export function maxBytesFor(kind: AssetKind): number {
  return kind === 'caption' ? MAX_CAPTION_BYTES : MAX_ASSET_BYTES
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export interface UploadAssetParams {
  projectId: string
  ownerId: string
  episodeId: string | null
  kind: AssetKind
  name: string
  contentType: string
  bytes: ArrayBuffer
  provider?: string | null
  model?: string | null
  metadata?: Record<string, unknown>
}

function validate(kind: AssetKind, contentType: string, byteSize: number): void {
  if (!CONTENT_TYPE_ALLOWED[kind](contentType)) {
    throw new HttpError(415, `A ${kind} asset cannot be ${contentType || 'untyped'}.`, 'unsupported_media_type')
  }
  const limit = maxBytesFor(kind)
  if (byteSize <= 0) throw new HttpError(400, 'The uploaded file is empty.', 'bad_request')
  if (byteSize > limit) {
    throw new HttpError(
      413,
      `The file is ${byteSize} bytes; the limit for a ${kind} asset is ${limit} bytes.`,
      'payload_too_large',
    )
  }
}

/**
 * Writes the object first, then its metadata row. If the row cannot be written
 * the object is removed again, so a failed upload never leaves an orphan.
 */
export async function putAsset(db: D1Database, env: Env, params: UploadAssetParams): Promise<AssetRow> {
  const bucket = bucketFor(env)
  if (!bucket) {
    throw new HttpError(
      503,
      'No object-storage bucket is attached to this deployment, so uploads are disabled.',
      'storage_not_configured',
      { requiredBinding: 'FILES' },
    )
  }

  const contentType = (params.contentType || 'application/octet-stream').trim()
  validate(params.kind, contentType, params.bytes.byteLength)

  const id = newId('ast')
  const key = storageKeyFor(params.projectId, params.kind, id)
  const now = nowIso()
  const checksum = await sha256Hex(params.bytes)

  await bucket.put(key, params.bytes, {
    httpMetadata: { contentType, cacheControl: 'private, no-store' },
    customMetadata: { assetId: id, projectId: params.projectId, kind: params.kind },
  })

  const row: AssetRow = {
    id,
    project_id: params.projectId,
    episode_id: params.episodeId,
    kind: params.kind,
    name: params.name.slice(0, 200),
    storage_key: key,
    content_type: contentType,
    byte_size: params.bytes.byteLength,
    checksum,
    status: 'stored',
    provider: params.provider ?? null,
    model: params.model ?? null,
    metadata_json: JSON.stringify(params.metadata ?? {}),
    created_by: params.ownerId,
    created_at: now,
    updated_at: now,
  }

  try {
    await db
      .prepare(
        `INSERT INTO assets
           (id, project_id, episode_id, kind, name, storage_key, content_type, byte_size, checksum,
            status, provider, model, metadata_json, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.project_id,
        row.episode_id,
        row.kind,
        row.name,
        row.storage_key,
        row.content_type,
        row.byte_size,
        row.checksum,
        row.status,
        row.provider,
        row.model,
        row.metadata_json,
        row.created_by,
        row.created_at,
        row.updated_at,
      )
      .run()
  } catch (error) {
    await bucket.delete(key).catch(() => undefined)
    throw new HttpError(
      500,
      `The object was stored but its record could not be written, so it was removed again: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
      'asset_not_recorded',
    )
  }

  await logActivity(db, {
    projectId: row.project_id,
    actorType: 'owner',
    actorId: params.ownerId,
    eventType: 'asset.stored',
    summary: `Stored ${row.kind} asset “${row.name || row.id}” (${row.byte_size} bytes, ${row.content_type}).`,
    metadata: { assetId: row.id, kind: row.kind, byteSize: row.byte_size, episodeId: row.episode_id },
  })

  return row
}

/** Ownership is always resolved from the signed-in subject, never from input. */
export async function findAsset(db: D1Database, assetId: string, ownerId: string): Promise<AssetRow | null> {
  const row = await db
    .prepare(
      `SELECT a.* FROM assets a
       JOIN projects p ON p.id = a.project_id
       WHERE a.id = ? AND p.owner_id = ?`,
    )
    .bind(assetId, ownerId)
    .first<AssetRow>()
  return row ?? null
}

export interface AssetListFilter {
  projectId?: string
  episodeId?: string
  kind?: AssetKind
}

export async function listAssets(
  db: D1Database,
  ownerId: string,
  filter: AssetListFilter = {},
): Promise<AssetRow[]> {
  const clauses = ['p.owner_id = ?', "a.status != 'deleted'"]
  const binds: unknown[] = [ownerId]
  if (filter.projectId) {
    clauses.push('a.project_id = ?')
    binds.push(filter.projectId)
  }
  if (filter.episodeId) {
    clauses.push('a.episode_id = ?')
    binds.push(filter.episodeId)
  }
  if (filter.kind) {
    clauses.push('a.kind = ?')
    binds.push(filter.kind)
  }

  const result = await db
    .prepare(
      `SELECT a.* FROM assets a
       JOIN projects p ON p.id = a.project_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY a.created_at DESC`,
    )
    .bind(...binds)
    .all<AssetRow>()
  return result.results ?? []
}

/** Reads the object back. A missing object is reported, never invented. */
export async function readAssetObject(
  env: Env,
  row: AssetRow,
): Promise<{ object: R2ObjectBody | null; detail: string | null }> {
  const bucket = bucketFor(env)
  if (!bucket) {
    return { object: null, detail: 'No object-storage bucket is attached to this deployment.' }
  }
  const object = await bucket.get(row.storage_key)
  if (!object) {
    return {
      object: null,
      detail: `The metadata row exists but the stored object (${row.storage_key}) is missing.`,
    }
  }
  return { object, detail: null }
}

export async function deleteAsset(db: D1Database, env: Env, row: AssetRow, ownerId: string): Promise<AssetRow> {
  const bucket = bucketFor(env)
  if (bucket) {
    await bucket.delete(row.storage_key).catch(() => undefined)
  }
  const now = nowIso()
  await db.prepare("UPDATE assets SET status = 'deleted', updated_at = ? WHERE id = ?").bind(now, row.id).run()

  await logActivity(db, {
    projectId: row.project_id,
    actorType: 'owner',
    actorId: ownerId,
    eventType: 'asset.deleted',
    summary: `Deleted ${row.kind} asset “${row.name || row.id}”.`,
    metadata: { assetId: row.id, kind: row.kind },
  })

  return { ...row, status: 'deleted', updated_at: now }
}

export interface StorageCheckOutcome {
  capability: 'media-storage'
  provider: 'r2'
  ok: boolean
  detail: string
  latencyMs: number
  code: string | null
  checkedAt: string
}

/**
 * A real put → get → compare → delete round-trip. This is the only thing that
 * can move the media-storage capability to `connected_verified`.
 */
export async function verifyStorage(db: D1Database, env: Env): Promise<StorageCheckOutcome> {
  const started = Date.now()
  const checkedAt = nowIso()
  const bucket = bucketFor(env)

  const finish = async (outcome: StorageCheckOutcome): Promise<StorageCheckOutcome> => {
    await db
      .prepare(
        `INSERT INTO provider_checks
           (id, capability, provider, model, status, detail, latency_ms, models_json, checked_by, checked_at)
         VALUES (?, 'media-storage', 'r2', NULL, ?, ?, ?, '[]', NULL, ?)
         ON CONFLICT (capability, provider) DO UPDATE SET
           status = excluded.status,
           detail = excluded.detail,
           latency_ms = excluded.latency_ms,
           checked_at = excluded.checked_at`,
      )
      .bind(newId('chk'), outcome.ok ? 'ok' : 'failed', outcome.detail, outcome.latencyMs, checkedAt)
      .run()
    return outcome
  }

  if (!bucket) {
    return finish({
      capability: 'media-storage',
      provider: 'r2',
      ok: false,
      detail: 'No object-storage bucket is attached to this deployment (binding FILES is missing).',
      latencyMs: Date.now() - started,
      code: 'storage_not_configured',
      checkedAt,
    })
  }

  const key = `_probes/${newId('probe')}`
  const payload = new TextEncoder().encode(`manhwa-studio-storage-probe:${checkedAt}`)
  try {
    await bucket.put(key, payload, { httpMetadata: { contentType: 'text/plain' } })
    const object = await bucket.get(key)
    if (!object) {
      return finish({
        capability: 'media-storage',
        provider: 'r2',
        ok: false,
        detail: 'Wrote a probe object but could not read it back.',
        latencyMs: Date.now() - started,
        code: 'storage_read_failed',
        checkedAt,
      })
    }
    const readBack = new Uint8Array(await object.arrayBuffer())
    const matches = readBack.length === payload.length && readBack.every((byte, index) => byte === payload[index])
    await bucket.delete(key)
    if (!matches) {
      return finish({
        capability: 'media-storage',
        provider: 'r2',
        ok: false,
        detail: 'The probe object read back with different bytes than were written.',
        latencyMs: Date.now() - started,
        code: 'storage_verify_mismatch',
        checkedAt,
      })
    }
    return finish({
      capability: 'media-storage',
      provider: 'r2',
      ok: true,
      detail: 'A real put, read and delete round-trip through the bucket succeeded.',
      latencyMs: Date.now() - started,
      code: null,
      checkedAt,
    })
  } catch (error) {
    await bucket.delete(key).catch(() => undefined)
    return finish({
      capability: 'media-storage',
      provider: 'r2',
      ok: false,
      detail: `The storage round-trip failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      latencyMs: Date.now() - started,
      code: 'storage_error',
      checkedAt,
    })
  }
}

