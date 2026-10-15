/**
 * Image generation service.
 *
 * Builds prompts from scenes/characters, calls configured image provider,
 * stores generated images in R2 via asset service, and records metadata.
 */

import { nowIso } from './time'
import { uploadAsset } from './assetService'
import { resolveImageConfig, IMAGE_ADAPTERS, runImageProviderCheck } from '../providers/imageIndex'
import { ImageProviderError } from '../providers/imageTypes'
import type { ImageGenerationRequest } from '../providers/imageTypes'

import type { Env } from '../env'
import type { AssetRow, AssetType } from './rows'

export interface GenerateSceneImageParams {
  sceneId: string
  projectId: string
  episodeId: string
}

export interface GenerateCharacterImageParams {
  characterId: string
  projectId: string
}

export interface ImageGenerationOptions {
  width?: number
  height?: number
  quality?: string
  style?: string
  signal?: AbortSignal
}

export interface ImageGenerationOutcome {
  asset: AssetRow
  assetId: string
  storageKey: string
  provider: string
  model: string
  width: number
  height: number
  prompt: string
  revisedPrompt?: string
}

/**
 * Default image dimensions for manhwa-style art.
 */
const DEFAULT_WIDTH = 1024
const DEFAULT_HEIGHT = 1024

/**
 * Manhwa style suffix to append to all prompts.
 */
const MANHWA_STYLE = 'manhwa style, vibrant colors, dynamic composition, high detail, cinematic lighting'

/**
 * Builds a scene image prompt from scene data and project story bible.
 */
async function buildScenePrompt(
  db: D1Database,
  sceneId: string,
): Promise<string> {
  // Get scene with its image_prompt, heading, description, narration
  const scene = await db
    .prepare(`SELECT image_prompt, heading, description, narration FROM scenes WHERE id = ?`)
    .bind(sceneId)
    .first<{ image_prompt: string; heading: string; description: string; narration: string }>()

  if (!scene) {
    throw new Error(`Scene not found: ${sceneId}`)
  }

  // If image_prompt exists, use it
  if (scene.image_prompt && scene.image_prompt.trim()) {
    return `${scene.image_prompt.trim()}. ${MANHWA_STYLE}`
  }

  // Build from scene content
  const parts: string[] = []
  if (scene.heading) parts.push(`Scene: ${scene.heading}`)
  if (scene.description) parts.push(`Description: ${scene.description}`)
  if (scene.narration) parts.push(`Narration: ${scene.narration}`)

  const sceneText = parts.join('. ')
  return `${sceneText}. ${MANHWA_STYLE}`
}

/**
 * Builds a character portrait prompt from character data and project story bible.
 */
async function buildCharacterPrompt(
  db: D1Database,
  characterId: string,
  projectId: string,
): Promise<string> {
  // Get character data
  const character = await db
    .prepare(`SELECT name, description, appearance FROM characters WHERE id = ?`)
    .bind(characterId)
    .first<{ name: string; description: string; appearance: string }>()

  if (!character) {
    throw new Error(`Character not found: ${characterId}`)
  }

  // Get project story bible for context
  const project = await db
    .prepare(`SELECT story_bible FROM projects WHERE id = ?`)
    .bind(projectId)
    .first<{ story_bible: string }>()

  const parts: string[] = []
  if (character.name) parts.push(`Character: ${character.name}`)
  if (character.description) parts.push(`Description: ${character.description}`)
  if (character.appearance) parts.push(`Appearance: ${character.appearance}`)
  if (project?.story_bible) parts.push(`Context: ${project.story_bible}`)

  const characterText = parts.join('. ')
  return `${characterText}. Full body portrait, ${MANHWA_STYLE}`
}

/**
 * Gets the configured image provider adapter and config.
 * Throws if not configured.
 */
