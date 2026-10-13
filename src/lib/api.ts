export interface User {
  sub: string
  name: string | null
  email: string | null
  picture: string | null
}

export type ProjectStatus = 'development' | 'in_production' | 'paused' | 'completed'

export type EpisodeStatus =
  | 'planned'
  | 'script_drafting'
  | 'script_review'
  | 'script_approved'
  | 'art_generating'
  | 'art_review'
  | 'audio_generating'
  | 'video_assembling'
  | 'video_review'
  | 'approved'
  | 'published'
  | 'failed'

export interface Project {
  id: string
  title: string
  logline: string
  synopsis: string
  genre: string
  tone: string
  language: string
  storyBible: string
  status: ProjectStatus
  createdAt: string
  updatedAt: string
  episodeCount?: number
}

export interface Season {
  id: string
  projectId: string
  seasonNumber: number
  title: string
  summary: string
}

export interface Episode {
  id: string
  projectId: string
  seasonId: string | null
  episodeNumber: number
  title: string
  summary: string
  status: EpisodeStatus
  targetDurationSeconds: number | null
  createdAt: string
  updatedAt: string
}

export type CharacterRole = 'protagonist' | 'antagonist' | 'supporting' | 'minor'

export interface Character {
  id: string
  name: string
  role: CharacterRole
  description: string
  appearance: string
}

export interface ActivityEvent {
  id: string
  projectId: string | null
  eventType: string
  summary: string
  actorType: 'owner' | 'system' | 'agent'
  createdAt: string
}

export type IntegrationState =
  | 'connected_verified'
  | 'configured_unverified'
  | 'unavailable'
  | 'not_configured'
  | 'failed'

export interface CapabilityProvider {
  id: string
  label: string
  docsUrl: string
  keyEnvVars: string[]
  defaultModel: string
  needsBaseUrl: boolean
  selected: boolean
}

export interface Capability {
  id: string
  label: string
  phase: string
  state: IntegrationState
  detail: string
  requiredEnvVars: string[]
  presentEnvVars: string[]
  /** False when this build contains no adapter for the capability yet. */
  implemented: boolean
  providers?: CapabilityProvider[]
  model?: string | null
  models?: string[]
  verifiedAt?: string | null
}

export interface ProviderCheckResult {
  capability: string
  provider: string
  providerLabel: string
  model: string | null
  ok: boolean
  detail: string
  latencyMs: number
  models: string[]
  code: string | null
}

export type ScriptParseState = 'parsed' | 'unparsed'
export type ScriptStatus = 'draft' | 'approved' | 'rejected'
export type ReviewDecision = 'approved' | 'rejected' | 'changes_requested'

export interface ScriptSummary {
  id: string
  episodeId: string
  version: number
  status: ScriptStatus
  provider: string
  model: string
  parseState: ScriptParseState
  parseDetail: string | null
  sceneCount: number
  characterCount: number
  inputTokens: number | null
  outputTokens: number | null
  createdBy: string
  createdAt: string
}

export interface ParsedScriptBody {
  title?: string
  logline?: string
  scenes?: unknown[]
  continuityNotes?: string
}

export interface ScriptVersion extends ScriptSummary {
  instructions: string
  rawText: string
  structured: ParsedScriptBody | null
}

export interface DialogueLine {
  speaker: string
  line: string
}

export interface ScriptScene {
  id: string
  scriptId: string
  index: number
  heading: string
  description: string
  narration: string
  dialogue: DialogueLine[]
  imagePrompt: string
  createdAt: string
}

export interface ScriptApproval {
  id: string
  scriptId: string
  decision: ReviewDecision
  note: string
  decidedBy: string
  createdAt: string
}

export interface ScriptList {
  episodeId: string
  episodeStatus: EpisodeStatus
  scripts: ScriptSummary[]
  approvals: ScriptApproval[]
}

export interface ScriptDetail {
  script: ScriptVersion
  scenes: ScriptScene[]
  approvals: ScriptApproval[]
  episodeStatus: EpisodeStatus
}

export interface EpisodeDetail {
  episode: Episode
  project: { id: string; title: string } | null
}

export interface HealthReport {
  status: 'ready' | 'degraded'
  version: string
  runtime: string
  time: string
  origin: string | null
  checks: Record<string, { state: IntegrationState; detail: string; latencyMs?: number; missing?: string[] }>
  capabilities: Array<{ id: string; label: string; state: IntegrationState }>
  migrations: { current: string; applied: boolean }
}

export interface Overview {
  projects: {
    total: number
    byStatus: Record<string, number>
    recent: Array<{ id: string; title: string; status: ProjectStatus; episodeCount: number; updatedAt: string }>
  }
  episodes: { total: number; byStatus: Record<string, number> }
  attention: { failed: number; awaitingReview: number; inDraft: number }
  recentActivity: ActivityEvent[]
  capabilities: Array<{ id: string; label: string; state: IntegrationState; detail: string }>
}

export interface ProjectDetail {
  project: Project
  seasons: Season[]
  episodes: Episode[]
  characters: Character[]
  activity: ActivityEvent[]
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown

  constructor(status: number, message: string, code: string, details: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

async function parse(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { error: text.slice(0, 200) }
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')

  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  const body = await parse(response)

  if (!response.ok) {
    const record = (body ?? {}) as { error?: string; code?: string; details?: unknown }
    throw new ApiError(
      response.status,
      record.error ?? `Request failed with HTTP ${response.status}`,
      record.code ?? 'http_error',
      record.details ?? null,
    )
  }
  return body as T
}

/**
 * Health is readable whether or not the deployment is ready: a degraded
 * report (HTTP 503) is still a report we want to show the owner.
 */
export async function fetchHealth(): Promise<HealthReport> {
  const response = await fetch('/api/health', { credentials: 'same-origin' })
  return (await parse(response)) as HealthReport
}

export async function fetchSession(): Promise<User | null> {
  const response = await fetch('/auth/freebuff/session', { credentials: 'same-origin' })
  if (!response.ok) return null
  const body = (await parse(response)) as { user: User | null } | null
  return body?.user ?? null
}

export function fieldErrors(error: unknown): string[] {
  if (!(error instanceof ApiError)) return []
  if (!Array.isArray(error.details)) return []
  return error.details
    .map((entry) => {
      const item = entry as { field?: string; message?: string }
      return item.field ? `${item.field}: ${item.message ?? 'invalid'}` : (item.message ?? '')
    })
    .filter((line) => line.length > 0)
}
