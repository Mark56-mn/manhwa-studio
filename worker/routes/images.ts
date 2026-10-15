import { Hono } from 'hono'

import { HttpError } from '../lib/errors'
import { serializeAsset } from '../lib/rows'
import {
  generateSceneImage,
  generateCharacterImage,
  listProjectImages,
  listSceneImages,
  listCharacterImages,
  isImageGenerationAvailable,
  verifyImageProvider,
} from '../lib/imageService'
import { resolveImageConfig, IMAGE_ADAPTERS } from '../providers/imageIndex'
import { isImageProviderError } from '../providers/imageTypes'
import { newId } from '../lib/ids'
import { nowIso } from '../lib/time'

import type { AppBindings } from '../app'
import type { Context } from 'hono'

export const imageRoutes = new Hono<AppBindings>()

/**
 * Validates that image generation is configured.
 * Returns 503 if not available.
 */
function checkImageAvailable(c: Context<AppBindings>): void {
  const env = c.env
  if (!isImageGenerationAvailable(env)) {
    const resolved = resolveImageConfig(env)
    throw new HttpError(
      503,
      'image_not_configured',
      resolved.detail || 'Image generation is not configured on this deployment.',
    )
  }
}

/**
 * Verifies project ownership.
 */
async function verifyProjectOwnership(
  db: D1Database,
  userId: string,
  projectId: string,
): Promise<boolean> {
  const project = await db
    .prepare('SELECT owner_id FROM projects WHERE id = ?')
    .bind(projectId)
    .first<{ owner_id: string }>()
  return project?.owner_id === userId
}

/**
 * Verifies scene ownership through project.
 */
async function verifySceneOwnership(
  db: D1Database,
  userId: string,
  sceneId: string,
): Promise<{ projectId: string; episodeId: string } | null> {
  // Scenes belong to episodes, episodes belong to projects
  const scene = await db
    .prepare('SELECT s.episode_id FROM scenes s WHERE s.id = ?')
    .bind(sceneId)
    .first<{ episode_id: string }>()
  
  if (!scene) return null
  
  // Get project_id from episode
  const episode = await db
    .prepare('SELECT project_id FROM episodes WHERE id = ?')
    .bind(scene.episode_id)
    .first<{ project_id: string }>()
  
  if (!episode) return null
  
  const ownsProject = await verifyProjectOwnership(db, userId, episode.project_id)
  if (!ownsProject) return null
  
  return { projectId: episode.project_id, episodeId: scene.episode_id }
}

/**
 * Verifies character ownership through project.
 */
async function verifyCharacterOwnership(
  db: D1Database,
  userId: string,
  characterId: string,
): Promise<string | null> {
  const character = await db
    .prepare('SELECT project_id FROM characters WHERE id = ?')
    .bind(characterId)
    .first<{ project_id: string }>()
  
  if (!character) return null
  
  const ownsProject = await verifyProjectOwnership(db, userId, character.project_id)
  if (!ownsProject) return null
  
  return character.project_id
}

/**
 * Generates an image for a scene.
 */
async function generateSceneImageHandler(c: Context<AppBindings>): Promise<Response> {
  const user = c.get('user')
  const db = c.env.DB
  const env = c.env
  const sceneId = c.req.param('sceneId')

  if (!sceneId) {
    return c.json({ error: 'sceneId is required', code: 'invalid_request' }, 400)
  }

  // Verify scene ownership
  const sceneInfo = await verifySceneOwnership(db, user.sub, sceneId)
  if (!sceneInfo) {
    return c.json({ error: 'Scene not found or not authorized', code: 'not_found' }, 404)
  }

  // Check if image generation is available
  checkImageAvailable(c)

  try {
    const result = await generateSceneImage(env, {
      sceneId,
      projectId: sceneInfo.projectId,
      episodeId: sceneInfo.episodeId,
    })

    return c.json(
      {
        asset: serializeAsset(result.asset),
        assetId: result.assetId,
        storageKey: result.storageKey,
        provider: result.provider,
        model: result.model,
        width: result.width,
        height: result.height,
        prompt: result.prompt,
        revisedPrompt: result.revisedPrompt,
      },
      201,
    )
  } catch (error) {
    if (isImageProviderError(error)) {
      return c.json(
        {
          error: error.message,
          code: error.code,
          providerError: true,
        },
        error.status >= 400 && error.status < 600 ? (error.status as 400) : 502,
      )
    }
    if (error instanceof HttpError) {
      throw error
    }
    throw error
  }
}

/**
 * Generates a portrait for a character.
 */
async function generateCharacterImageHandler(c: Context<AppBindings>): Promise<Response> {
  const user = c.get('user')
  const db = c.env.DB
  const env = c.env
  const characterId = c.req.param('characterId')

  if (!characterId) {
    return c.json({ error: 'characterId is required', code: 'invalid_request' }, 400)
  }

  // Verify character ownership
  const projectId = await verifyCharacterOwnership(db, user.sub, characterId)
  if (!projectId) {
    return c.json({ error: 'Character not found or not authorized', code: 'not_found' }, 404)
  }

  // Check if image generation is available
  checkImageAvailable(c)

  try {
    const result = await generateCharacterImage(env, {
      characterId,
      projectId,
    })

    return c.json(
      {
        asset: serializeAsset(result.asset),
        assetId: result.assetId,
        storageKey: result.storageKey,
        provider: result.provider,
        model: result.model,
        width: result.width,
        height: result.height,
        prompt: result.prompt,
        revisedPrompt: result.revisedPrompt,
      },
      201,
    )
  } catch (error) {
    if (isImageProviderError(error)) {
      return c.json(
        {
          error: error.message,
          code: error.code,
          providerError: true,
        },
        error.status >= 400 && error.status < 600 ? (error.status as 400) : 502,
      )
    }
    if (error instanceof HttpError) {
      throw error
    }
    throw error
  }
}