function getConfiguredImageProvider(env: Env): {
  adapter: typeof IMAGE_ADAPTERS[number]
  config: ReturnType<typeof resolveImageConfig>['config']
} {
  const resolved = resolveImageConfig(env)
  
  if (!resolved.configured || !resolved.config || !resolved.adapter) {
    const detail = resolved.detail
    throw new ImageProviderError(
      'provider_not_configured',
      `Image generation is not configured: ${detail}`,
    )
  }

  return {
    adapter: resolved.adapter,
    config: resolved.config,
  }
}

/**
 * Converts base64 image data to ArrayBuffer.
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes.buffer
}

/**
 * Downloads image from URL and returns as ArrayBuffer.
 */
async function downloadImageFromUrl(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new ImageProviderError(
      'provider_http_error',
      `Failed to download image from URL: HTTP ${response.status}`,
      response.status,
    )
  }
  return await response.arrayBuffer()
}

/**
 * Generates an image for a scene.
 * Builds prompt, calls provider, stores in R2, records metadata.
 */
export async function generateSceneImage(
  env: Env,
  params: GenerateSceneImageParams,
  options: ImageGenerationOptions = {},
): Promise<ImageGenerationOutcome> {
  const db = env.DB
  const { sceneId, projectId, episodeId } = params

  // Build prompt
  const prompt = await buildScenePrompt(db, sceneId)

  // Get configured provider
  const { adapter, config } = getConfiguredImageProvider(env)

  // Prepare generation request
  const width = options.width ?? adapter.defaultWidth ?? DEFAULT_WIDTH
  const height = options.height ?? adapter.defaultHeight ?? DEFAULT_HEIGHT

  const request: ImageGenerationRequest = {
    prompt,
    width,
    height,
    n: 1,
    quality: options.quality,
    style: options.style,
    signal: options.signal,
  }

  // Call provider - config is guaranteed to be non-null by getConfiguredImageProvider
  const result = await adapter.generate(config!, request)

  // Get image data
  let imageBuffer: ArrayBuffer
  if (result.base64Image) {
    imageBuffer = base64ToArrayBuffer(result.base64Image)
  } else if (result.url) {
    imageBuffer = await downloadImageFromUrl(result.url, options.signal)
  } else {
    throw new ImageProviderError(
      'provider_bad_response',
      'Provider returned neither base64 image nor URL',
    )
  }

  // Upload to R2
  const uploadResult = await uploadAsset(env, {
    projectId,
    episodeId,
    type: 'image' as AssetType,
    contentType: 'image/png',
    body: imageBuffer,
    metadata: {
      source: 'scene-image-generation',
      sceneId,
      provider: adapter.id,
      model: result.model,
      width: result.width,
      height: result.height,
      prompt,
      revisedPrompt: result.revisedPrompt,
      generatedAt: nowIso(),
    },
  })

  // Get the asset row
  const asset = await db
    .prepare('SELECT * FROM assets WHERE id = ?')
    .bind(uploadResult.id)
    .first<AssetRow>()

  if (!asset) {
    throw new Error('Asset record not found after upload')
  }

  return {
    asset,
    assetId: uploadResult.id,
    storageKey: uploadResult.storageKey,
    provider: adapter.id,
    model: result.model,
    width: result.width,
    height: result.height,
    prompt,
    revisedPrompt: result.revisedPrompt,
  }
}

/**
 * Generates a character portrait image.
 * Builds prompt, calls provider, stores in R2, records metadata.
 */
