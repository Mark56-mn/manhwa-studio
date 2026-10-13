# TASK-002 — Provider adapters + real script generation (Phase B start)

## 1. Objective

Turn the studio's first production stage from a plan into a working vertical
slice: the owner presses **Generate script** on an episode, a real LLM provider
is called with the project's story bible and episode context, the returned
script is validated, parsed into ordered scenes, and stored as an immutable,
versioned artifact that can be approved without ever being overwritten.

Also: make `/api/integrations` report provider state from **real authenticated
calls** rather than from the presence of an environment variable.

## 2. Current verified repository state (before this task)

- Phase A is deployed and verified: Worker (Hono) + React 19 SPA + D1 +
  Sign in with Freebuff. See `handoffs/HANDOFF-001-online-foundation.md`.
- `npm run verify` = typecheck + lint + test + build, all green.
- 27 vitest specs inside workerd against a real D1; 25 local HTTP checks;
  23 deployed-origin HTTP checks.
- No AI provider exists anywhere in the code. `worker/capabilities.ts` reports
  every capability as `not_configured` and says so truthfully.
- No object storage is attached (Phase B/TASK-003 will add R2).
- Schema is `migrations/0001_init.sql`; the deployed preview DB was created by
  `POST /api/bootstrap`, which until now only initialized an *empty* database.

## 3. User-facing outcome

- On an episode: **Generate script**, a version list (v1, v2, …), the parsed
  scene breakdown, and **Approve** / **Request changes** / **Reject**.
- Settings → Integrations: the Script AI capability shows
  `Connected and verified` only after a real call succeeded, with the live
  model list and the check timestamp. Otherwise it says exactly which
  environment-variable names are missing.
- Generating a script never destroys an approved one; approving appends a
  decision record.

## 4. Relevant files and components

New:

- `migrations/0002_phase_b_scripts.sql` — `script_versions`, `script_approvals`,
  `scenes`, `provider_checks`.
- `worker/providers/{types,openaiCompatible,anthropic,google,index}.ts` —
  provider registry and adapters (plain `fetch`, no SDK).
- `worker/scripting/{prompt,parse,service}.ts` — prompt construction, tolerant
  JSON parsing/validation, persistence.
- `worker/routes/scripts.ts` — script + approval routes.
- `src/pages/EpisodeWorkspace.tsx` — the episode production view.

Changed:

- `worker/env.ts`, `worker/capabilities.ts`, `worker/migrations.ts`,
  `worker/app.ts`, `worker/index.ts` (no change expected), `worker/lib/{constants,rows}.ts`,
  `worker/routes/{health,integrations}.ts`, `src/App.tsx`, `src/lib/router.tsx`,
  `src/lib/api.ts`, `src/components/ui.tsx`, `src/pages/{Integrations,ProjectDetail}.tsx`,
  `src/styles.css`, `test/*`, docs.

## 5. Required implementation

1. **Provider adapters behind one interface.** `openai`, `openrouter`,
   `anthropic`, `google` and a `custom` OpenAI-compatible endpoint. Selected by
   `SCRIPT_PROVIDER`; model by `SCRIPT_MODEL`; base URL by `SCRIPT_BASE_URL`
   (custom only). Never hard-code a provider or model in the studio logic.
2. **Real verification.** `POST /api/integrations/:capability/verify` performs a
   genuine authenticated HTTP call to the provider, records the result in
   `provider_checks` and returns it. The capability state is derived from that
   row — never from a hard-coded "connected" flag.
3. **Versioned, immutable scripts.** Each generation inserts a new
   `script_versions` row with `version = max + 1` for the episode together with
   its `scenes`. There is no endpoint that rewrites `raw_text` or
   `structured_json`.
4. **Approvals append, never overwrite.** `script_approvals` is append-only and
   carries the decision, the note and who decided.
5. **Honest failure.** Every provider/parse failure is surfaced with the
   provider's own error message; a script whose output could not be parsed is
   stored as `parse_state = 'unparsed'` with `parse_detail` explaining why, and
   the UI says so instead of showing an empty scene list.
6. **Episode status follows real work.** Generating moves the episode to
   `script_review`; approving moves it to `script_approved`.

## 6. Explicit non-goals

- Image, voice and video providers (TASK-003/004/005). Their capabilities stay
  honest "not implemented / not configured" until then.
- Durable job queue, retries and background workers (Phase C). Script
  generation is a single synchronous provider call in this task.
- R2 object storage (TASK-003).
- Any YouTube work (Phase D).
- Story-bible versioning (Phase E).

## 7. Acceptance criteria

1. `npm run typecheck`, `npm run lint`, `npm run build` all pass.
2. `npm run test` passes, including new specs covering: script generation with
   a stubbed provider, version numbering and immutability, approval append-only
   behaviour, cross-owner isolation, 503 when no provider is configured, and
   provider verification recording a real HTTP result.
3. Deployed preview: `/api/integrations` reports `not_configured` for the
   script capability (no key is set) and never `connected_verified`;
   `POST /api/integrations/script/verify` returns a clear, honest failure
   instead of pretending; the episode page renders and states the missing
   variable names.
4. Existing 27 specs stay green.
5. No secret value is committed, logged or returned to the browser.
6. `POST /api/bootstrap` upgrades an existing Phase-A database to the Phase-B
   schema by applying only the pending migration, and still refuses the
   inconsistent case.

## 8. Commands and tests to run

```
npm run typecheck
npm run lint
npm run test
npm run build
node scripts/verify-local.mjs      # built Worker in workerd (Phase A suite + new checks)
```

## 9. Deployment or environment dependencies

- Provider key(s) must be set as deployment secrets on the Sites project:
  `SCRIPT_PROVIDER`, `SCRIPT_API_KEY`, `SCRIPT_MODEL` (optionally
  `SCRIPT_BASE_URL`). Alternatively a provider-specific `*_API_KEY`
  (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`,
  `OPENROUTER_API_KEY`) is accepted for convenience.
- The owner supplies the credentials; the software must work, and report
  honestly, without them.

## 10. Risks and fallback decisions

- **Model ids change frequently.** Mitigation: the model comes from
  configuration, the live model list is read from the provider's own
  `/models` endpoint during verification, and a configured model that is not
  in that list is reported as a failure rather than silently used.
- **LLMs do not always return valid JSON.** Mitigation: tolerant extraction
  (fence stripping), strict validation, and an honest `unparsed` state that
  still stores the raw text.
- **A provider call can hang.** Mitigation: every request carries
  `AbortSignal.timeout` and the timeout is reported as such.
- **Applying migrations to a live database.** Mitigation: migrations are
  idempotent, applied in one atomic batch, recorded in `d1_migrations`, and the
  endpoint refuses inconsistent states instead of guessing.
