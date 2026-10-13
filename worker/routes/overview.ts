import { Hono } from 'hono'

import { capabilityStatuses } from '../capabilities'
import { serializeActivity } from '../lib/rows'

import type { ActivityRow } from '../lib/rows'
import type { AppBindings } from '../app'

export const overviewRoutes = new Hono<AppBindings>()

overviewRoutes.get('/overview', async (c) => {
  const ownerId = c.get('user').sub
  const db = c.env.DB

  const [projectsByStatus, episodesByStatus, recent, projects] = await Promise.all([
    db
      .prepare('SELECT status, COUNT(*) AS count FROM projects WHERE owner_id = ? GROUP BY status')
      .bind(ownerId)
      .all<{ status: string; count: number }>(),
    db
      .prepare(
        `SELECT e.status AS status, COUNT(*) AS count FROM episodes e
         JOIN projects p ON p.id = e.project_id
         WHERE p.owner_id = ? GROUP BY e.status`,
      )
      .bind(ownerId)
      .all<{ status: string; count: number }>(),
    db
      .prepare(
        `SELECT a.* FROM activity_events a
         LEFT JOIN projects p ON p.id = a.project_id
         WHERE a.project_id IS NULL OR p.owner_id = ?
         ORDER BY a.created_at DESC LIMIT 8`,
      )
      .bind(ownerId)
      .all<ActivityRow>(),
    db
      .prepare(
        `SELECT p.id, p.title, p.status, p.updated_at,
                (SELECT COUNT(*) FROM episodes e WHERE e.project_id = p.id) AS episode_count
         FROM projects p WHERE p.owner_id = ? ORDER BY p.updated_at DESC LIMIT 5`,
      )
      .bind(ownerId)
      .all<{ id: string; title: string; status: string; updated_at: string; episode_count: number }>(),
  ])

  const episodeCounts = new Map((episodesByStatus.results ?? []).map((row) => [row.status, row.count]))
  const countOf = (...statuses: string[]) => statuses.reduce((total, status) => total + (episodeCounts.get(status) ?? 0), 0)

  return c.json({
    projects: {
      total: (projectsByStatus.results ?? []).reduce((sum, row) => sum + row.count, 0),
      byStatus: Object.fromEntries((projectsByStatus.results ?? []).map((row) => [row.status, row.count])),
      recent: (projects.results ?? []).map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        episodeCount: row.episode_count,
        updatedAt: row.updated_at,
      })),
    },
    episodes: {
      total: (episodesByStatus.results ?? []).reduce((sum, row) => sum + row.count, 0),
      byStatus: Object.fromEntries((episodesByStatus.results ?? []).map((row) => [row.status, row.count])),
    },
    attention: {
      failed: countOf('failed'),
      awaitingReview: countOf('script_review', 'art_review', 'video_review'),
      inDraft: countOf('script_drafting', 'art_generating', 'audio_generating', 'video_assembling'),
    },
    recentActivity: (recent.results ?? []).map(serializeActivity),
    capabilities: capabilityStatuses(c.env).map(({ id, label, state, detail }) => ({ id, label, state, detail })),
  })
})
