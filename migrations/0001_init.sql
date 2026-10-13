-- Manhwa Studio: initial schema (Phase A online foundation).
-- Apply with: npm run db:migrate:local  |  npm run db:migrate:remote
-- Every statement is idempotent (IF NOT EXISTS) so the deployed app can also
-- initialize an empty database itself via POST /api/bootstrap.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,            -- Freebuff OIDC subject ("sub")
  email         TEXT,
  display_name  TEXT,
  picture       TEXT,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  logline       TEXT NOT NULL DEFAULT '',
  synopsis      TEXT NOT NULL DEFAULT '',
  genre         TEXT NOT NULL DEFAULT '',
  tone          TEXT NOT NULL DEFAULT '',
  language      TEXT NOT NULL DEFAULT 'en',
  story_bible   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'development'
                CHECK (status IN ('development','in_production','paused','completed')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects (owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS seasons (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  season_number INTEGER NOT NULL CHECK (season_number > 0),
  title         TEXT NOT NULL DEFAULT '',
  summary       TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (project_id, season_number)
);

CREATE TABLE IF NOT EXISTS episodes (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  season_id     TEXT REFERENCES seasons(id) ON DELETE SET NULL,
  episode_number INTEGER NOT NULL CHECK (episode_number > 0),
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'planned'
                CHECK (status IN ('planned','script_drafting','script_review','script_approved',
                                  'art_generating','art_review','audio_generating','video_assembling',
                                  'video_review','approved','published','failed')),
  target_duration_seconds INTEGER CHECK (target_duration_seconds IS NULL OR target_duration_seconds > 0),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (project_id, episode_number)
);
CREATE INDEX IF NOT EXISTS idx_episodes_project ON episodes (project_id, episode_number);

CREATE TABLE IF NOT EXISTS characters (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'supporting'
                CHECK (role IN ('protagonist','antagonist','supporting','minor')),
  description   TEXT NOT NULL DEFAULT '',
  appearance    TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (project_id, name)
);

-- Honest production history: only real system/owner actions are recorded here.
CREATE TABLE IF NOT EXISTS activity_events (
  id            TEXT PRIMARY KEY,
  project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,
  actor_type    TEXT NOT NULL CHECK (actor_type IN ('owner','system','agent')),
  actor_id      TEXT,
  event_type    TEXT NOT NULL,
  summary       TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_project ON activity_events (project_id, created_at DESC);
