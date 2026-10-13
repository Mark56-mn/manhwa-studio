# Manhwa Studio

A web studio for turning original stories into publishable manhwa video episodes.
This repository currently contains **Phase A — the online foundation**: a real,
deployed, single-user studio with authentication, persistent projects, seasons,
episodes, characters, a story bible, and an honest production-history feed.

Nothing in this build fakes AI work. Script, art, voice, video and YouTube
capabilities are listed in the app as *not configured*, because no provider is
connected yet — see "What is not built yet".

## What works today

| Area | Status |
| --- | --- |
| Sign in with Freebuff (Google/GitHub/Apple) | Working, protected on the server |
| Projects: create, list, open, edit, delete | Working, stored in D1 |
| Seasons, episodes, characters per project | Working |
| Story bible (logline, synopsis, genre, tone, continuity) | Working |
| Episode production stages (planned → approved → published) | Manual status, real states |
| Production history / activity feed | Working, records real actions |
| Health & readiness endpoint `/api/health` | Working, queries the database |
| Integration status per capability | Honest: reports "not configured" |
| One-shot database initialization (`POST /api/bootstrap`) | Working, guarded |
| AI script / image / voice / video workers | **Not built (Phase B/C)** |
| YouTube publishing | **Not built (Phase D)** |

## Architecture (and why)

One deployable: a Cloudflare Worker (Hono) that serves the JSON API and the
built React single-page app, backed by a D1 SQLite database.

- **One origin** means no CORS, no cross-site cookie problems, and one thing to
  deploy and verify.
- **Sign in with Freebuff** is standard OIDC with a server-side session and
  **no secrets** in this repository.
- **D1** is the persistent project database; migrations live in `migrations/`.
- **Providers stay behind adapters.** No AI provider is hard-coded. Capability
  configuration is read from environment variables (names in `.env.example`)
  and reported honestly by `/api/integrations`.

The master instructions suggested Vercel + Render + Supabase. That stack needs
three accounts and secrets before anything is online, and it was not available
in this build environment. Cloudflare Workers + D1 + Freebuff auth is the
smallest stack that could actually be deployed and verified here; it is
documented in `docs/MASTER_BLUEPRINT.md` together with how to move later if
you want a different host.

## Layout

```
worker/           Worker API: Hono app, routes, D1 access, capabilities
  index.ts        entrypoint, wraps everything in @freebuff/auth
  app.ts          middleware (CSRF + auth), error handling, SPA fallback
  routes/         health, account, overview, projects, episodes, seasons,
                  characters, activity, integrations
migrations/       SQL migrations (apply in order)
src/              React studio (pages, components, api client)
test/             vitest specs running inside workerd against a real D1
scripts/          worker bundle step for deployment
docs/ tasks/ handoffs/  plans, task files and handoff records
```

## Local development

```sh
npm install
npm run db:migrate:local      # apply migrations to the local D1 database
npm run dev:worker            # API + built assets on http://localhost:8787
npm run build:web             # build the SPA into ./dist (needed by the Worker)
npm run dev                   # optional: Vite on :3000 proxying /api to :8787
```

`npm run dev:worker` serves the built `./dist` assets, so run `npm run build:web`
first (or `npm run build`). The local Worker uses the **development** Freebuff
client id from `wrangler.jsonc`, which accepts `http://localhost:8787`.

Checks:

```sh
npm run typecheck    # tsc for the app and the worker
npm run lint         # eslint
npm run test         # vitest inside workerd, real D1
npm run build        # SPA + single-file Worker bundle
npm run verify       # all of the above
```

## Configuration

