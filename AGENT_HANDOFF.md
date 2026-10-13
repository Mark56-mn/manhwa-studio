# AGENT HANDOFF

**Current state:** Phase A (online foundation) complete and deployed to the
preview environment. Task: `tasks/TASK-001-online-foundation.md`.
Full record: `handoffs/HANDOFF-001-online-foundation.md`.

## What exists right now

- One deployable Worker (`worker/`) serving `/api/*`, `/auth/freebuff/*` and the
  built SPA; D1 database `DB`; Sites preview site
  `6f0c1d2a-3b4e-4c5d-8a91-7e2f4b6c8d01`.
- Sign in with Freebuff (no secrets), server-enforced authorization, same-origin
  enforcement on state changes, `private, no-store` on personalized responses.
- Projects, seasons, episodes, characters, story bible, activity history.
- `/api/health` (real checks, readiness) and `/api/integrations` (honest
  capability states) and `POST /api/bootstrap` (one-shot schema creation).
- 27 vitest specs passing inside workerd against a real D1.
- `npm run verify` = typecheck + lint + test + build.

## Verified (commands, not claims)

```
npm run typecheck   OK
npm run lint        OK (0 problems)
npm run test        27 passed / 27
npm run build       dist/ + dist-worker/index.js (155.6 kB)
local HTTP checks   25 passed / 0 failed   (built Worker in workerd)
deployed HTTP checks 23 passed / 0 failed  (preview origin)
```

## Not verified (needs a browser — owner action)

Browser sign-in → callback → session → sign-out on the deployed preview, and
Android rendering. Report these as pending, never as passing.

## Next action for the next agent

1. Read `docs/MASTER_BLUEPRINT.md` and `tasks/ROADMAP.md`.
2. Write `tasks/TASK-002-provider-and-script.md` (Phase B start): choose one
   script provider, implement it behind the `SCRIPT_*` adapter with the key as
   a deployment secret, persist versioned scripts with an approval record, and
   keep `/api/integrations` honest.
3. Implement, verify with the same evidence standard, then write
   `handoffs/HANDOFF-002-*.md`, update `tasks/ROADMAP.md` and this file.

Do not re-plan Phase A, do not rewrite the architecture, and do not publish the
production environment without explicit owner authorisation.
