import { Hono } from 'hono'

import type { AppBindings } from '../app'

export const accountRoutes = new Hono<AppBindings>()

accountRoutes.get('/me', async (c) => {
  const user = c.get('user')
  const stats = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM projects WHERE owner_id = ?1) AS projects,
       (SELECT COUNT(*) FROM episodes e JOIN projects p ON p.id = e.project_id WHERE p.owner_id = ?1) AS episodes`,
  )
    .bind(user.sub)
    .first<{ projects: number; episodes: number }>()

  return c.json({
    user: { sub: user.sub, name: user.name ?? null, email: user.email ?? null, picture: user.picture ?? null },
    stats: { projects: stats?.projects ?? 0, episodes: stats?.episodes ?? 0 },
  })
})
