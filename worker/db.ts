import type { FreebuffUser } from '@freebuff/auth'

import { newId } from './lib/ids'
import type { CharacterRow, EpisodeRow, ProjectRow } from './lib/rows'
import { nowIso } from './lib/time'

/** Creates or refreshes the local user row for a signed-in Freebuff account. */
export async function ensureUser(db: D1Database, user: FreebuffUser): Promise<void> {
  const now = nowIso()
  await db
    .prepare(
      `INSERT INTO users (id, email, display_name, picture, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         email = excluded.email,
         display_name = excluded.display_name,
         picture = excluded.picture,
         last_seen_at = excluded.last_seen_at`,
    )
    .bind(user.sub, user.email ?? null, user.name ?? null, user.picture ?? null, now, now)
    .run()
}

export async function logActivity(
  db: D1Database,
  event: {
    projectId: string | null
    actorType: 'owner' | 'system' | 'agent'
    actorId: string | null
    eventType: string
    summary: string
    metadata?: Record<string, unknown>
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO activity_events
         (id, project_id, actor_type, actor_id, event_type, summary, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId('evt'),
      event.projectId,
      event.actorType,
      event.actorId,
      event.eventType,
      event.summary,
      JSON.stringify(event.metadata ?? {}),
      nowIso(),
    )
    .run()
}

/** Ownership is always resolved from the signed-in subject, never from input. */
export async function findProject(
  db: D1Database,
  projectId: string,
  ownerId: string,
): Promise<ProjectRow | null> {
  const row = await db
    .prepare('SELECT * FROM projects WHERE id = ? AND owner_id = ?')
    .bind(projectId, ownerId)
    .first<ProjectRow>()
  return row ?? null
}

export async function findEpisode(
  db: D1Database,
  episodeId: string,
  ownerId: string,
): Promise<EpisodeRow | null> {
  const row = await db
    .prepare(
      `SELECT e.* FROM episodes e
       JOIN projects p ON p.id = e.project_id
       WHERE e.id = ? AND p.owner_id = ?`,
    )
    .bind(episodeId, ownerId)
    .first<EpisodeRow>()
  return row ?? null
}

export async function findCharacter(
  db: D1Database,
  characterId: string,
  ownerId: string,
): Promise<CharacterRow | null> {
  const row = await db
    .prepare(
      `SELECT ch.* FROM characters ch
       JOIN projects p ON p.id = ch.project_id
       WHERE ch.id = ? AND p.owner_id = ?`,
    )
    .bind(characterId, ownerId)
    .first<CharacterRow>()
  return row ?? null
}

export async function nextEpisodeNumber(db: D1Database, projectId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(MAX(episode_number), 0) AS max_number FROM episodes WHERE project_id = ?')
    .bind(projectId)
    .first<{ max_number: number }>()
  return (row?.max_number ?? 0) + 1
}