export async function generateCharacterImage(
  env: Env,
  params: GenerateCharacterImageParams,
  options: ImageGenerationOptions = {},
): Promise<ImageGenerationOutcome> {
  const db = env.DB
  const { characterId, projectId } = params

  // Build prompt
  const prompt = await buildCharacterPrompt(db, characterId, projectId)

  // Get configured provider
  const { adapter, config } = getConfiguredImageProvider(env)

  // Prepare generation request
  const width = options.width ?? adapter.defaultWidth ?? DEFAULT_WIDTH
  const height = options.height ?? adapter.defaultHeight ?? DEFAULT_HEIGHT

  const request: ImageGenerationRequest = {
    prompt,
    width,
    height,
    n: 1,
    quality: options.quality,
    style: options.style,
    signal: options.signal,
  }

  // Call provider - config is guaranteed to be non-null by getConfiguredImageProvider
  const result = await adapter.generate(config!, request)

  // Get image data
  let imageBuffer: ArrayBuffer
  if (result.base64Image) {
    imageBuffer = base64ToArrayBuffer(result.base64Image)
  } else if (result.url) {
    imageBuffer = await downloadImageFromUrl(result.url, options.signal)
  } else {
    throw new ImageProviderError(
      'provider_bad_response',
      'Provider returned neither base64 image nor URL',
    )
  }

  // Upload to R2
  const uploadResult = await uploadAsset(env, {
    projectId,
    episodeId: null,
    type: 'image' as AssetType,
    contentType: 'image/png',
    body: imageBuffer,
    metadata: {
      source: 'character-portrait-generation',
      characterId,
      provider: adapter.id,
      model: result.model,
      width: result.width,
      height: result.height,
      prompt,
      revisedPrompt: result.revisedPrompt,
      generatedAt: nowIso(),
    },
  })

  // Get the asset row
  const asset = await db
    .prepare('SELECT * FROM assets WHERE id = ?')
    .bind(uploadResult.id)
    .first<AssetRow>()

  if (!asset) {
    throw new Error('Asset record not found after upload')
  }

  return {
    asset,
    assetId: uploadResult.id,
    storageKey: uploadResult.storageKey,
    provider: adapter.id,
    model: result.model,
    width: result.width,
    height: result.height,
    prompt,
    revisedPrompt: result.revisedPrompt,
  }
}

/**
 * Lists images for a project.
 */
export async function listProjectImages(db: D1Database, projectId: string): Promise<AssetRow[]> {
  const result = await db
    .prepare('SELECT * FROM assets WHERE project_id = ? AND type = ? ORDER BY created_at DESC')
    .bind(projectId, 'image')
    .all<AssetRow>()
  return result.results ?? []
}

/**
 * Lists images for a scene.
 */
export async function listSceneImages(db: D1Database, sceneId: string): Promise<AssetRow[]> {
  const result = await db
    .prepare(`
      SELECT a.* FROM assets a
      JOIN scenes s ON a.project_id = s.project_id
      WHERE a.type = ? AND s.id = ?
      ORDER BY a.created_at DESC
    `)
    .bind('image', sceneId)
    .all<AssetRow>()
  return result.results ?? []
}

/**
 * Lists images for a character.
 */
export async function listCharacterImages(db: D1Database, characterId: string): Promise<AssetRow[]> {
  const result = await db
    .prepare(`
      SELECT a.* FROM assets a
      JOIN characters c ON a.project_id = c.project_id
      WHERE a.type = ? AND c.id = ?
      ORDER BY a.created_at DESC
    `)
    .bind('image', characterId)
    .all<AssetRow>()
  return result.results ?? []
}

/**
 * Verifies image provider configuration by making a real authenticated call.
 * This is used by the integrations verification endpoint.
 */
export async function verifyImageProvider(env: Env): Promise<{
  ok: boolean
  detail: string
  latencyMs: number
  provider: string
  providerLabel: string
  model: string | null
  models: string[]
  code: string | null
}> {
  const outcome = await runImageProviderCheck(env)
  return {
    ok: outcome.ok,
    detail: outcome.detail,
    latencyMs: outcome.latencyMs,
    provider: outcome.provider,
    providerLabel: outcome.providerLabel,
    model: outcome.model,
    models: outcome.models,
    code: outcome.code,
  }
}

/**
 * Checks if image generation is available (configured and verified).
 */
export function isImageGenerationAvailable(env: Env): boolean {
  const resolved = resolveImageConfig(env)
  return resolved.configured && !!resolved.config && !!resolved.adapter
}
