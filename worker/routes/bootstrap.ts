import { Hono } from 'hono'

import { bootstrapDatabase } from '../migrations'

import type { AppBindings } from '../app'

export const bootstrapRoutes = new Hono<AppBindings>()

/**
 * Creates the studio schema in a brand-new, empty database.
 *
 * This exists because the deployed database cannot be reached with the
 * wrangler CLI from every environment. It is deliberately narrow:
 * same-origin POST only, idempotent statements, and it refuses to touch a
 * partially present schema. See worker/migrations.ts.
 */
bootstrapRoutes.post('/bootstrap', async (c) => {
  const result = await bootstrapDatabase(c.env.DB)
  const status = result.status === 'refused' ? 409 : result.status === 'failed' ? 500 : 200
  return c.json(result, status as 200)
})
