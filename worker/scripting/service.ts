import { findEpisode, findProject, logActivity } from '../db'
import { HttpError } from '../lib/errors'
import { newId } from '../lib/ids'
import { buildScriptPrompt } from './prompt'
import { parseScriptText } from './parse'
import { findAdapter, readEnvValue } from '../providers'
import { runAiTask } from '../ai/router'
import { routingHttpError } from '../ai/service'
import { nowIso } from '../lib/time'

import type { ParsedScript } from './parse'
import type { CharacterRow, EpisodeRow, SceneRow, SeasonRow, ScriptVersionRow, ScriptApprovalRow } from '../lib/rows'
import type { Env } from '../env'
import type { EpisodeStatus, ReviewDecision } from '../lib/constants'

export const DEFAULT_MAX_OUTPUT_TOKENS = 6000
const MIN_OUTPUT_TOKENS = 512
const MAX_OUTPUT_TOKENS = 32000
const MAX_INSTRUCTIONS = 4000

/** Episode stages that a new script draft is allowed to move back to review. */
const SCRIPT_STAGE_STATUSES: EpisodeStatus[] = [
  'planned',
  'script_drafting',
  'script_review',
  'script_approved',
  'failed',
]

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function resolveMaxOutputTokens(env: Env): number {
  const raw = readEnvValue(env, 'SCRIPT_MAX_OUTPUT_TOKENS')
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_OUTPUT_TOKENS
  return clamp(parsed, MIN_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS)
}

/** Maps a router/provider failure onto an HTTP status the studio can report. */
export function providerHttpError(error: unknown, provider: string): HttpError {
  return routingHttpError(error, provider)
}

export interface GenerateScriptParams {
  episodeId: string
  ownerId: string
  instructions: string
  maxScenes: number | null
  temperature: number
}

export interface GenerateScriptOutcome {
  script: ScriptVersionRow
  scenes: SceneRow[]
  providerLabel: string
  parseState: 'parsed' | 'unparsed'
  parseDetail: string | null
}

