import { Hono } from 'hono'

import { findEpisode } from '../db'
import { notFound } from '../lib/errors'
import { Input, readJson } from '../lib/input'
import { serializeDirectorPlan } from '../lib/rows'
import { planEpisode } from '../director/service'

import type { DirectorPlanRow } from '../lib/rows'
import type { AppBindings } from '../app'

const PLAN_FIELDS = ['instructions', 'temperature'] as const

export const directorRoutes = new Hono<AppBindings>()

/** Every Director AI plan for an episode, newest first. */
directorRoutes.get('/episodes/:episodeId/director/plans', async (c) => {
  const ownerId = c.get('user').sub
  const episode = await findEpisode(c.env.DB, c.req.param('episodeId'), ownerId)
  if (!episode) throw notFound('Episode not found')

  const plans = await c.env.DB.prepare('SELECT * FROM director_plans WHERE episode_id = ? ORDER BY version DESC')
    .bind(episode.id)
    .all<DirectorPlanRow>()

  return c.json({
    episodeId: episode.id,
    plans: (plans.results ?? []).map((row) => serializeDirectorPlan(row, false)),
  })
})

/** Runs the Director AI worker and stores a new immutable plan version. */
directorRoutes.post('/episodes/:episodeId/director/plan', async (c) => {
  const ownerId = c.get('user').sub
  const input = new Input(await readJson(c.req.raw))
  input.rejectUnknown(PLAN_FIELDS)
  const instructions = input.optionalString('instructions', 4000) ?? ''
  const temperature = input.number('temperature', { min: 0, max: 2 }) ?? 0.4
  input.assertClean()

  const outcome = await planEpisode(c.env.DB, c.env, {
    episodeId: c.req.param('episodeId'),
    ownerId,
    instructions,
    temperature,
  })

  return c.json(
    {
      plan: serializeDirectorPlan(outcome.plan),
      providerLabel: outcome.providerLabel,
      failovers: outcome.failovers,
    },
    201,
  )
})
