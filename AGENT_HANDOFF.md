# AGENT HANDOFF

**Current state:** Phase A (online foundation), Phase B TASK-002 (script
generation) and TASK-003 (unified AI provider adapter + task router) are complete;
TASK-002/003 are deployed to the preview environment. **TASK-004 (object storage +
assets) is implemented and verified by automated tests (a real R2 round-trip) and
the local HTTP suite, but was not deployed from this environment.** Task:
`tasks/TASK-004-object-storage.md`. Full record:
`handoffs/HANDOFF-004-object-storage.md`.

## What exists right now

- One deployable Worker (`worker/`) serving `/api/*`, `/auth/freebuff/*` and the
  built SPA; D1 database `DB`; R2 bucket bound as `FILES`; preview site
  `6f0c1d2a-3b4e-4c5d-8a91-7e2f4b6c8d01`.
- Sign in with Freebuff (no secrets), server-enforced authorization, same-origin
  enforcement on state changes, `private, no-store` on personalized responses.
- Projects, seasons, episodes, characters, story bible, activity history.
- **TASK-002:** immutable `script_versions`, parsed `scenes`, append-only
  `script_approvals`, episode workspace.
- **TASK-003:** one unified AI adapter interface (OpenRouter, NVIDIA NIM, Google
  Gemini, Baseten, OpenAI, Anthropic, custom) behind a central AI task router with
  automatic failover, circuit breakers, bounded retries and free-budget
  protection; per-role Director/Script settings, connection tests, model
  discovery, capability probes and a router status view in Settings.
- **TASK-004:** real object storage. `assets` holds metadata only (never bytes);
  upload/list/open/delete through the `FILES` R2 binding; an **Assets** tab on a
  project. Media storage is `not_configured` without a bucket,
  `configured_unverified` when one is attached, and `connected_verified` only
  after `POST /api/storage/verify` performs a real put/read/delete round-trip.
- `POST /api/bootstrap` applies **pending** migrations; migrations are
  `0001_init`, `0002_phase_b_scripts`, `0003_ai_router`, `0004_assets`.
- `/api/health` (real checks) and `/api/integrations` (states from real
  configuration and real calls).

## Verified (commands, not claims)

```
npm run typecheck     OK (app + worker)
npm run lint          OK (0 problems)
npm run test          111 passed / 8 skipped (live) across 9 files
npm run build         OK (dist/ + dist-worker/index.js 305.4 kB)
npm run verify:local  76 passed / 0 failed (fresh D1, built Worker in workerd)
```

`npm run verify:deployed` was **not** run: the deployed database has not had
`0004_assets.sql` applied, the site does not yet expose the `FILES` R2 binding,
and this environment did not redeploy.

## Not verified (needs a browser, a bucket or a key — owner action)

- **A real provider call with a real key** (unchanged: no `OPENROUTER_API_KEY`,
  `NVIDIA_API_KEY`, `GEMINI_API_KEY` or `BASETEN_API_KEY` here).
- **Object storage on a real deployment**: provision an R2 bucket, expose it as
  `FILES`, then upload through the Assets tab and run the storage check.
- A browser sign-in round trip and Android rendering of the new Assets tab.

## Next action for the next agent

1. Read `docs/MASTER_BLUEPRINT.md`, `tasks/ROADMAP.md` and
   `handoffs/HANDOFF-004-object-storage.md`.
2. Write `tasks/TASK-005-image-generation.md` (Phase B continues): an image
   adapter behind the TASK-003 provider interface, configured (never hard-coded),
   with a real connection test and honest capability reporting; generate scene art
   from `scenes.image_prompt` plus story-bible continuity, and store the real file
   through the TASK-004 asset path, recording provider/model/dimensions.
3. Implement, verify with the same evidence standard (tests + `verify:local` +
   `verify:deployed`), then write `handoffs/HANDOFF-005-*.md`, update
   `tasks/ROADMAP.md` and this file, and push.

Do not re-plan Phase A, do not rewrite the architecture, and do not publish the
production environment without explicit owner authorisation.