/**
 * Lists images for a project.
 */
async function listProjectImagesHandler(c: Context<AppBindings>): Promise<Response> {
  const user = c.get('user')
  const db = c.env.DB
  const projectId = c.req.param('projectId')

  if (!projectId) {
    return c.json({ error: 'projectId is required', code: 'invalid_request' }, 400)
  }

  // Verify project ownership
  const ownsProject = await verifyProjectOwnership(db, user.sub, projectId)
  if (!ownsProject) {
    return c.json({ error: 'Project not found or not authorized', code: 'not_found' }, 404)
  }

  const images = await listProjectImages(db, projectId)
  return c.json({
    projectId,
    images: images.map(serializeAsset),
  })
}

/**
 * Lists images for a scene.
 */
async function listSceneImagesHandler(c: Context<AppBindings>): Promise<Response> {
  const user = c.get('user')
  const db = c.env.DB
  const sceneId = c.req.param('sceneId')

  if (!sceneId) {
    return c.json({ error: 'sceneId is required', code: 'invalid_request' }, 400)
  }

  // Verify scene ownership
  const sceneInfo = await verifySceneOwnership(db, user.sub, sceneId)
  if (!sceneInfo) {
    return c.json({ error: 'Scene not found or not authorized', code: 'not_found' }, 404)
  }

  const images = await listSceneImages(db, sceneId)
  return c.json({
    sceneId,
    projectId: sceneInfo.projectId,
    images: images.map(serializeAsset),
  })
}

/**
 * Lists images for a character.
 */
async function listCharacterImagesHandler(c: Context<AppBindings>): Promise<Response> {
  const user = c.get('user')
  const db = c.env.DB
  const characterId = c.req.param('characterId')

  if (!characterId) {
    return c.json({ error: 'characterId is required', code: 'invalid_request' }, 400)
  }

  // Verify character ownership
  const projectId = await verifyCharacterOwnership(db, user.sub, characterId)
  if (!projectId) {
    return c.json({ error: 'Character not found or not authorized', code: 'not_found' }, 404)
  }

  const images = await listCharacterImages(db, characterId)
  return c.json({
    characterId,
    projectId,
    images: images.map(serializeAsset),
  })
}

/**
 * Gets image provider configuration info (adapters, models, etc.).
 */
async function getImageConfigHandler(c: Context<AppBindings>): Promise<Response> {
  const adapters = IMAGE_ADAPTERS.map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    docsUrl: adapter.docsUrl,
    defaultModel: adapter.defaultModel,
    suggestedModels: adapter.suggestedModels,
    defaultWidth: adapter.defaultWidth,
    defaultHeight: adapter.defaultHeight,
    supportedQuality: adapter.supportedQuality,
    supportedStyles: adapter.supportedStyles,
    needsBaseUrl: adapter.needsBaseUrl,
  }))

  const resolved = resolveImageConfig(c.env)

  return c.json({
    adapters,
    configured: resolved.configured,
    currentProvider: resolved.adapter?.id ?? null,
    currentModel: resolved.config?.model ?? null,
    missing: resolved.missing,
    detail: resolved.detail,
  })
}

/**
 * Verifies the image provider configuration with a real authenticated call.
 */
async function verifyImageProviderHandler(c: Context<AppBindings>): Promise<Response> {
  const env = c.env
  const db = env.DB
  const user = c.get('user')

  const outcome = await verifyImageProvider(env)

  // Record the verification result
  await db.prepare(
    `INSERT INTO provider_checks
       (id, capability, provider, model, status, detail, latency_ms, models_json, checked_by, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (capability, provider) DO UPDATE SET
       model = excluded.model,
       status = excluded.status,
       detail = excluded.detail,
       latency_ms = excluded.latency_ms,
       models_json = excluded.models_json,
       checked_by = excluded.checked_by,
       checked_at = excluded.checked_at`,
  )
    .bind(
      newId('chk'),
      'image',
      outcome.provider,
      outcome.model,
      outcome.ok ? 'ok' : 'failed',
      outcome.detail,
      outcome.latencyMs,
      JSON.stringify(outcome.models),
      user.sub,
      nowIso(),
    )
    .run()

  const status = outcome.ok ? 200 : 502
  return c.json(
    {
      ok: outcome.ok,
      detail: outcome.detail,
      provider: outcome.provider,
      providerLabel: outcome.providerLabel,
      model: outcome.model,
      models: outcome.models,
      latencyMs: outcome.latencyMs,
      code: outcome.code,
    },
    status as 200,
  )
}

// Route definitions
imageRoutes.post('/scenes/:sceneId/images/generate', (c: Context<AppBindings>) =>
  generateSceneImageHandler(c),
)

imageRoutes.post('/characters/:characterId/images/generate', (c: Context<AppBindings>) =>
  generateCharacterImageHandler(c),
)

imageRoutes.get('/projects/:projectId/images', (c: Context<AppBindings>) =>
  listProjectImagesHandler(c),
)

imageRoutes.get('/scenes/:sceneId/images', (c: Context<AppBindings>) =>
  listSceneImagesHandler(c),
)

imageRoutes.get('/characters/:characterId/images', (c: Context<AppBindings>) =>
  listCharacterImagesHandler(c),
)

imageRoutes.get('/images/config', (c: Context<AppBindings>) => getImageConfigHandler(c))

imageRoutes.post('/integrations/image/verify', (c: Context<AppBindings>) =>
  verifyImageProviderHandler(c),
)
