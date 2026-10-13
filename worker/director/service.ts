import { findEpisode, findProject, logActivity } from '../db'
import { HttpError } from '../lib/errors'
import { newId } from '../lib/ids'
import { nowIso } from '../lib/time'
import { runAiTask } from '../ai/router'
import { routingHttpError } from '../ai/service'
import { buildDirectorPrompt } from './prompt'

import type { CharacterRow, DirectorPlanRow, EpisodeRow, ProjectRow, SeasonRow } from '../lib/rows'
import type { AiMessage } from '../providers/types'
import type { Env } from '../env'

const MAX_INSTRUCTIONS = 4000
const MAX_BEATS = 60

export interface DirectorBeat {
  index: number
  summary: string
  sceneIntent: string
  characters: string[]
  emotionalBeat: string
}

export interface DirectorPlan {
  title: string
  objective: string
  beats: DirectorBeat[]
  sceneCount: number | null
  imageNotes: string
  voiceNotes: string
  continuityWatch: string[]
}

export type DirectorPlanParse =
  | { ok: true; plan: DirectorPlan; detail: string }
  | { ok: false; detail: string }

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asText(value: unknown, max = 20000): string {
  if (typeof value === 'string') return value.trim().slice(0, max)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** Tolerant extraction + strict validation, exactly like the script parser. */
export function parseDirectorPlan(raw: string): DirectorPlanParse {
  if (raw.trim().length === 0) return { ok: false, detail: 'The provider returned an empty response.' }
  const trimmed = raw.trim()
  const fenced = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed)
  const text = fenced && typeof fenced[1] === 'string' ? fenced[1].trim() : trimmed

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end <= start) {
      return { ok: false, detail: 'The response was not JSON and contained no JSON object.' }
    }
    try {
      parsed = JSON.parse(text.slice(start, end + 1))
    } catch (error) {
      return {
        ok: false,
        detail: `The response could not be parsed as JSON (${error instanceof Error ? error.message : 'unknown error'}).`,
      }
    }
  }

  const root = asRecord(parsed)
  if (!root) return { ok: false, detail: 'The JSON response was not an object.' }

  const rawBeats = root.beats
  if (!Array.isArray(rawBeats) || rawBeats.length === 0) {
    return { ok: false, detail: 'The JSON response had no non-empty "beats" array.' }
  }

  const beats: DirectorBeat[] = []
  for (const entry of rawBeats.slice(0, MAX_BEATS)) {
    const record = asRecord(entry)
    if (!record) continue
    const summary = asText(record.summary ?? record.description ?? record.beat, 4000)
    if (!summary) continue
    const characters = Array.isArray(record.characters)
      ? record.characters.map((name) => asText(name, 120)).filter((name) => name.length > 0)
      : []
    beats.push({
      index: typeof record.index === 'number' ? record.index : beats.length + 1,
      summary,
      sceneIntent: asText(record.sceneIntent ?? record.scene_intent ?? record.intent, 4000),
      characters,
      emotionalBeat: asText(record.emotionalBeat ?? record.emotional_beat ?? record.emotion, 1000),
    })
  }

  if (beats.length === 0) return { ok: false, detail: 'No beat had a usable summary.' }

  const sceneCount = typeof root.sceneCount === 'number' ? root.sceneCount : typeof root.scene_count === 'number' ? root.scene_count : null
  const rawWatch = root.continuityWatch ?? root.continuity_watch
  const continuityWatch = Array.isArray(rawWatch)
    ? rawWatch.map((entry) => asText(entry, 2000)).filter((entry) => entry.length > 0)
    : []

  return {
    ok: true,
    detail: `Parsed ${beats.length} beat(s).`,
    plan: {
      title: asText(root.title, 300),
      objective: asText(root.objective, 2000),
      beats,
      sceneCount,
      imageNotes: asText(root.imageNotes ?? root.image_notes, 8000),
      voiceNotes: asText(root.voiceNotes ?? root.voice_notes, 8000),
      continuityWatch,
    },
  }
}

async function loadContext(
  db: D1Database,
  episodeId: string,
  ownerId: string,
): Promise<{ episode: EpisodeRow; project: ProjectRow; season: SeasonRow | null; characters: CharacterRow[] }> {
  const episode = await findEpisode(db, episodeId, ownerId)
  if (!episode) throw new HttpError(404, 'Episode not found', 'not_found')
  const project = await findProject(db, episode.project_id, ownerId)
  if (!project) throw new HttpError(404, 'Project not found', 'not_found')

  const [season, characters] = await Promise.all([
    episode.season_id
      ? db.prepare('SELECT * FROM seasons WHERE id = ?').bind(episode.season_id).first<SeasonRow>()
      : Promise.resolve(null),
    db
      .prepare('SELECT * FROM characters WHERE project_id = ? ORDER BY name')
      .bind(project.id)
      .all<CharacterRow>()
      .then((result) => result.results ?? []),
  ])

  return { episode, project, season: season ?? null, characters }
}