| Variable | Purpose | Where to set it |
| --- | --- | --- |
| `FREEBUFF_CLIENT_ID` | Public OIDC client id | Injected by the site deployment; dev value in `wrangler.jsonc` |
| `FREEBUFF_ISSUER` | OIDC issuer (`https://freebuff.com/oidc`) | same |
| `APP_ORIGIN` | Canonical site origin, used for callbacks and CSRF | same |
| `APP_VERSION` | Shown by `/api/health` | same |
| `SCRIPT_PROVIDER`, `SCRIPT_API_KEY`, `SCRIPT_MODEL`, `SCRIPT_BASE_URL`, `SCRIPT_MAX_OUTPUT_TOKENS` | **Script AI (implemented, Phase B)** | Set as deployment secrets to enable script generation |
| `IMAGE_*`, `VOICE_*`, `RENDER_*`, `YOUTUBE_*` | Later phases — no adapter in this build | Not read; the studio reports them honestly as not built |

There are **no secrets in this repository**, and there is no client secret for
sign-in. Provider API keys, when they exist, go into the deployment's secret
store (never into the repo, never into the browser).

### Enabling Script AI (Phase B)

1. Pick a provider and set its variables as **deployment secrets**
   (Sites → Secrets, or `wrangler secret put` when deploying with wrangler):

   | Provider | `SCRIPT_PROVIDER` | Key variable |
   | --- | --- | --- |
   | OpenAI | `openai` | `SCRIPT_API_KEY` or `OPENAI_API_KEY` |
   | OpenRouter | `openrouter` | `SCRIPT_API_KEY` or `OPENROUTER_API_KEY` |
   | Anthropic | `anthropic` | `SCRIPT_API_KEY` or `ANTHROPIC_API_KEY` |
   | Google Gemini | `google` | `SCRIPT_API_KEY` or `GOOGLE_API_KEY` |
   | Any OpenAI-compatible endpoint | `custom` | `SCRIPT_API_KEY` + `SCRIPT_BASE_URL` |

2. Optionally set `SCRIPT_MODEL`. If it is omitted the provider's default model
   is used. If it is set to a model the credential cannot use, verification
   reports a failure instead of silently using something else.
3. Open **Settings → Integrations** and press **Verify Script AI now**. This
   makes a real authenticated call to the provider and records the result;
   only then does the capability become `connected_verified`.
4. Open an episode and press **Generate script**. Each generation stores a new
   immutable version. Approving one appends a decision — it never rewrites the
   script.

No key is needed for the studio to run: without one, script generation reports
exactly which variable names are missing, and everything else keeps working.

## Deploying

This project is deployed from the workspace as a prebuilt Worker plus static
assets:

1. `npm run build` — produces `dist/` (SPA) and `dist-worker/index.js` (one
   bundled Worker module).
2. Deploy using `deploy.manifest.json`, which points `entrypoint` at the
   bundled worker and `assetsDirectory` at `./dist` with SPA fallback.
3. The deployment injects `FREEBUFF_CLIENT_ID`, `FREEBUFF_ISSUER` and
   `APP_ORIGIN`; the auth callback registered for the site must be
   `<site origin>/auth/freebuff/callback`. Preview and production have separate
   databases and separate callbacks.
4. **Initialize the database once.** A fresh database is empty, so the first
   visit shows an "Initialize the studio database" screen — press the button,
   or call the endpoint directly:

   ```sh
   curl -X POST https://<site-origin>/api/bootstrap -H "Origin: https://<site-origin>"
   ```

   It creates the studio tables from the same migrations in `migrations/`,
   records them in `d1_migrations`, is safe to run twice, and refuses to touch a
   database that already has part of the schema. If you have wrangler access to
   the deployed database you can use `npm run db:migrate:remote` instead.

`/api/health` reports `status: ready` once the schema exists and the built
shell is served; otherwise it reports `degraded` and names exactly what is
missing. Open it any time to see the real state of the deployment.

## What is not built yet

Phase A deliberately stops short of AI production. Phase B (real script, image
and voice generation), Phase C (durable jobs, retries, render worker) and
Phase D (YouTube upload with explicit approval) are described in
`tasks/ROADMAP.md`. The next task file is listed there and in
`AGENT_HANDOFF.md`.
