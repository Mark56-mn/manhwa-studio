# HANDOFF-001 — Online foundation (Phase A)

Date: 2026-10-13 · Task: [`tasks/TASK-001-online-foundation.md`](../tasks/TASK-001-online-foundation.md)
Status: **complete and deployed to a preview environment**

## Outcome

Manhwa Studio is online as one deployable: a Cloudflare Worker (Hono) serving a
JSON API plus the built React studio, backed by D1. The owner can sign in with
Freebuff, create projects, keep a story bible, add seasons/episodes/characters,
move episodes through production stages, and read a production history that
only contains real recorded actions. Nothing claims an AI capability that does
not exist.

## Files changed (all new — this repository started empty)

- `worker/`: `index.ts`, `app.ts`, `env.ts`, `db.ts`, `capabilities.ts`,
  `migrations.ts`, `sql.d.ts`, `lib/{constants,errors,ids,input,rows,time}.ts`,
  `routes/{health,bootstrap,account,overview,projects,episodes,seasons,characters,activity,integrations}.ts`
- `migrations/0001_init.sql` (users, projects, seasons, episodes, characters,
  activity_events; idempotent statements)
- `src/`: `main.tsx`, `App.tsx`, `styles.css`, `lib/{api,router,format,useResource}.ts`,
  `components/{Shell,ui}.tsx`, `pages/{Dashboard,Projects,ProjectDetail,Integrations,Bootstrap}.tsx`
- `test/`: `setup.ts`, `env.d.ts`, `helpers.ts`, `projects.spec.ts`,
  `worker.spec.ts`, `bootstrap.spec.ts`
- Tooling: `wrangler.jsonc`, `deploy.manifest.json`, `scripts/build-worker.mjs`,
  `vite.config.ts`, `vite.sql-plugin.ts`, `vitest.config.ts`, `eslint.config.js`,
  `tsconfig*.json`, `package.json`, `.env.example`, `.gitignore`
- Docs: `README.md`, `docs/MASTER_BLUEPRINT.md`, `tasks/*`, `handoffs/*`,
  `AGENT_HANDOFF.md`

## Decisions taken

1. **One Worker + D1 + Sign in with Freebuff** instead of Vercel + Render +
   Supabase: the preferred hosts were not connected in this environment, and
   three accounts plus secrets would have blocked "online today". Recorded with
   trade-offs in `docs/MASTER_BLUEPRINT.md`.
2. **No AI provider selected yet.** Capabilities are reported as
   `not_configured`; provider choice is TASK-002 rather than a guess now.
3. **Server-side database bootstrap** (`POST /api/bootstrap`) because the
   deployed D1 cannot be reached with the wrangler CLI from this environment.
   It is narrow: same-origin POST, idempotent statements, atomic batch, and it
   refuses to touch a partially present schema. Migrations remain the source of
   truth and are bundled into the Worker at build time.
4. **Strict CSP-friendly cookie auth** from the SDK; no custom sessions, no
   password storage, no client secret anywhere.
5. **React 19 + Vite 8 + TypeScript 5.9** (TypeScript 7 was rejected because
   `typescript-eslint` supports `<6.1.0`).

## Commands actually run and their results

| Command | Result |
| --- | --- |
| `npm install` | 234 packages installed; lockfile committed |
| `npm run typecheck` | passes (app + worker, TS strict) |
| `npm run lint` | passes, 0 problems (eslint 10 + typescript-eslint) |
| `npm run test` | **27 passed / 27**, 3 files, inside workerd with a real D1 |
| `npm run build` | SPA `dist/` (248 kB js / 76 kB gz) + `dist-worker/index.js` (155.6 kB) |
| `npm run db:migrate:local` | `0001_init.sql` applied locally |
| fresh-DB bootstrap over HTTP (wrangler dev) | health 503 → `POST /api/bootstrap` 200 `initialized` → health 200 `ready` |
| `/tmp/verify.sh` (local, built Worker in workerd) | **25 passed / 0 failed** |
| `/tmp/verify_deployed.sh` (deployed preview origin) | **23 passed / 0 failed** |

Test coverage highlights: 401 on every private route, per-owner data isolation
(other account gets 404 on read/update/delete and an empty list), input
validation and unknown-field rejection, CSRF 403 for a foreign `Origin`,
`private, no-store` on personalized responses, health readiness from a real
query, sign-in redirect parameters (client id, exact callback, PKCE, state,
nonce), callback without parameters rejected, sign-out from a foreign origin
rejected, and the full bootstrap lifecycle.

## Passed

- Application builds; type checks and lint pass.
- Database migration valid, applied locally and to the deployed preview.
- API + authorization + CSRF + validation + health specs pass (27/27).
- Deployed preview serves the SPA, assets, and API on the real origin.
- Signed-out behaviour verified on the deployed origin: 401s, no-store,
  session `null`, sign-in redirect to the issuer with the production client id
  and the exact deployed callback, cross-origin mutation 403.

## Not tested (requires a browser, pending owner verification)

- Completing a real sign-in → callback → session → sign-out **in a browser**.
  There is no browser automation in this environment. Everything up to and
  including the redirect is verified; the round trip itself needs one click by
  the owner on the deployed preview URL.
- Two-account isolation in a browser (the equivalent isolation is covered by
  automated tests with two identities).
- Rendering on an actual Android device.

## Blocked / required from the owner

- Nothing is blocking Phase A. Later phases need decisions and possibly money
  (see `tasks/ROADMAP.md`): which script/image/voice providers to use, and
  whether to add object storage (R2, free tier) in Phase B.

## Live deployment

- Preview: `https://site-fa13ddd475e047ffb22b1a17dfc984c9.freebuff.page`
  (Sites site id `6f0c1d2a-3b4e-4c5d-8a91-7e2f4b6c8d01`, environment `preview`).
- Production environment exists but **has not been deployed or published**;
  publishing production needs explicit owner authorisation.
- The preview database was initialized through `POST /api/bootstrap`; the
  deployment is genuinely exercised, not just uploaded (see the command table).

## Exact next task

**`TASK-002` — provider selection + real script generation (Phase B start).**
Create `tasks/TASK-002-provider-and-script.md` before starting. The next agent
must: (1) recommend and integrate one script provider behind the `SCRIPT_*`
adapter with the owner's key stored as a deployment secret; (2) store
versioned scripts against an episode with an approval record; (3) never
overwrite an approved script in place; (4) report the provider, model and any
failure honestly in `/api/integrations` and the episode view; (5) keep the
existing 27 tests green and add specs for the new paths. Do not start Phase C
or D work before TASK-002's handoff is written.
