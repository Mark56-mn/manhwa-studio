-- Manhwa Studio Phase B: object storage for generated and uploaded media.
--
-- Every statement is idempotent (IF NOT EXISTS) so this migration can be applied
-- by `wrangler d1 migrations apply` *or* by the deployed studio's own
-- "apply pending migrations" endpoint (see worker/migrations.ts).
--
-- Rule encoded here (docs/MASTER_BLUEPRINT.md): every asset has a persistent
-- record with its project, episode, type, storage location, status and metadata.
-- The bytes live in object storage (R2); this table never holds a binary.

CREATE TABLE IF NOT EXISTS assets (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id    TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('image', 'audio', 'video', 'caption', 'other')),
  name          TEXT NOT NULL DEFAULT '',
  storage_key   TEXT NOT NULL,
  content_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
  byte_size     INTEGER NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
  checksum      TEXT,
  status        TEXT NOT NULL DEFAULT 'stored' CHECK (status IN ('stored', 'failed', 'deleted')),
  provider      TEXT,
  model         TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (storage_key)
);
CREATE INDEX IF NOT EXISTS idx_assets_project ON assets (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_episode ON assets (episode_id, created_at DESC);