async function loadContext(
  db: D1Database,
  episodeId: string,
  ownerId: string,
): Promise<{ episode: EpisodeRow; project: NonNullable<Awaited<ReturnType<typeof findProject>>>; season: SeasonRow | null; characters: CharacterRow[] }> {
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

export async function nextScriptVersion(db: D1Database, episodeId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(MAX(version), 0) AS max_version FROM script_versions WHERE episode_id = ?')
    .bind(episodeId)
    .first<{ max_version: number }>()
  return (row?.max_version ?? 0) + 1
}

/**
 * Generates one new script version. Nothing is written unless the provider
 * actually returned usable text: a failed generation leaves the episode exactly
 * as it was, and the failure is reported instead of being stored as a script.
 */
export async function generateEpisodeScript(
  db: D1Database,
  env: Env,
  params: GenerateScriptParams,
): Promise<GenerateScriptOutcome> {
  const { episode, project, season, characters } = await loadContext(db, params.episodeId, params.ownerId)

  const { system, prompt } = buildScriptPrompt({
    project,
    episode,
    season,
    characters,
    instructions: params.instructions.slice(0, MAX_INSTRUCTIONS),
    maxScenes: params.maxScenes,
  })

  const maxOutputTokens = resolveMaxOutputTokens(env)
  const temperature = clamp(params.temperature, 0, 2)
  const taskId = newId('task')

  // The router chooses and fails over the provider/model. The script artifact
  // stores the raw answer plus an honest parse_state, so a non-JSON answer is
  // still a real, stored artifact rather than a fabricated success.
  let result
  try {
    result = await runAiTask(env, db, {
      role: 'script',
      task: 'script',
      ownerId: params.ownerId,
      taskId,
      requirements: { structured: false, tools: false, streaming: false, minContext: null },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      temperature,
      maxOutputTokens,
      validate: () => ({ ok: true, detail: 'stored verbatim; parse_state records whether it parsed' }),
    })
  } catch (error) {
    throw routingHttpError(error, 'script')
  }

  const providerLabel = findAdapter(result.provider)?.label ?? result.provider

  const outcome = parseScriptText(result.text)
  const parsedScript: ParsedScript | null = outcome.ok ? outcome.script : null
  const parseDetail = outcome.detail

  const version = await nextScriptVersion(db, episode.id)
  const scriptId = newId('scr')
  const now = nowIso()

  const scriptRow: ScriptVersionRow = {
    id: scriptId,
    episode_id: episode.id,
    project_id: project.id,
    version,
    status: 'draft',
    provider: result.provider,
    model: result.model,
    instructions: params.instructions.slice(0, MAX_INSTRUCTIONS),
    prompt_json: JSON.stringify({ system, prompt, maxOutputTokens, temperature }),
    raw_text: result.text,
    structured_json: parsedScript ? JSON.stringify(parsedScript) : null,
    parse_state: parsedScript ? 'parsed' : 'unparsed',
    parse_detail: parseDetail,
    input_tokens: result.usage.inputTokens,
    output_tokens: result.usage.outputTokens,
    created_by: params.ownerId,
    created_at: now,
  }

  const sceneRows: SceneRow[] = (parsedScript?.scenes ?? []).map((scene, index) => ({
    id: newId('scn'),
    episode_id: episode.id,
    script_id: scriptId,
    scene_index: index + 1,
    heading: scene.heading,
    description: scene.description,
    narration: scene.narration,
    dialogue_json: JSON.stringify(scene.dialogue),
    image_prompt: scene.imagePrompt,
    created_at: now,
  }))

  const nextStatus: EpisodeStatus = SCRIPT_STAGE_STATUSES.includes(episode.status) ? 'script_review' : episode.status

  const statements = [
    db
      .prepare(
        `INSERT INTO script_versions
           (id, episode_id, project_id, version, status, provider, model, instructions, prompt_json,
            raw_text, structured_json, parse_state, parse_detail, input_tokens, output_tokens, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        scriptRow.id,
        scriptRow.episode_id,
        scriptRow.project_id,
        scriptRow.version,
        scriptRow.status,
        scriptRow.provider,
        scriptRow.model,
        scriptRow.instructions,
        scriptRow.prompt_json,
        scriptRow.raw_text,
        scriptRow.structured_json,
        scriptRow.parse_state,
        scriptRow.parse_detail,
        scriptRow.input_tokens,
        scriptRow.output_tokens,
        scriptRow.created_by,
        scriptRow.created_at,
      ),
    ...sceneRows.map((scene) =>
      db
        .prepare(
          `INSERT INTO scenes
             (id, episode_id, script_id, scene_index, heading, description, narration, dialogue_json, image_prompt, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          scene.id,
          scene.episode_id,
          scene.script_id,
          scene.scene_index,
          scene.heading,
          scene.description,
          scene.narration,
          scene.dialogue_json,
          scene.image_prompt,
          scene.created_at,
        ),
    ),
    db
      .prepare('UPDATE episodes SET status = ?, updated_at = ? WHERE id = ?')
      .bind(nextStatus, now, episode.id),
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').bind(now, project.id),
  ]

  try {
    await db.batch(statements)
  } catch (error) {
    throw new HttpError(
      500,
      `The script was generated but could not be saved: ${error instanceof Error ? error.message : 'unknown error'}`,
      'script_not_saved',
      { provider: result.provider, model: scriptRow.model },
    )
  }

  await logActivity(db, {
    projectId: project.id,
    actorType: 'agent',
    actorId: result.provider,
    eventType: 'script.generated',
    summary: `Script AI (${providerLabel}, ${scriptRow.model}) produced script v${version} for episode ${episode.episode_number}: ${sceneRows.length} scene(s), ${
      parsedScript ? 'parsed' : 'stored unparsed'
    }.`,
    metadata: {
      episodeId: episode.id,
      scriptId,
      version,
      provider: scriptRow.provider,
      model: scriptRow.model,
      parseState: scriptRow.parse_state,
      scenes: sceneRows.length,
      inputTokens: scriptRow.input_tokens,
      outputTokens: scriptRow.output_tokens,
    },
  })

  return {
    script: scriptRow,
    scenes: sceneRows,
    providerLabel,
    parseState: scriptRow.parse_state,
    parseDetail: parseDetail,
  }
}

const DECISION_STATUS: Record<ReviewDecision, EpisodeStatus> = {
  approved: 'script_approved',
  changes_requested: 'script_review',
  rejected: 'script_drafting',
}

/**
 * Records a review decision. This appends to `script_approvals` and never edits
 * the script body, so an approved script cannot be silently rewritten.
 */
export async function recordScriptDecision(
  db: D1Database,
  params: { scriptId: string; ownerId: string; decision: ReviewDecision; note: string },
): Promise<{ approval: ScriptApprovalRow; script: ScriptVersionRow; episodeStatus: EpisodeStatus }> {
  const script = await db
    .prepare(
      `SELECT s.* FROM script_versions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.id = ? AND p.owner_id = ?`,
    )
    .bind(params.scriptId, params.ownerId)
    .first<ScriptVersionRow>()
  if (!script) throw new HttpError(404, 'Script not found', 'not_found')

  const episode = await findEpisode(db, script.episode_id, params.ownerId)
  if (!episode) throw new HttpError(404, 'Episode not found', 'not_found')

  const now = nowIso()
  const approval: ScriptApprovalRow = {
    id: newId('apv'),
    script_id: script.id,
    episode_id: script.episode_id,
    decision: params.decision,
    note: params.note,
    decided_by: params.ownerId,
    created_at: now,
  }

  const scriptStatus = params.decision === 'approved' ? 'approved' : params.decision === 'rejected' ? 'rejected' : 'draft'
  const episodeStatus = DECISION_STATUS[params.decision]

  await db.batch([
    db
      .prepare(
        `INSERT INTO script_approvals (id, script_id, episode_id, decision, note, decided_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        approval.id,
        approval.script_id,
        approval.episode_id,
        approval.decision,
        approval.note,
        approval.decided_by,
        approval.created_at,
      ),
    db.prepare('UPDATE script_versions SET status = ? WHERE id = ?').bind(scriptStatus, script.id),
    db.prepare('UPDATE episodes SET status = ?, updated_at = ? WHERE id = ?').bind(episodeStatus, now, episode.id),
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').bind(now, script.project_id),
  ])

  await logActivity(db, {
    projectId: script.project_id,
    actorType: 'owner',
    actorId: params.ownerId,
    eventType: `script.${params.decision}`,
    summary: `${params.decision === 'approved' ? 'Approved' : params.decision === 'rejected' ? 'Rejected' : 'Requested changes on'} script v${script.version} for episode ${episode.episode_number}.${params.note ? ` Note: ${params.note}` : ''}`,
    metadata: { episodeId: episode.id, scriptId: script.id, version: script.version, decision: params.decision },
  })

  return {
    approval,
    script: { ...script, status: scriptStatus },
    episodeStatus,
  }
}

export { parseScriptText }
