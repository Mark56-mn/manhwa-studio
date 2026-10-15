-- Manhwa Studio Phase B: object storage for generated media assets.
--
-- Every statement is idempotent (IF NOT EXISTS) so this migration can be
-- applied by `wrangler d1 migrations apply` *or* by the deployed studio's
-- own "apply pending migrations" endpoint (see worker/migrations.ts).
--
-- Assets are metadata rows in D1; the actual binaries live in R2. This keeps
-- D1 small and fast. The storage_key column is the R2 object key.

CREATE TABLE IF NOT EXISTS assets (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id       TEXT REFERENCES episodes(id) ON DELETE CASCADE,
  type             TEXT NOT NULL CHECK (type IN ('image', 'audio', 'video', 'script', 'other')),
  storage_key      TEXT NOT NULL UNIQUE,
  content_type     TEXT NOT NULL DEFAULT 'application/octet-stream',
  content_length   INTEGER NOT NULL CHECK (content_length >= 0),
  checksum         TEXT NOT NULL,
  metadata_json    TEXT NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploading', 'uploaded', 'failed', 'deleted')),
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_project ON assets (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_storage_key ON assets (storage_key);
CREATE INDEX IF NOT EXISTS idx_assets_episode ON assets (episode_id, created_at DESC);
