import type { CharacterRole, EpisodeStatus, ProjectStatus } from './constants'

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
