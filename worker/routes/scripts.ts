import { Hono } from 'hono'

import { findEpisode } from '../db'
import { REVIEW_DECISIONS } from '../lib/constants'
import { notFound } from '../lib/errors'
import { Input, readJson } from '../lib/input'
import {
  serializeScene,
  serializeScriptApproval,
  serializeScriptSummary,
  serializeScriptVersion,
} from '../lib/rows'
import { generateEpisodeScript, recordScriptDecision } from '../scripting/service'

import type { SceneRow, ScriptApprovalRow, ScriptVersionRow } from '../lib/rows'
import type { AppBindings } from '../app'

const GENERATE_FIELDS = ['instructions', 'maxScenes', 'temperature'] as const
const DECISION_FIELDS = ['decision', 'note'] as const

export const scriptRoutes = new Hono<AppBindings>()

/** Every version of an episode's script, newest first. */
scriptRoutes.get('/episodes/:episodeId/scripts', async (c) => {
  const ownerId = c.get('user').sub
  const episode = await findEpisode(c.env.DB, c.req.param('episodeId'), ownerId)
  if (!episode) throw notFound('Episode not found')

  const [versions, approvals] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM script_versions WHERE episode_id = ? ORDER BY version DESC')
      .bind(episode.id)
      .all<ScriptVersionRow>(),
    c.env.DB.prepare('SELECT * FROM script_approvals WHERE episode_id = ? ORDER BY created_at DESC')
      .bind(episode.id)
      .all<ScriptApprovalRow>(),
  ])

  return c.json({
    episodeId: episode.id,
    episodeStatus: episode.status,
    scripts: (versions.results ?? []).map(serializeScriptSummary),
    approvals: (approvals.results ?? []).map(serializeScriptApproval),
  })
})

/** Generates one new script version from the configured provider. */
scriptRoutes.post('/episodes/:episodeId/scripts', async (c) => {
  const ownerId = c.get('user').sub
  const input = new Input(await readJson(c.req.raw))
  input.rejectUnknown(GENERATE_FIELDS)
  const instructions = input.optionalString('instructions', 4000) ?? ''
  const maxScenes = input.integer('maxScenes', { min: 1, max: 60 }) ?? null
  const temperature = input.number('temperature', { min: 0, max: 2 }) ?? 0.7
  input.assertClean()

  const outcome = await generateEpisodeScript(c.env.DB, c.env, {
    episodeId: c.req.param('episodeId'),
    ownerId,
    instructions,
    maxScenes,
    temperature,
  })

  const episode = await findEpisode(c.env.DB, outcome.script.episode_id, ownerId)

  return c.json(
    {
      script: serializeScriptVersion(outcome.script),
      scenes: outcome.scenes.map(serializeScene),
      providerLabel: outcome.providerLabel,
      episodeStatus: episode?.status ?? null,
    },
    201,
  )
})

/** One version, with its ordered scenes and every recorded decision. */
scriptRoutes.get('/scripts/:scriptId', async (c) => {
  const ownerId = c.get('user').sub
  const script = await c.env.DB.prepare(
    `SELECT s.* FROM script_versions s
     JOIN projects p ON p.id = s.project_id
     WHERE s.id = ? AND p.owner_id = ?`,
  )
    .bind(c.req.param('scriptId'), ownerId)
    .first<ScriptVersionRow>()
  if (!script) throw notFound('Script not found')

  const [scenes, approvals] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM scenes WHERE script_id = ? ORDER BY scene_index')
      .bind(script.id)
      .all<SceneRow>(),
    c.env.DB.prepare('SELECT * FROM script_approvals WHERE script_id = ? ORDER BY created_at DESC')
      .bind(script.id)
      .all<ScriptApprovalRow>(),
  ])

  const episode = await findEpisode(c.env.DB, script.episode_id, ownerId)

  return c.json({
    script: serializeScriptVersion(script),
    scenes: (scenes.results ?? []).map(serializeScene),
    approvals: (approvals.results ?? []).map(serializeScriptApproval),
    episodeStatus: episode?.status ?? null,
  })
})

/** Appends a review decision. The script body itself is never modified. */
scriptRoutes.post('/scripts/:scriptId/approve', async (c) => {
  const ownerId = c.get('user').sub
  const input = new Input(await readJson(c.req.raw))
  input.rejectUnknown(DECISION_FIELDS)
  const decision = input.enum('decision', REVIEW_DECISIONS)
  const note = input.optionalString('note', 2000) ?? ''
  if (!decision) input.assertClean()
  input.assertClean()

  const outcome = await recordScriptDecision(c.env.DB, {
    scriptId: c.req.param('scriptId'),
    ownerId,
    decision: decision ?? 'changes_requested',
    note,
  })

  return c.json({
    approval: serializeScriptApproval(outcome.approval),
    script: serializeScriptSummary(outcome.script),
    episodeStatus: outcome.episodeStatus,
  })
})
