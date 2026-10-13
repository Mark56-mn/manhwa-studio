import { Hono } from 'hono'

import { findProject, logActivity } from '../db'
import { conflict, notFound } from '../lib/errors'
import { newId } from '../lib/ids'
import { Input, readJson } from '../lib/input'
import { serializeSeason } from '../lib/rows'
import { nowIso } from '../lib/time'

import type { SeasonRow } from '../lib/rows'
import type { AppBindings } from '../app'

const SEASON_FIELDS = ['seasonNumber', 'title', 'summary'] as const

export const seasonRoutes = new Hono<AppBindings>()

seasonRoutes.get('/projects/:projectId/seasons', async (c) => {
  const ownerId = c.get('user').sub
  const project = await findProject(c.env.DB, c.req.param('projectId'), ownerId)
  if (!project) throw notFound('Project not found')

  const rows = await c.env.DB.prepare('SELECT * FROM seasons WHERE project_id = ? ORDER BY season_number')
    .bind(project.id)
    .all<SeasonRow>()
  return c.json({ seasons: (rows.results ?? []).map(serializeSeason) })
})

seasonRoutes.post('/projects/:projectId/seasons', async (c) => {
  const ownerId = c.get('user').sub
  const project = await findProject(c.env.DB, c.req.param('projectId'), ownerId)
  if (!project) throw notFound('Project not found')

  const input = new Input(await readJson(c.req.raw))
  input.rejectUnknown(SEASON_FIELDS)
  const title = input.optionalString('title', 200) ?? ''
  const summary = input.optionalString('summary', 20000) ?? ''
  const requested = input.integer('seasonNumber', { min: 1, max: 1000 })
  input.assertClean()

  const existing = await c.env.DB.prepare('SELECT COALESCE(MAX(season_number), 0) AS max_number FROM seasons WHERE project_id = ?')
    .bind(project.id)
    .first<{ max_number: number }>()
  const seasonNumber = requested ?? (existing?.max_number ?? 0) + 1

  const clash = await c.env.DB.prepare('SELECT id FROM seasons WHERE project_id = ? AND season_number = ?')
    .bind(project.id, seasonNumber)
    .first<{ id: string }>()
  if (clash) throw conflict(`Season ${seasonNumber} already exists in this project`)

  const now = nowIso()
  const id = newId('sea')
  await c.env.DB.prepare(
    `INSERT INTO seasons (id, project_id, season_number, title, summary, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, project.id, seasonNumber, title, summary, now, now)
    .run()

  await logActivity(c.env.DB, {
    projectId: project.id,
    actorType: 'owner',
    actorId: ownerId,
    eventType: 'season.created',
    summary: `Created season ${seasonNumber}${title ? `: “${title}”` : ''}.`,
    metadata: { seasonId: id },
  })

  const row = await c.env.DB.prepare('SELECT * FROM seasons WHERE id = ?').bind(id).first<SeasonRow>()
  if (!row) throw notFound('Season was not created')
  return c.json({ season: serializeSeason(row) }, 201)
})

seasonRoutes.delete('/seasons/:seasonId', async (c) => {
  const ownerId = c.get('user').sub
  const row = await c.env.DB.prepare(
    `SELECT s.* FROM seasons s JOIN projects p ON p.id = s.project_id WHERE s.id = ? AND p.owner_id = ?`,
  )
    .bind(c.req.param('seasonId'), ownerId)
    .first<SeasonRow>()
  if (!row) throw notFound('Season not found')

  await c.env.DB.prepare('DELETE FROM seasons WHERE id = ?').bind(row.id).run()
  return c.body(null, 204)
})