export interface PlanEpisodeParams {
  episodeId: string
  ownerId: string
  instructions: string
  temperature: number
}

export interface PlanEpisodeOutcome {
  plan: DirectorPlanRow
  providerLabel: string
  failovers: number
}

/**
 * Runs the Director AI worker through the router and stores the plan as a new,
 * immutable version. A plan that cannot be parsed is never stored as a success:
 * the router repairs once, then fails over to another compatible model.
 */
export async function planEpisode(
  db: D1Database,
  env: Env,
  params: PlanEpisodeParams,
): Promise<PlanEpisodeOutcome> {
  const { episode, project, season, characters } = await loadContext(db, params.episodeId, params.ownerId)
  const { system, prompt } = buildDirectorPrompt({
    project,
    episode,
    season,
    characters,
    instructions: params.instructions.slice(0, MAX_INSTRUCTIONS),
  })

  const taskId = newId('task')
  let result
  try {
    result = await runAiTask(env, db, {
      role: 'director',
      task: 'director_plan',
      ownerId: params.ownerId,
      taskId,
      requirements: { structured: true, tools: false, streaming: false, minContext: null },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      temperature: params.temperature,
      maxOutputTokens: 4000,
      responseFormat: { type: 'json_object' },
      validate: (text) => {
        const outcome = parseDirectorPlan(text)
        return { ok: outcome.ok, detail: outcome.detail }
      },
      repairPrompt: (failureDetail, previousText): AiMessage[] => [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
        { role: 'assistant', content: previousText },
        {
          role: 'user',
          content: `Your previous answer could not be used: ${failureDetail} Reply with only the corrected JSON object.`,
        },
      ],
    })
  } catch (error) {
    throw routingHttpError(error, 'director')
  }

  const parsed = parseDirectorPlan(result.text)
  const versionRow = await db
    .prepare('SELECT COALESCE(MAX(version), 0) AS max_version FROM director_plans WHERE episode_id = ?')
    .bind(episode.id)
    .first<{ max_version: number }>()
  const version = (versionRow?.max_version ?? 0) + 1
  const now = nowIso()

  const planRow: DirectorPlanRow = {
    id: newId('dpl'),
    episode_id: episode.id,
    project_id: project.id,
    version,
    provider: result.provider,
    model: result.model,
    raw_text: result.text,
    plan_json: parsed.ok ? JSON.stringify(parsed.plan) : null,
    parse_state: parsed.ok ? 'parsed' : 'unparsed',
    parse_detail: parsed.detail,
    input_tokens: result.usage.inputTokens,
    output_tokens: result.usage.outputTokens,
    created_by: params.ownerId,
    created_at: now,
  }

  await db.batch([
    db
      .prepare(
        `INSERT INTO director_plans
           (id, episode_id, project_id, version, provider, model, raw_text, plan_json, parse_state, parse_detail,
            input_tokens, output_tokens, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        planRow.id,
        planRow.episode_id,
        planRow.project_id,
        planRow.version,
        planRow.provider,
        planRow.model,
        planRow.raw_text,
        planRow.plan_json,
        planRow.parse_state,
        planRow.parse_detail,
        planRow.input_tokens,
        planRow.output_tokens,
        planRow.created_by,
        planRow.created_at,
      ),
    db.prepare('UPDATE episodes SET updated_at = ? WHERE id = ?').bind(now, episode.id),
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').bind(now, project.id),
  ])

  await logActivity(db, {
    projectId: project.id,
    actorType: 'agent',
    actorId: result.provider,
    eventType: 'director.planned',
    summary: `Director AI (${result.provider} · ${result.model}) produced plan v${version} for episode ${episode.episode_number}: ${parsed.ok ? `${parsed.plan.beats.length} beat(s)` : 'stored unparsed'}${result.attempts.length > 1 ? `, ${result.failovers} failover(s)` : ''}.`,
    metadata: {
      episodeId: episode.id,
      planId: planRow.id,
      version,
      provider: result.provider,
      model: result.model,
      parseState: planRow.parse_state,
      attempts: result.attempts.length,
      failovers: result.failovers,
    },
  })

  return { plan: planRow, providerLabel: result.provider, failovers: result.failovers }
}

