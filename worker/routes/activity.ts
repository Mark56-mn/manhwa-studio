import { Hono } from 'hono'

import { findProject } from '../db'
import { notFound } from '../lib/errors'
import { Input } from '../lib/input'
import { serializeActivity } from '../lib/rows'

import type { ActivityRow } from '../lib/rows'
import type { AppBindings } from '../app'

export const activityRoutes = new Hono<AppBindings>()

activityRoutes.get('/activity', async (c) => {
  const ownerId = c.get('user').sub
  const input = new Input({ limit: c.req.query('limit'), projectId: c.req.query('projectId') })
  const limit = Math.min(input.integer('limit', { min: 1, max: 100 }) ?? 20, 100)
  const projectId = input.optionalString('projectId', 80)
  input.assertClean()

  if (projectId) {
    const project = await findProject(c.env.DB, projectId, ownerId)
    if (!project) throw notFound('Project not found')
    const rows = await c.env.DB.prepare(
      'SELECT * FROM activity_events WHERE project_id = ? ORDER BY created_at DESC LIMIT ?',
    )
      .bind(projectId, limit)
      .all<ActivityRow>()
    return c.json({ events: (rows.results ?? []).map(serializeActivity) })
  }

  const rows = await c.env.DB.prepare(
    `SELECT a.* FROM activity_events a
     LEFT JOIN projects p ON p.id = a.project_id
     WHERE a.project_id IS NULL OR p.owner_id = ?
     ORDER BY a.created_at DESC LIMIT ?`,
  )
    .bind(ownerId, limit)
    .all<ActivityRow>()

  return c.json({ events: (rows.results ?? []).map(serializeActivity) })
})
