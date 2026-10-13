-- Manhwa Studio Phase B: the unified AI provider adapter + task router.
--
-- Every statement is idempotent (IF NOT EXISTS) so this migration can be applied
-- by `wrangler d1 migrations apply` *or* by the deployed studio's own
-- "apply pending migrations" endpoint (see worker/migrations.ts).
--
-- Rules encoded here (docs/MASTER_BLUEPRINT.md):
--   * free use is never assumed: a model's cost policy is stored, not guessed;
--   * a provider/model is "verified" only from a real recorded call;
--   * routing decisions are logged without secrets or story content.

-- Per-owner, per-role preference: Director AI and Script AI choose their own
-- provider/model independently, with an optional ordered fallback list and an
-- explicit paid-use switch (off by default).
CREATE TABLE IF NOT EXISTS ai_settings (
  owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('director', 'script')),
  provider      TEXT,                                    -- preferred provider id
  model         TEXT,                                    -- preferred model id
  fallback_json TEXT NOT NULL DEFAULT '[]',              -- [{provider, model}, ...]
  allow_paid    INTEGER NOT NULL DEFAULT 0 CHECK (allow_paid IN (0, 1)),
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (owner_id, role)
);

-- Models discovered from a provider's own model endpoint. `free` is only
-- 'free' when the provider's own metadata says zero cost; otherwise 'unknown',
-- which the router treats as not eligible unless paid use is authorised.
CREATE TABLE IF NOT EXISTS ai_model_catalog (
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  label             TEXT,
  context_length    INTEGER,
  free              TEXT NOT NULL DEFAULT 'unknown' CHECK (free IN ('free', 'paid', 'unknown')),
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  source            TEXT NOT NULL DEFAULT 'discovery',
  discovered_at     TEXT NOT NULL,
  PRIMARY KEY (provider, model)
);
CREATE INDEX IF NOT EXISTS idx_ai_model_catalog_provider ON ai_model_catalog (provider);

-- Health / circuit breaker per provider+model, and the capabilities a real
-- probe actually confirmed (never a documentation claim).
CREATE TABLE IF NOT EXISTS ai_provider_state (
  provider             TEXT NOT NULL,
  model                TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'ok', 'failed', 'cooldown')),
  capabilities_json    TEXT NOT NULL DEFAULT '{}',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  cooldown_until       TEXT,
  last_ok_at           TEXT,
  last_error_code      TEXT,
  last_error_detail    TEXT,
  latency_ms           INTEGER,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (provider, model)
);

-- Sanitized routing log: which provider/model was tried, why it was skipped,
-- and which one completed the task. No API keys, no story content.
CREATE TABLE IF NOT EXISTS ai_route_events (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT,
  role       TEXT NOT NULL,
  task       TEXT NOT NULL,
  task_id    TEXT,
  attempt    INTEGER NOT NULL DEFAULT 1,
  provider   TEXT NOT NULL,
  model      TEXT,
  outcome    TEXT NOT NULL CHECK (outcome IN ('ok', 'failed', 'skipped', 'blocked')),
  error_code TEXT,
  latency_ms INTEGER,
  detail     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_route_events_created ON ai_route_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_route_events_task ON ai_route_events (task_id);

-- Director AI artifacts. Like script versions, rows are only ever inserted:
-- a new plan is a new version, so an approved plan is never rewritten.
CREATE TABLE IF NOT EXISTS director_plans (
  id            TEXT PRIMARY KEY,
  episode_id    TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL CHECK (version > 0),
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  raw_text      TEXT NOT NULL,
  plan_json     TEXT,
  parse_state   TEXT NOT NULL DEFAULT 'parsed' CHECK (parse_state IN ('parsed', 'unparsed')),
  parse_detail  TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (episode_id, version)
);
CREATE INDEX IF NOT EXISTS idx_director_plans_episode ON director_plans (episode_id, version DESC);
