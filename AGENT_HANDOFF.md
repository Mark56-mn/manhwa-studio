# AGENT HANDOFF

**Current state:** Phase A (online foundation) complete and deployed. Phase B has
started: TASK-002 (provider adapters + real, versioned script generation) is
complete, deployed to the preview environment and verified on the real origin.
Task: `tasks/TASK-002-provider-and-script.md`.
Full record: `handoffs/HANDOFF-002-provider-and-script.md`.

## What exists right now

- One deployable Worker (`worker/`) serving `/api/*`, `/auth/freebuff/*` and the
  built SPA; D1 database `DB`; preview site
  `6f0c1d2a-3b4e-4c5d-8a91-7e2f4b6c8d01`.
- Sign in with Freebuff (no secrets), server-enforced authorization, same-origin
  enforcement on state changes, `private, no-store` on personalized responses.
- Projects, seasons, episodes, characters, story bible, activity history.
- **Phase B:** provider adapter registry (`openai`, `openrouter`, `anthropic`,
  `google`, `custom`), real provider verification recorded in `provider_checks`,
  immutable `script_versions` per episode, parsed `scenes`, append-only
  `script_approvals`, and an episode workspace UI to generate and review scripts.
- `POST /api/bootstrap` applies **pending** migrations (it upgraded the deployed
  database to migration 0002 through the app itself).
- `/api/health` (real checks) and `/api/integrations` (states derived from real
  configuration and real calls).
- 40 vitest specs inside workerd against a real D1.
- `npm run verify` = typecheck + lint + test + build;
  `npm run verify:local` = 54 HTTP checks on the built Worker in workerd;
  `npm run verify:deployed <origin>` = 40 checks over real HTTPS.

## Verified (commands, not claims)

```
npm run typecheck     OK
npm run lint          OK (0 problems)
npm run test          40 passed / 40
npm run build         dist/ + dist-worker/index.js (206.4 kB)
npm run verify:local  54 passed / 0 failed   (fresh D1, built Worker in workerd)
npm run verify:deployed 40 passed / 0 failed (preview origin)
POST /api/bootstrap   200 upgraded, applied ["0002_phase_b_scripts.sql"]
```

## Not verified (needs a browser or a key — owner action)

- Browser sign-in → callback → session → sign-out on the deployed preview, and
  Android rendering.
- A real provider call with a real API key: no key is configured, so the Script
  AI capability correctly reads `not_configured`.

## Next action for the next agent

1. Read `docs/MASTER_BLUEPRINT.md` and `tasks/ROADMAP.md`.
2. Write `tasks/TASK-003-object-storage.md` (Phase B continues): provision R2,
   add the `assets` table, store and read real objects through the binding, and
   keep the media-storage capability honest.
3. Implement, verify with the same evidence standard (tests + `verify:local` +
   `verify:deployed`), then write `handoffs/HANDOFF-003-*.md`, update
   `tasks/ROADMAP.md` and this file, and push.

Do not re-plan Phase A, do not rewrite the architecture, and do not publish the
production environment without explicit owner authorisation.
