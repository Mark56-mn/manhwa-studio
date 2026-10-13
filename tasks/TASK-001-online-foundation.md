# TASK-001 — Deliver the online foundation (Phase A)

Status: **complete** · Owner-visible result: a live, sign-in-protected studio
with persistent projects and episodes.

## 1. Objective

Put a real web application online for the owner: responsive studio, working
authentication, persistent projects/seasons/episodes, a truthful health and
integration status surface, and a deployment the owner can open from an Android
phone. No fake AI pipeline.

## 2. Verified repository state at the start

- Empty repository (only git metadata); no application, backend, database,
  migrations or deployment configuration.
- The Ostra Studio application was explicitly out of scope and was not read,
  imported or depended on.
- Runtime available: Node 24, npm 11, network access to the npm registry.
- Managed hosting available with D1 SQL and OIDC sign-in; no Vercel/Render/
  Supabase account was connected.

## 3. User-facing outcome

The owner signs in once, creates a story project, records its story bible and
cast, adds episodes with production stages, and sees a production history of
what really happened. Capability settings state plainly that no AI provider is
connected yet.

## 4. Files and components

- `worker/index.ts` — entrypoint; wraps the app in `@freebuff/auth`.
- `worker/app.ts` — CSRF + auth middleware, JSON errors, SPA asset fallback.
- `worker/routes/*` — health, account, overview, projects, episodes, seasons,
  characters, activity, integrations.
- `worker/db.ts`, `worker/lib/*` — D1 access, validation, ids, serialization.
- `worker/capabilities.ts` — honest capability/state reporting.
- `migrations/0001_init.sql` — users, projects, seasons, episodes, characters,
  activity_events.
- `src/**` — React studio (dashboard, projects, project detail with episodes /
  story bible / cast / history, settings & integrations).
- `test/*.spec.ts` — integration specs inside workerd against a real D1.
- `wrangler.jsonc`, `scripts/build-worker.mjs`, `vitest.config.ts`, README.

## 5. Required implementation

1. Hono Worker API with per-user ownership resolved only from the session.
2. Same-origin enforcement for all state-changing requests.
3. D1 schema + migration with documented apply commands.
4. React studio UI: loading, empty, success and failure states; usable on small
   screens.
5. `/api/health` performing real checks (database query, asset fetch, auth
   configuration) and reporting `ready`/`degraded`.
6. `/api/integrations` reporting per-capability state from real configuration,
   never a hard-coded "connected".
7. Deployment as a prebuilt Worker plus static assets, with auth callback
   registered for the site origin.
8. Guarded one-shot schema creation for a fresh deployed database
   (`POST /api/bootstrap`, same-origin, idempotent, atomic, refuses partial
   schemas) so the deployment can be initialized without wrangler access.

## 6. Non-goals

- No script/image/voice/video generation, no provider integration, no YouTube.
- No job queue, no director agent, no asset storage (Phase B/C).
- No admin dashboards, no multi-user collaboration, no billing.

## 7. Acceptance criteria

1. Application builds successfully. ✅ `npm run build`
2. Linting and type checks pass. ✅ `npm run lint`, `npm run typecheck`
3. Automated tests cover the critical project and API paths. ✅ 22 vitest specs
   in workerd against real D1: auth 401s, ownership isolation, validation,
   CSRF, health readiness, sign-in redirect parameters.
4. Database migrations are documented and valid. ✅ `migrations/0001_init.sql`
   applies cleanly (`npm run db:migrate:local`) and is applied by the test setup.
5. No secrets are committed. ✅ Only public configuration is present; no key,
   token or password appears in the repository.
6. The UI does not rely on hard-coded fake projects. ✅ Every list and count
   comes from the API/D1. ✅ Fresh-database initialization is verified end to
   end in workerd and on the deployed preview (503 → initialize → 200 ready).
7. The health endpoint reports actual application readiness. ✅ Queries D1,
   fetches the built shell, reports migration state; returns 503 when degraded.
8. Repository contains task, handoff, roadmap and next-step instructions. ✅
9. Frontend and backend deployment steps documented. ✅ `README.md`.
10. Every unverified deployment or integration is clearly identified. ✅
    `handoffs/HANDOFF-001-online-foundation.md`.

## 8. Commands and tests to run

```sh
npm ci                 # or npm install
npm run typecheck
npm run lint
npm run test
npm run build
npm run db:migrate:local
npm run dev:worker     # then exercise the HTTP checks in the handoff
```

## 9. Deployment and environment dependencies

- Managed hosting with a D1 database binding `DB` and a static assets binding
  `ASSETS`.
- Sign-in configuration for the deployed origin
  (`<origin>/auth/freebuff/callback`) plus a development client for
  `http://localhost:8787`.
- No provider credential, no payment method, no GPU worker needed for this task.

## 10. Risks and fallback decisions

- **Host not available:** the API is plain `fetch` + SQL; moving it to Node/Bun
  or another host would need the D1 layer replaced (isolated in `worker/db.ts`)
  and the auth wrapper re-mounted. Recorded rather than pre-built.
- **SQLite instead of Postgres:** accepted for a single-owner studio. Media
  binaries never go into D1 (Phase B uses object storage).
- **Sign-in cannot be completed headlessly:** the full browser sign-in →
  callback → session → sign-out loop is verified by the owner on the deployed
  origin; everything up to and including the redirect and all signed-out 401s
  is verified automatically.
