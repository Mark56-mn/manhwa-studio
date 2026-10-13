import { Hono } from 'hono'

import { findEpisode, findProject, logActivity, nextEpisodeNumber } from '../db'
import { EPISODE_STATUSES } from '../lib/constants'
import { conflict, notFound } from '../lib/errors'
import { newId } from '../lib/ids'
import { Input, readJson } from '../lib/input'
import { serializeEpisode } from '../lib/rows'
import { nowIso } from '../lib/time'

import type { EpisodeRow } from '../lib/rows'
import type { AppBindings } from '../app'

const EPISODE_FIELDS = ['title', 'summary', 'status', 'episodeNumber', 'seasonId', 'targetDurationSeconds'] as const

export const episodeRoutes = new Hono<AppBindings>()

episodeRoutes.get('/projects/:projectId/episodes', async (c) => {
  const ownerId = c.get('user').sub
  const project = await findProject(c.env.DB, c.req.param('projectId'), ownerId)
  if (!project) throw notFound('Project not found')

  const rows = await c.env.DB.prepare('SELECT * FROM episodes WHERE project_id = ? ORDER BY episode_number')
    .bind(project.id)
    .all<EpisodeRow>()

  return c.json({ episodes: (rows.results ?? []).map(serializeEpisode) })
})

episodeRoutes.post('/projects/:projectId/episodes', async (c) => {
  const ownerId = c.get('user').sub
  const project = await findProject(c.env.DB, c.req.param('projectId'), ownerId)
  if (!project) throw notFound('Project not found')

  const input = new Input(await readJson(c.req.raw))
  input.rejectUnknown(EPISODE_FIELDS)
  const title = input.string('title', 200)
  const summary = input.optionalString('summary', 20000) ?? ''
  const status = input.enum('status', EPISODE_STATUSES) ?? 'planned'
  const seasonId = input.optionalString('seasonId', 80) || null
  const targetDurationSeconds = input.integer('targetDurationSeconds', { min: 1, max: 100000 }) ?? null
  const requestedNumber = input.integer('episodeNumber', { min: 1, max: 10000 })
  input.assertClean()

  if (seasonId) {
    const season = await c.env.DB.prepare('SELECT id FROM seasons WHERE id = ? AND project_id = ?')
      .bind(seasonId, project.id)
      .first<{ id: string }>()
    if (!season) throw notFound('Season not found in this project')
  }

  const episodeNumber = requestedNumber ?? (await nextEpisodeNumber(c.env.DB, project.id))
  const existing = await c.env.DB.prepare('SELECT id FROM episodes WHERE project_id = ? AND episode_number = ?')
    .bind(project.id, episodeNumber)
    .first<{ id: string }>()
  if (existing) throw conflict(`Episode ${episodeNumber} already exists in this project`)

  const now = nowIso()
  const id = newId('ep')
  await c.env.DB.prepare(
    `INSERT INTO episodes
       (id, project_id, season_id, episode_number, title, summary, status, target_duration_seconds, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, project.id, seasonId, episodeNumber, title, summary, status, targetDurationSeconds, now, now)
    .run()

  await c.env.DB.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').bind(now, project.id).run()

  await logActivity(c.env.DB, {
    projectId: project.id,
    actorType: 'owner',
    actorId: ownerId,
    eventType: 'episode.created',
    summary: `Created episode ${episodeNumber}: “${title}”.`,
    metadata: { episodeId: id, episodeNumber },
  })

  const row = await findEpisode(c.env.DB, id, ownerId)
  if (!row) throw notFound('Episode was not created')
  return c.json({ episode: serializeEpisode(row) }, 201)
})

episodeRoutes.get('/episodes/:episodeId', async (c) => {
  const ownerId = c.get('user').sub
  const episode = await findEpisode(c.env.DB, c.req.param('episodeId'), ownerId)
  if (!episode) throw notFound('Episode not found')

  const project = await findProject(c.env.DB, episode.project_id, ownerId)
  return c.json({
    episode: serializeEpisode(episode),
    project: project ? { id: project.id, title: project.title } : null,
  })
})

episodeRoutes.patch('/episodes/:episodeId', async (c) => {
  const ownerId = c.get('user').sub
  const episode = await findEpisode(c.env.DB, c.req.param('episodeId'), ownerId)
  if (!episode) throw notFound('Episode not found')

  const input = new Input(await readJson(c.req.raw))
  input.rejectUnknown(EPISODE_FIELDS)

  const updates: string[] = []
  const binds: unknown[] = []
  const changed: string[] = []
  let newEpisodeNumber: number | undefined

  if (input.has('title')) {
    updates.push('title = ?')
    binds.push(input.string('title', 200))
    changed.push('title')
  }
  if (input.has('summary')) {
    updates.push('summary = ?')
    binds.push(input.optionalString('summary', 20000) ?? '')
    changed.push('summary')
  }
  if (input.has('status')) {
    updates.push('status = ?')
    binds.push(input.enum('status', EPISODE_STATUSES) ?? episode.status)
    changed.push('status')
  }
  if (input.has('seasonId')) {
    const seasonId = input.optionalString('seasonId', 80) || null
    updates.push('season_id = ?')
    binds.push(seasonId)
    changed.push('seasonId')
  }
  if (input.has('targetDurationSeconds')) {
    updates.push('target_duration_seconds = ?')
    binds.push(input.integer('targetDurationSeconds', { min: 1, max: 100000 }) ?? null)
    changed.push('targetDurationSeconds')
  }
  if (input.has('episodeNumber')) {
    newEpisodeNumber = input.integer('episodeNumber', { min: 1, max: 10000 }) ?? episode.episode_number
    updates.push('episode_number = ?')
    binds.push(newEpisodeNumber)
    changed.push('episodeNumber')
  }
  input.assertClean()

  if (newEpisodeNumber !== undefined && newEpisodeNumber !== episode.episode_number) {
    const clash = await c.env.DB.prepare(
      'SELECT id FROM episodes WHERE project_id = ? AND episode_number = ? AND id != ?',
    )
      .bind(episode.project_id, newEpisodeNumber, episode.id)
      .first<{ id: string }>()
    if (clash) throw conflict(`Episode ${newEpisodeNumber} already exists in this project`)
  }

  if (updates.length === 0) {
    return c.json({ episode: serializeEpisode(episode), changed: [] })
  }

  const now = nowIso()
  await c.env.DB.prepare(`UPDATE episodes SET ${updates.join(', ')}, updated_at = ? WHERE id = ?`)
    .bind(...binds, now, episode.id)
    .run()
  await c.env.DB.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').bind(now, episode.project_id).run()

  await logActivity(c.env.DB, {
    projectId: episode.project_id,
    actorType: 'owner',
    actorId: ownerId,
    eventType: 'episode.updated',
    summary: `Updated episode ${episode.episode_number}: ${changed.join(', ')}.`,
    metadata: { episodeId: episode.id, changed },
  })

  const row = await findEpisode(c.env.DB, episode.id, ownerId)
  if (!row) throw notFound('Episode not found')
  return c.json({ episode: serializeEpisode(row), changed })
})

episodeRoutes.delete('/episodes/:episodeId', async (c) => {
  const ownerId = c.get('user').sub
  const episode = await findEpisode(c.env.DB, c.req.param('episodeId'), ownerId)
  if (!episode) throw notFound('Episode not found')

  await c.env.DB.prepare('DELETE FROM episodes WHERE id = ?').bind(episode.id).run()
  await logActivity(c.env.DB, {
    projectId: episode.project_id,
    actorType: 'owner',
    actorId: ownerId,
    eventType: 'episode.deleted',
    summary: `Deleted episode ${episode.episode_number}.`,
    metadata: { episodeId: episode.id },
  })
  return c.body(null, 204)
})
