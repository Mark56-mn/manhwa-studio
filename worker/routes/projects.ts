import { Hono } from 'hono'

import { findProject, logActivity } from '../db'
import { PROJECT_STATUSES } from '../lib/constants'
import { notFound } from '../lib/errors'
import { newId } from '../lib/ids'
import { Input, readJson } from '../lib/input'
import {
  serializeCharacter,
  serializeEpisode,
  serializeProject,
  serializeSeason,
} from '../lib/rows'
import { nowIso } from '../lib/time'

import type { ActivityRow, CharacterRow, EpisodeRow, ProjectRow, SeasonRow } from '../lib/rows'
import type { AppBindings } from '../app'

const PROJECT_FIELDS = [
  'title',
  'logline',
  'synopsis',
  'genre',
  'tone',
  'language',
  'storyBible',
  'status',
] as const

export const projectRoutes = new Hono<AppBindings>()

projectRoutes.get('/projects', async (c) => {
  const ownerId = c.get('user').sub
  const input = new Input({ limit: c.req.query('limit'), offset: c.req.query('offset') })
  const limit = Math.min(input.integer('limit', { min: 1, max: 100 }) ?? 50, 100)
  const offset = input.integer('offset', { min: 0, max: 100000 }) ?? 0
  input.assertClean()

  const rows = await c.env.DB.prepare(
    `SELECT p.*,
            (SELECT COUNT(*) FROM episodes e WHERE e.project_id = p.id) AS episode_count
     FROM projects p
     WHERE p.owner_id = ?
     ORDER BY p.updated_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(ownerId, limit, offset)
    .all<ProjectRow & { episode_count: number }>()

  const total = await c.env.DB.prepare('SELECT COUNT(*) AS count FROM projects WHERE owner_id = ?')
    .bind(ownerId)
    .first<{ count: number }>()

  return c.json({
    projects: (rows.results ?? []).map((row) => ({
      ...serializeProject(row),
      episodeCount: row.episode_count,
    })),
    total: total?.count ?? 0,
    limit,
    offset,
  })
})

projectRoutes.post('/projects', async (c) => {
  const ownerId = c.get('user').sub
  const input = new Input(await readJson(c.req.raw))
  input.rejectUnknown(PROJECT_FIELDS)
  const title = input.string('title', 200)
  const logline = input.optionalString('logline', 2000) ?? ''
  const synopsis = input.optionalString('synopsis', 20000) ?? ''
  const genre = input.optionalString('genre', 80) ?? ''
  const tone = input.optionalString('tone', 120) ?? ''
  const language = input.optionalString('language', 16) ?? 'en'
  const storyBible = input.optionalString('storyBible', 200000) ?? ''
  const status = input.enum('status', PROJECT_STATUSES) ?? 'development'
  input.assertClean()

  const now = nowIso()
  const id = newId('prj')
  await c.env.DB.prepare(
    `INSERT INTO projects
       (id, owner_id, title, logline, synopsis, genre, tone, language, story_bible, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, ownerId, title, logline, synopsis, genre, tone, language, storyBible, status, now, now)
    .run()

  await logActivity(c.env.DB, {
    projectId: id,
    actorType: 'owner',
    actorId: ownerId,
    eventType: 'project.created',
    summary: `Created project “${title}”.`,
    metadata: { title },
  })

  const row = await findProject(c.env.DB, id, ownerId)
  if (!row) throw notFound('Project was not created')
  return c.json({ project: serializeProject(row) }, 201)
})

projectRoutes.get('/projects/:projectId', async (c) => {
  const ownerId = c.get('user').sub
  const project = await findProject(c.env.DB, c.req.param('projectId'), ownerId)
  if (!project) throw notFound('Project not found')

  const [seasons, episodes, characters, activity] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM seasons WHERE project_id = ? ORDER BY season_number')
      .bind(project.id)
      .all<SeasonRow>(),
    c.env.DB.prepare('SELECT * FROM episodes WHERE project_id = ? ORDER BY episode_number')
      .bind(project.id)
      .all<EpisodeRow>(),
    c.env.DB.prepare('SELECT * FROM characters WHERE project_id = ? ORDER BY name')
      .bind(project.id)
      .all<CharacterRow>(),
    c.env.DB.prepare('SELECT * FROM activity_events WHERE project_id = ? ORDER BY created_at DESC LIMIT 20')
      .bind(project.id)
      .all<ActivityRow>(),
  ])

  return c.json({
    project: serializeProject(project),
    seasons: (seasons.results ?? []).map(serializeSeason),
    episodes: (episodes.results ?? []).map(serializeEpisode),
    characters: (characters.results ?? []).map(serializeCharacter),
    activity: (activity.results ?? []).map((row) => ({
      id: row.id,
      eventType: row.event_type,
      summary: row.summary,
      actorType: row.actor_type,
      createdAt: row.created_at,
    })),
  })
})

projectRoutes.patch('/projects/:projectId', async (c) => {
  const ownerId = c.get('user').sub
  const project = await findProject(c.env.DB, c.req.param('projectId'), ownerId)
  if (!project) throw notFound('Project not found')

  const input = new Input(await readJson(c.req.raw))
  input.rejectUnknown(PROJECT_FIELDS)

  const updates: string[] = []
  const binds: unknown[] = []
  const changed: string[] = []
  const set = (column: string, value: unknown, field: string) => {
    updates.push(`${column} = ?`)
    binds.push(value)
    changed.push(field)
  }

  if (input.has('title')) set('title', input.string('title', 200), 'title')
  if (input.has('status')) set('status', input.enum('status', PROJECT_STATUSES) ?? project.status, 'status')
  if (input.has('logline')) set('logline', input.optionalString('logline', 2000) ?? '', 'logline')
  if (input.has('synopsis')) set('synopsis', input.optionalString('synopsis', 20000) ?? '', 'synopsis')
  if (input.has('genre')) set('genre', input.optionalString('genre', 80) ?? '', 'genre')
  if (input.has('tone')) set('tone', input.optionalString('tone', 120) ?? '', 'tone')
  if (input.has('language')) set('language', input.optionalString('language', 16) ?? 'en', 'language')
  if (input.has('storyBible')) set('story_bible', input.optionalString('storyBible', 200000) ?? '', 'storyBible')
  input.assertClean()

  if (updates.length === 0) {
    return c.json({ project: serializeProject(project), changed: [] })
  }

  const now = nowIso()
  await c.env.DB.prepare(`UPDATE projects SET ${updates.join(', ')}, updated_at = ? WHERE id = ? AND owner_id = ?`)
    .bind(...binds, now, project.id, ownerId)
    .run()

  await logActivity(c.env.DB, {
    projectId: project.id,
    actorType: 'owner',
    actorId: ownerId,
    eventType: 'project.updated',
    summary: `Updated ${changed.length} project field(s): ${changed.join(', ')}.`,
    metadata: { changed },
  })

  const row = await findProject(c.env.DB, project.id, ownerId)
  if (!row) throw notFound('Project not found')
  return c.json({ project: serializeProject(row), changed })
})

projectRoutes.delete('/projects/:projectId', async (c) => {
  const ownerId = c.get('user').sub
  const project = await findProject(c.env.DB, c.req.param('projectId'), ownerId)
  if (!project) throw notFound('Project not found')

  await c.env.DB.prepare('DELETE FROM projects WHERE id = ? AND owner_id = ?').bind(project.id, ownerId).run()
  return c.body(null, 204)
})
