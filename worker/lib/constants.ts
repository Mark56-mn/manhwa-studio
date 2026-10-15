export const PROJECT_STATUSES = ['development', 'in_production', 'paused', 'completed'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

export const EPISODE_STATUSES = [
  'planned',
  'script_drafting',
  'script_review',
  'script_approved',
  'art_generating',
  'art_review',
  'audio_generating',
  'video_assembling',
  'video_review',
  'approved',
  'published',
  'failed',
] as const
export type EpisodeStatus = (typeof EPISODE_STATUSES)[number]

export const CHARACTER_ROLES = ['protagonist', 'antagonist', 'supporting', 'minor'] as const
export type CharacterRole = (typeof CHARACTER_ROLES)[number]

export const EPISODE_STATUS_LABELS: Record<EpisodeStatus, string> = {
  planned: 'Planned',
  script_drafting: 'Script drafting',
  script_review: 'Script review',
  script_approved: 'Script approved',
  art_generating: 'Art generating',
  art_review: 'Art review',
  audio_generating: 'Audio generating',
  video_assembling: 'Assembling video',
  video_review: 'Video review',
  approved: 'Approved',
  published: 'Published',
  failed: 'Failed',
}

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  development: 'Development',
  in_production: 'In production',
  paused: 'Paused',
  completed: 'Completed',
}

export const SCRIPT_VERSION_STATUSES = ['draft', 'approved', 'rejected'] as const
export type ScriptVersionStatus = (typeof SCRIPT_VERSION_STATUSES)[number]

export const PARSE_STATES = ['parsed', 'unparsed'] as const
export type ParseState = (typeof PARSE_STATES)[number]

export const REVIEW_DECISIONS = ['approved', 'rejected', 'changes_requested'] as const
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number]

/** Tables the application cannot work without. Used by /api/health readiness. */
export const REQUIRED_TABLES = [
  'users',
  'projects',
  'seasons',
  'episodes',
  'characters',
  'script_versions',
  'script_approvals',
  'scenes',
  'provider_checks',
  'activity_events',
  'assets',
] as const
