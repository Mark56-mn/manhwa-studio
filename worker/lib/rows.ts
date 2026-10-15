import type {
  CharacterRole,
  EpisodeStatus,
  ParseState,
  ProjectStatus,
  ReviewDecision,
  ScriptVersionStatus,
} from './constants'

export interface UserRow {
  id: string
  email: string | null
  display_name: string | null
  picture: string | null
  created_at: string
  last_seen_at: string
}

export interface ProjectRow {
  id: string
  owner_id: string
  title: string
  logline: string
  synopsis: string
  genre: string
  tone: string
  language: string
  story_bible: string
  status: ProjectStatus
  created_at: string
  updated_at: string
}

export interface SeasonRow {
  id: string
  project_id: string
  season_number: number
  title: string
  summary: string
  created_at: string
  updated_at: string
}

export interface EpisodeRow {
  id: string
  project_id: string
  season_id: string | null
  episode_number: number
  title: string
  summary: string
  status: EpisodeStatus
  target_duration_seconds: number | null
  created_at: string
  updated_at: string
}

export interface CharacterRow {
  id: string
  project_id: string
  name: string
  role: CharacterRole
  description: string
  appearance: string
  created_at: string
  updated_at: string
}

export interface ActivityRow {
  id: string
  project_id: string | null
  actor_type: 'owner' | 'system' | 'agent'
  actor_id: string | null
  event_type: string
  summary: string
  metadata_json: string
  created_at: string
}

export function serializeProject(row: ProjectRow) {
  return {
    id: row.id,
    title: row.title,
    logline: row.logline,
    synopsis: row.synopsis,
    genre: row.genre,
    tone: row.tone,
    language: row.language,
    storyBible: row.story_bible,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function serializeSeason(row: SeasonRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    seasonNumber: row.season_number,
    title: row.title,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function serializeEpisode(row: EpisodeRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    seasonId: row.season_id,
    episodeNumber: row.episode_number,
    title: row.title,
    summary: row.summary,
    status: row.status,
    targetDurationSeconds: row.target_duration_seconds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function serializeCharacter(row: CharacterRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    role: row.role,
    description: row.description,
    appearance: row.appearance,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function serializeActivity(row: ActivityRow) {
  let metadata: unknown
  try {
    metadata = JSON.parse(row.metadata_json)
  } catch {
    metadata = { unparsable: true }
  }
  return {
    id: row.id,
    projectId: row.project_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    eventType: row.event_type,
    summary: row.summary,
    metadata,
    createdAt: row.created_at,
  }
}

export type SerializedProject = ReturnType<typeof serializeProject>
export type SerializedSeason = ReturnType<typeof serializeSeason>
export type SerializedEpisode = ReturnType<typeof serializeEpisode>
export type SerializedCharacter = ReturnType<typeof serializeCharacter>
export type SerializedActivity = ReturnType<typeof serializeActivity>

export interface ScriptVersionRow {
  id: string
  episode_id: string
  project_id: string
  version: number
  status: ScriptVersionStatus
  provider: string
  model: string
  instructions: string
  prompt_json: string
  raw_text: string
  structured_json: string | null
  parse_state: ParseState
  parse_detail: string | null
  input_tokens: number | null
  output_tokens: number | null
  created_by: string
  created_at: string
}

export interface SceneRow {
  id: string
  episode_id: string
  script_id: string
  scene_index: number
  heading: string
  description: string
  narration: string
  dialogue_json: string
  image_prompt: string
  created_at: string
}

export interface ScriptApprovalRow {
  id: string
  script_id: string
  episode_id: string
  decision: ReviewDecision
  note: string
  decided_by: string
  created_at: string
}

export interface ProviderCheckRow {
  id: string
  capability: string
  provider: string
  model: string | null
  status: 'ok' | 'failed'
  detail: string
  latency_ms: number | null
  models_json: string
  checked_by: string | null
  checked_at: string
}

function parseJson(value: string | null): unknown {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/**
 * Summary form used by the version list: no script body, so listing versions
 * stays small even for long episodes.
 */
export function serializeScriptSummary(row: ScriptVersionRow) {
  return {
    id: row.id,
    episodeId: row.episode_id,
    version: row.version,
    status: row.status,
    provider: row.provider,
    model: row.model,
    parseState: row.parse_state,
    parseDetail: row.parse_detail,
    sceneCount: (parseJson(row.structured_json) as { scenes?: unknown[] } | null)?.scenes?.length ?? 0,
    characterCount: row.raw_text.length,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }
}

/** Full form, including the model's own words and the parsed scenes. */
export function serializeScriptVersion(row: ScriptVersionRow) {
  return {
    ...serializeScriptSummary(row),
    instructions: row.instructions,
    rawText: row.raw_text,
    structured: parseJson(row.structured_json),
  }
}

export function serializeScene(row: SceneRow) {
  const dialogue = parseJson(row.dialogue_json)
  return {
    id: row.id,
    scriptId: row.script_id,
    index: row.scene_index,
    heading: row.heading,
    description: row.description,
    narration: row.narration,
    dialogue: Array.isArray(dialogue) ? dialogue : [],
    imagePrompt: row.image_prompt,
    createdAt: row.created_at,
  }
}

export function serializeScriptApproval(row: ScriptApprovalRow) {
  return {
    id: row.id,
    scriptId: row.script_id,
    decision: row.decision,
    note: row.note,
    decidedBy: row.decided_by,
    createdAt: row.created_at,
  }
}

export function serializeProviderCheck(row: ProviderCheckRow) {
  const models = parseJson(row.models_json)
  return {
    capability: row.capability,
    provider: row.provider,
    model: row.model,
    status: row.status,
    detail: row.detail,
    latencyMs: row.latency_ms,
    models: Array.isArray(models) ? (models as string[]) : [],
    checkedBy: row.checked_by,
    checkedAt: row.checked_at,
  }
}

export type AssetType = 'image' | 'audio' | 'video' | 'script' | 'other'
export type AssetStatus = 'uploading' | 'uploaded' | 'failed' | 'deleted'

export interface AssetRow {
  id: string
  project_id: string
  episode_id: string | null
  type: AssetType
  storage_key: string
  content_type: string
  content_length: number
  checksum: string
  metadata_json: string
  status: AssetStatus
  created_at: string
}

export function serializeAsset(row: AssetRow) {
  let metadata: unknown
  try {
    metadata = JSON.parse(row.metadata_json)
  } catch {
    metadata = { unparsable: true }
  }
  return {
    id: row.id,
    projectId: row.project_id,
    episodeId: row.episode_id,
    type: row.type,
    storageKey: row.storage_key,
    contentType: row.content_type,
    contentLength: row.content_length,
    checksum: row.checksum,
    metadata,
    status: row.status,
    createdAt: row.created_at,
  }
}

export type SerializedAsset = ReturnType<typeof serializeAsset>
