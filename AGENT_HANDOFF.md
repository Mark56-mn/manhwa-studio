# AGENT HANDOFF

**Current state:** Phase A (online foundation) and Phase B TASK-002 are complete
and deployed to the preview environment. **TASK-003 (unified AI provider adapter
+ autonomous task router) is implemented and verified by automated tests and the
local HTTP suite, but was not deployed from this environment and made no live
provider call (no keys exist here).** Task:
`tasks/TASK-003-ai-provider-router.md`. Full record:
`handoffs/HANDOFF-003-ai-provider-router.md`.

## What exists right now

- One deployable Worker (`worker/`) serving `/api/*`, `/auth/freebuff/*` and the
  built SPA; D1 database `DB`; preview site
  `6f0c1d2a-3b4e-4c5d-8a91-7e2f4b6c8d01`.
- Sign in with Freebuff (no secrets), server-enforced authorization, same-origin
  enforcement on state changes, `private, no-store` on personalized responses.
- Projects, seasons, episodes, characters, story bible, activity history.
- **TASK-002:** immutable `script_versions` per episode, parsed `scenes`,
  append-only `script_approvals`, episode workspace.
- **TASK-003:** one unified AI adapter interface (OpenRouter, NVIDIA NIM, Google
  Gemini via the official API, Baseten, OpenAI, Anthropic, custom) and a central
  **AI task router** every workflow calls. Automatic failover, circuit
  breakers/cooldowns, bounded retries, a bounded repair for malformed structured
  output, and **free-budget protection** (free-only by default; a paid fallback
  requires explicit authorisation). Director AI plans episodes; Script AI writes
  versioned scripts. Per-role Director/Script settings, real connection tests,
  model discovery, zero-cost marking, capability probes and a router status view
  live in Settings → Integrations → **AI providers**.
- `POST /api/bootstrap` applies **pending** migrations; migration `0003_ai_router.sql`
  adds `ai_settings`, `ai_model_catalog`, `ai_provider_state`, `ai_route_events`
  and `director_plans`.
- `/api/health` (real checks) and `/api/integrations` (states from real
  configuration and real calls).

## Verified (commands, not claims)

```
npm run typecheck     OK (app + worker)
npm run lint          OK (0 problems)
npm run test          100 passed / 8 skipped (live) across 8 files
npm run build         OK (dist/ + dist-worker/index.js 289.1 kB)
npm run verify:local  66 passed / 0 failed (fresh D1, built Worker in workerd)
```

`npm run verify:deployed` was **not** run: the deployed database has not had
`0003_ai_router.sql` applied and this environment did not redeploy.

## Not verified (needs a browser or a key — owner action)

- **A real provider call with a real key.** No `OPENROUTER_API_KEY`,
  `NVIDIA_API_KEY`, `GEMINI_API_KEY` or `BASETEN_API_KEY` is configured, so the
  live specs are skipped (never faked) and no live model id was confirmed.
- A browser sign-in → callback → session → sign-out, and Android rendering of the
  new Settings panel and Director AI card.
- `POST /api/bootstrap` applying `0003_ai_router.sql` on the deployed database.

## Next action for the next agent

1. Read `docs/MASTER_BLUEPRINT.md`, `tasks/ROADMAP.md` and
   `handoffs/HANDOFF-003-ai-provider-router.md`.
2. Write `tasks/TASK-004-object-storage.md` (Phase B continues): provision R2,
   add the `assets` table, store and read real objects through the binding, and
   keep the media-storage capability honest.
3. Implement, verify with the same evidence standard (tests + `verify:local` +
   `verify:deployed`), then write `handoffs/HANDOFF-004-*.md`, update
   `tasks/ROADMAP.md` and this file, and push.

To enable the AI providers, set their keys as deployment secrets, apply the
pending migration, then test and discover models in Settings → AI providers. Do
not re-plan Phase A, do not rewrite the architecture, and do not publish the
production environment without explicit owner authorisation.
