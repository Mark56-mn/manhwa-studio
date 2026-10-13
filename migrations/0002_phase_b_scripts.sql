-- Manhwa Studio Phase B: provider-backed script generation.
--
-- Every statement is idempotent (IF NOT EXISTS) so this migration can be
-- applied by `wrangler d1 migrations apply` *or* by the deployed studio's
-- own "apply pending migrations" endpoint (see worker/migrations.ts).
--
-- Two rules from docs/MASTER_BLUEPRINT.md are encoded here:
--   * approved scripts are never overwritten in place — a new script is a new
--     row in script_versions with a higher version number;
--   * completion is not claimed without an artifact — a script row always
--     carries its provider, model, prompt and raw output, and records
--     honestly when the model's output could not be parsed.

-- Results of real, authenticated provider calls. One row per capability and
-- provider, overwritten only by a newer real check.
CREATE TABLE IF NOT EXISTS provider_checks (
  id            TEXT PRIMARY KEY,
  capability    TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT,
  status        TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
  detail        TEXT NOT NULL,
  latency_ms    INTEGER,
  models_json   TEXT NOT NULL DEFAULT '[]',
  checked_by    TEXT,
  checked_at    TEXT NOT NULL,
  UNIQUE (capability, provider)
);

-- An immutable script artifact. Rows are only ever inserted, never updated in
-- place except for the status column.
CREATE TABLE IF NOT EXISTS script_versions (
  id               TEXT PRIMARY KEY,
  episode_id       TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version          INTEGER NOT NULL CHECK (version > 0),
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'approved', 'rejected')),
  provider         TEXT NOT NULL,
  model            TEXT NOT NULL,
  instructions     TEXT NOT NULL DEFAULT '',
  prompt_json      TEXT NOT NULL DEFAULT '{}',
  raw_text         TEXT NOT NULL,
  structured_json  TEXT,
  parse_state      TEXT NOT NULL DEFAULT 'parsed' CHECK (parse_state IN ('parsed', 'unparsed')),
  parse_detail     TEXT,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  UNIQUE (episode_id, version)
);
CREATE INDEX IF NOT EXISTS idx_script_versions_episode ON script_versions (episode_id, version DESC);

-- Review decisions. Append-only: approving or rejecting never edits the script.
CREATE TABLE IF NOT EXISTS script_approvals (
  id           TEXT PRIMARY KEY,
  script_id    TEXT NOT NULL REFERENCES script_versions(id) ON DELETE CASCADE,
  episode_id   TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  decision     TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'changes_requested')),
  note         TEXT NOT NULL DEFAULT '',
  decided_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_script_approvals_script ON script_approvals (script_id, created_at DESC);

-- Scene breakdown of a parsed script, in order. Image and voice work in later
-- tasks read these rows; they are created only from a real parsed script.
CREATE TABLE IF NOT EXISTS scenes (
  id            TEXT PRIMARY KEY,
  episode_id    TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  script_id     TEXT NOT NULL REFERENCES script_versions(id) ON DELETE CASCADE,
  scene_index   INTEGER NOT NULL CHECK (scene_index > 0),
  heading       TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  narration     TEXT NOT NULL DEFAULT '',
  dialogue_json TEXT NOT NULL DEFAULT '[]',
  image_prompt  TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  UNIQUE (script_id, scene_index)
);
CREATE INDEX IF NOT EXISTS idx_scenes_episode ON scenes (episode_id, scene_index);
